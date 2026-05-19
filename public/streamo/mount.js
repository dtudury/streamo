/**
 * mount — reactive DOM renderer for h virtual trees
 *
 * Slots are abandoned. The root tree has one watcher; each function-component
 * invocation gets its OWN watcher. Reads inside a component's body register
 * on that component's watcher, not the root's — so when a reactive read
 * mutates, only the components that actually read it re-fire. Siblings and
 * ancestors stay untouched. (Fine-grained watcher boundaries.)
 *
 * The reconcile algorithm is four best-fit passes against the parent's
 * current children: match by data-key, by id, by tag (unkeyed-only), then
 * text positionally. Unmatched old children are removed; unmatched new
 * vnodes get fresh elements. Each kept element is terraformed (attrs reset,
 * children recursively reconciled). Positioning is via insertBefore so
 * focused descendants stay focused across reorder.
 *
 * Function-components must return exactly one HElement (we unwrap an array
 * of one). Inline `() => …` in child position are tiny anonymous components
 * but currently share the parent's watcher (no separate scope) — only named
 * function-components get isolated boundaries. Function-valued attributes
 * are invoked at render time; the enclosing watcher captures the dep.
 */

import { HElement, HText } from './h.js'

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS  = 'http://www.w3.org/2000/svg'

const rootWatchers = new WeakMap() // container → watcher fn

// Per-parent component-instance registries. Keyed by parent element so an
// element removed from the DOM frees its instance map for GC. Inner entries
// are explicitly torn down when their keys are dropped during reconcile (and
// recursively when a subtree is removed). See ComponentInstance below.
const instancesByParent = new WeakMap() // parent → Map<key, ComponentInstance>

export function dismount (root, recaller) {
  const watcher = rootWatchers.get(root)
  if (watcher && recaller) recaller.unwatch(watcher)
  rootWatchers.delete(root)
  // Tear down any component instances rooted under this container.
  cleanupSubtreeInstances(root)
}

export function mount (nodes, container, recaller, ns = HTML_NS) {
  // mount owns the container
  for (const child of [...container.childNodes]) child.remove()

  const render = () => reconcileChildren(container, [nodes].flat(), recaller, ns)

  if (recaller) {
    rootWatchers.set(container, render)
    recaller.watch('mount', render)
  } else {
    render()
  }
}

// ── ComponentInstance ────────────────────────────────────────────────────
//
// One instance per function-component invocation (identified by (parent,
// key) where `key` is the wrapper's data-key, falling back to position).
//
// `watcher` re-runs the component body and tracks reactive reads on its
// own scope. On async re-fire (recaller flush, no parent reconcile on the
// stack) the watcher terraforms its own DOM element in place. On
// parent-triggered re-render the watcher just produces a fresh lastVnode;
// the parent's build pass will terraform.

class ComponentInstance {
  constructor (fn, recaller, name) {
    this.fn = fn
    this.recaller = recaller
    this.name = name
    this.ns = HTML_NS
    this.props = null
    this.wrapperKey = null   // data-key declared on the wrapper invocation
    this.domEl = null        // bound after first build pass
    this.lastVnode = null    // single HElement produced by fn(props)
    this.parentTriggered = false
    this.watcher = () => this.#render()
  }

  #render () {
    const out = this.fn(this.props)
    const arr = Array.isArray(out) ? out : [out]
    const elements = arr.filter(x => x instanceof HElement)
    if (elements.length !== 1) {
      this.lastVnode = null
      return
    }
    this.lastVnode = elements[0]
    // Inherit data-key from the wrapper invocation if the inner element
    // doesn't carry one of its own. Same rule as the legacy inline path —
    // necessary so terraform's touched-attr sweep doesn't strip data-key.
    if (this.wrapperKey != null && staticAttrValue(this.lastVnode, 'data-key') == null) {
      this.lastVnode.attrs = [...this.lastVnode.attrs, { name: 'data-key', value: this.wrapperKey }]
    }
    // Async re-fire path: recaller's flush invoked us with no parent
    // reconcile on the stack. We must terraform our element ourselves —
    // no one else will. On parent-triggered renders the parent's build
    // pass terraforms, so we skip here to avoid double work and competing
    // dep registrations (a second terraform under the parent's watcher
    // frame would re-register the same reads on the parent).
    if (this.domEl && !this.parentTriggered) {
      terraform(this.domEl, this.lastVnode, this.recaller, this.ns)
    }
  }

  teardown () {
    this.recaller.unwatch(this.watcher)
    this.domEl = null
    this.lastVnode = null
  }
}

function getOrCreateInstanceMap (parent) {
  let m = instancesByParent.get(parent)
  if (!m) { m = new Map(); instancesByParent.set(parent, m) }
  return m
}

// Walk a subtree (post-detachment or pre-removal), tearing down any
// component instances rooted under each element. Maps are keyed by the
// element-that-owns-them, so we look up each descendant and clean it.
function cleanupSubtreeInstances (el) {
  if (!el || el.nodeType !== 1) return
  const map = instancesByParent.get(el)
  if (map) {
    for (const inst of map.values()) inst.teardown()
    instancesByParent.delete(el)
  }
  const children = el.childNodes
  if (children) for (const child of children) cleanupSubtreeInstances(child)
}

// ── reconcileChildren ────────────────────────────────────────────────────
//
// The single reconcile operation. Mount is just reconcileChildren against an
// empty old-children set.

function reconcileChildren (parent, vnodes, recaller, ns) {
  // ── Resolve pass ──
  // Flatten arrays. Drop null/false. Invoke inline functions. Function-
  // components are routed through ComponentInstance: each invocation gets
  // (or reuses) its own watcher scope, and we pull `instance.lastVnode`
  // into `resolved` for the downstream match/build pipeline.
  const resolved = []
  const resolvedInstances = []   // parallel array; null for non-component vnodes
  const keptInstanceKeys = new Set()
  // Track the first unkeyed function-component encountered at this parent.
  // A second unkeyed one is a footgun: the position-based fallback key
  // (__pos:N) drifts if upstream shape changes, leading to silent instance
  // churn. Fail loudly instead. Singletons (one unkeyed FC at a parent)
  // stay supported — that's the natural shape for `mount(h\`<${App}/>\`, …)`.
  let unkeyedFn = null
  const resolve = (v) => {
    if (v == null || v === false) return
    if (Array.isArray(v)) { v.forEach(resolve); return }
    if (typeof v === 'function') { resolve(v(parent)); return }
    if (v instanceof HElement && typeof v.tag === 'function') {
      const wrapperKey = staticAttrValue(v, 'data-key')
      if (wrapperKey == null) {
        if (unkeyedFn) {
          const a = unkeyedFn.name || 'anonymous'
          const b = v.tag.name || 'anonymous'
          throw new Error(
            `mount: more than one function-component without data-key at the same parent ` +
            `(${a} and ${b}). Each function-component in a group of siblings needs a unique ` +
            `data-key for stable instance lookup across re-renders. Add data-key="…" to both.`
          )
        }
        unkeyedFn = v.tag
      }
      if (!recaller) {
        // No reactivity in this mount → no watcher to register against,
        // so skip the instance machinery and invoke the component inline.
        // Same shape as the legacy non-isolated path: call fn(props),
        // unwrap to a single HElement, inherit wrapper data-key.
        const inner = v.tag(buildProps(v))
        const arr = Array.isArray(inner) ? inner : [inner]
        const elements = arr.filter(x => x instanceof HElement)
        if (elements.length !== 1) return
        const child = elements[0]
        if (wrapperKey != null && staticAttrValue(child, 'data-key') == null) {
          child.attrs = [...child.attrs, { name: 'data-key', value: wrapperKey }]
        }
        resolved.push(child)
        resolvedInstances.push(null)
        return
      }
      const key = wrapperKey != null ? String(wrapperKey) : `__pos:${resolved.length}`
      const parentMap = getOrCreateInstanceMap(parent)
      let instance = parentMap.get(key)
      if (instance && instance.fn !== v.tag) {
        // Same key now bound to a different component — tear the old one
        // down and let a fresh instance take its place. The old element (if
        // still in the DOM) will get tag-matched or replaced by the rest of
        // the pipeline.
        instance.teardown()
        parentMap.delete(key)
        instance = null
      }
      if (!instance) {
        const name = `comp:${v.tag.name || 'anon'}:${key}`
        instance = new ComponentInstance(v.tag, recaller, name)
        parentMap.set(key, instance)
      }
      instance.wrapperKey = wrapperKey
      instance.ns = ns
      instance.props = buildProps(v)
      // recaller.watch invokes the watcher synchronously inside its own
      // stack frame, so reads inside fn(props) register on instance.watcher
      // (not on whatever outer watcher called reconcileChildren). The
      // parentTriggered flag tells the watcher's terraform path to defer
      // to the parent's upcoming build pass.
      instance.parentTriggered = true
      try { recaller.watch(instance.name, instance.watcher) }
      finally { instance.parentTriggered = false }
      keptInstanceKeys.add(key)
      if (instance.lastVnode) {
        resolved.push(instance.lastVnode)
        resolvedInstances.push(instance)
      }
      return
    }
    resolved.push(v)
    resolvedInstances.push(null)
  }
  vnodes.forEach(resolve)

  // ── Cleanup dropped instances ──
  // Any instance whose key wasn't claimed by this resolve pass is gone —
  // tear down its watcher now. Its DOM element will fall out via the
  // orphan cleanup below (it's not in newChildren, so it stays in
  // oldChildren and gets removed). Nested instances inside that element
  // get cleaned by cleanupSubtreeInstances during orphan removal.
  const existingMap = instancesByParent.get(parent)
  if (existingMap) {
    for (const [key, instance] of existingMap) {
      if (!keptInstanceKeys.has(key)) {
        instance.teardown()
        existingMap.delete(key)
      }
    }
  }

  // ── Three-pass best-fit match ──
  // Each pass uses a precomputed index over oldChildren — O(N) to build, O(1)
  // per lookup. Total reconcile work stays O(N) in the child count rather
  // than the O(N²) of the naive findIndex-per-vnode shape we started with.
  const oldChildren = [...parent.childNodes]
  const newChildren = new Array(resolved.length).fill(null)

  // Build all three indexes in a single oldChildren walk:
  //   keyMap : data-key → idx        (for keyed elements)
  //   idMap  : id       → idx        (for elements with an id)
  //   tagPool: tag      → [idx, …]   (for UNKEYED elements only, in
  //                                    document order so first-claim wins)
  const keyMap = new Map()
  const idMap = new Map()
  const tagPool = new Map()
  for (let j = 0; j < oldChildren.length; j++) {
    const n = oldChildren[j]
    if (!n || n.nodeType !== 1) continue
    const k = n.getAttribute('data-key')
    const id = n.getAttribute('id')
    if (k != null && !keyMap.has(k)) keyMap.set(k, j)
    if (id != null && !idMap.has(id)) idMap.set(id, j)
    // Tag-pool only includes unkeyed elements — keyed elements have
    // identity claims that mustn't be stolen by an unkeyed tag-match.
    if (k == null && id == null) {
      const tag = n.tagName?.toLowerCase()
      if (tag) {
        if (!tagPool.has(tag)) tagPool.set(tag, [])
        tagPool.get(tag).push(j)
      }
    }
  }

  // Pass 1: match HElement vnodes by data-key
  for (let i = 0; i < resolved.length; i++) {
    const v = resolved[i]
    if (!(v instanceof HElement)) continue
    const key = staticAttrValue(v, 'data-key')
    if (key == null) continue
    const k = String(key)
    const idx = keyMap.get(k)
    if (idx != null) {
      newChildren[i] = oldChildren[idx]
      oldChildren[idx] = null
      keyMap.delete(k) // don't re-match the same element
    }
  }

  // Pass 2: match HElement vnodes by id
  for (let i = 0; i < resolved.length; i++) {
    if (newChildren[i]) continue
    const v = resolved[i]
    if (!(v instanceof HElement)) continue
    const id = staticAttrValue(v, 'id')
    if (id == null) continue
    const k = String(id)
    const idx = idMap.get(k)
    if (idx != null) {
      newChildren[i] = oldChildren[idx]
      oldChildren[idx] = null
      idMap.delete(k)
    }
  }

  // Pass 3: match UNKEYED HElement vnodes to UNKEYED elements by tag.
  // Keys (data-key, id) are identity claims; a vnode that declared an
  // identity in pass 1 or 2 and didn't find its match should fresh-mount,
  // not steal a tag-pool element. Symmetrically, an old element with an
  // identity claim isn't in the tag-pool at all (filtered out during
  // index construction above) — its identity is *its*, not "first
  // available tag." Without this separation, `<input data-key="username">`
  // would tag-match `<input data-key="new-todo">` (the login-name-leak
  // symptom David caught).
  for (let i = 0; i < resolved.length; i++) {
    if (newChildren[i]) continue
    const v = resolved[i]
    if (!(v instanceof HElement) || typeof v.tag !== 'string') continue
    if (staticAttrValue(v, 'data-key') != null) continue
    if (staticAttrValue(v, 'id') != null) continue
    const pool = tagPool.get(v.tag.toLowerCase())
    if (pool && pool.length > 0) {
      const idx = pool.shift()
      newChildren[i] = oldChildren[idx]
      oldChildren[idx] = null
    }
  }

  // Pass 4: match text vnodes (HText, strings, numbers) to existing text
  // nodes positionally — claim the Nth still-unclaimed text node in the
  // old children for the Nth text vnode in the new children. Preserves
  // text-node identity across re-renders so a user's text selection that
  // spans a node survives (browser selection anchors at a Node, not a
  // document offset). nodeValue is updated in the build pass below
  // when the text content differs.
  {
    let textCursor = 0
    for (let i = 0; i < resolved.length; i++) {
      if (newChildren[i]) continue
      const v = resolved[i]
      const isText = v instanceof HText || typeof v === 'string' || typeof v === 'number'
      if (!isText) continue
      while (textCursor < oldChildren.length) {
        const n = oldChildren[textCursor]
        if (n && n.nodeType === 3) break // text node
        textCursor++ // skip nulls + non-text nodes
      }
      if (textCursor < oldChildren.length) {
        newChildren[i] = oldChildren[textCursor]
        oldChildren[textCursor] = null
        textCursor++
      }
    }
  }

  // ── Cleanup unmatched old children ──
  // Walk each orphan's subtree first so any component instances rooted in
  // it (at any depth) get their watchers unregistered before the DOM goes.
  for (const child of oldChildren) {
    if (child) {
      cleanupSubtreeInstances(child)
      child.remove()
    }
  }

  // ── Build / terraform ──
  for (let i = 0; i < resolved.length; i++) {
    const v = resolved[i]
    const instance = resolvedInstances[i]
    if (v instanceof HText) {
      if (!newChildren[i]) {
        newChildren[i] = document.createTextNode(v.value)
      } else if (newChildren[i].nodeValue !== v.value) {
        newChildren[i].nodeValue = v.value
      }
    } else if (v instanceof HElement) {
      const fresh = !newChildren[i]
      if (fresh) {
        const elemNs = resolveNs(v, ns)
        newChildren[i] = document.createElementNS(elemNs, v.tag)
      }
      const el = newChildren[i]
      // For component instances, bind the element on first build. The
      // build pass owns terraform on parent-triggered renders (the watcher
      // skipped it via parentTriggered=true so reads in nested slots/
      // function-attrs register on the right scope). Async re-fires
      // never reach this pass — the watcher terraforms itself in that
      // path. Net: exactly one terraform per render of the instance.
      if (instance && instance.domEl !== el) instance.domEl = el
      terraform(el, v, recaller, resolveNs(v, ns))
      // Honor `autofocus` on freshly-mounted elements. Browsers respect the
      // attribute on initial page load but quietly skip it on dynamic
      // inserts when anything else has focus — so an input that *declared*
      // it wanted focus doesn't get it. We restore the declarative intent
      // by calling .focus() ourselves. Deferred to a microtask so the
      // element is attached to the document by the time focus fires
      // (during build the parent chain may not be in the DOM yet); the
      // isConnected guard skips focus if a later reactive render replaced
      // the element before the microtask drained.
      if (fresh && typeof el.hasAttribute === 'function' && el.hasAttribute('autofocus') && typeof el.focus === 'function') {
        queueMicrotask(() => { if (el.isConnected) el.focus() })
      }
    } else if (typeof Node !== 'undefined' && v instanceof Node) {
      newChildren[i] = v
    } else if (typeof v === 'string' || typeof v === 'number') {
      const str = String(v)
      if (!newChildren[i]) {
        newChildren[i] = document.createTextNode(str)
      } else if (newChildren[i].nodeValue !== str) {
        newChildren[i].nodeValue = str
      }
    }
  }

  // ── Position ──
  // insertBefore is an atomic move when the node is already a child of parent;
  // it does NOT fire blur on focused descendants. That's the property we need.
  let cursor = 0
  for (const node of newChildren) {
    if (node == null) continue
    if (parent.childNodes[cursor] !== node) {
      parent.insertBefore(node, parent.childNodes[cursor] ?? null)
    }
    cursor++
  }
  while (parent.childNodes.length > cursor) {
    const last = parent.childNodes[parent.childNodes.length - 1]
    cleanupSubtreeInstances(last)
    parent.removeChild(last)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function staticAttrValue (vnode, name) {
  const attr = vnode.attrs.find(a => a?.name === name)
  if (!attr) return null
  const v = attr.value
  if (typeof v === 'function' || Array.isArray(v)) return null
  return v ?? null
}

function resolveNs (vnode, ns) {
  const xmlnsAttr = vnode.attrs.find(a => a?.name === 'xmlns')
  const xmlns = (xmlnsAttr && typeof xmlnsAttr.value === 'string') ? xmlnsAttr.value : null
  if (xmlns) return xmlns
  if (vnode.tag === 'svg') return SVG_NS
  if (vnode.tag === 'foreignObject') return HTML_NS
  return ns
}

function terraform (el, vnode, recaller, ns) {
  // Diff-and-apply attrs. `touched` collects every attribute name the new
  // vnode sets; after the loop, anything on the element NOT touched is
  // stale and gets removed. The compare-before-mutate guard inside setAttr
  // makes "attrs are the same as last render" a true no-op — no DOM write,
  // no style recalc, no mutation-observer fire.
  const touched = new Set()
  for (const attr of vnode.attrs) {
    if (attr == null) continue
    applyAttr(el, attr, touched)
  }
  if (el.attributes) {
    for (const a of Array.from(el.attributes)) {
      if (!touched.has(a.name)) el.removeAttribute(a.name)
    }
  }
  reconcileChildren(el, vnode.children, recaller, ns)
}

function applyAttr (el, attr, touched) {
  if (typeof attr === 'object' && attr.name == null) {
    // spread object: ${attrs} in attribute position
    for (const [k, v] of Object.entries(attr)) applyAttr(el, { name: k, value: v }, touched)
    return
  }
  const { name, value } = attr
  if (typeof value === 'function') {
    setAttr(el, name, value(el), touched)
    return
  }
  if (Array.isArray(value)) {
    if (value.some(p => typeof p === 'function')) {
      const str = value.map(p => typeof p === 'function' ? p(el) : String(p ?? '')).join('')
      setAttr(el, name, str, touched)
    } else {
      setAttr(el, name, value, touched)
    }
    return
  }
  if (value === undefined) {
    // Boolean attribute with no value (e.g. <input autofocus>). Route
    // through setAttr so the touched-tracking + noop-when-same path applies.
    setAttr(el, name, true, touched)
    return
  }
  setAttr(el, name, value, touched)
}

function setAttr (el, name, value, touched) {
  if (touched) touched.add(name)
  // Normalize class arrays and objects to a space-separated string before
  // any comparison so noop-when-same works on canonical form.
  if (name === 'class') {
    if (Array.isArray(value)) value = value.filter(Boolean).join(' ')
    else if (value !== null && value !== undefined && typeof value === 'object') {
      value = Object.entries(value).filter(([, v]) => v).map(([k]) => k).join(' ')
    }
  }
  if (name.startsWith('on')) {
    // Event handlers set as JS properties. Reference comparison: skip the
    // reassign only when the new handler is literally the same function as
    // the current one. With handle() returning a fresh closure per render
    // this rarely hits, but a static handler reference does.
    const newHandler = typeof value === 'function' ? value : null
    if (el[name] !== newHandler) el[name] = newHandler
  } else if (name === 'value' && 'value' in el) {
    if (el.value !== value) el.value = value
  } else if (name === 'checked' && 'checked' in el) {
    const bool = !!value
    if (el.checked !== bool) el.checked = bool
    if (el.hasAttribute('checked') !== bool) el.toggleAttribute('checked', bool)
  } else if (typeof value === 'boolean') {
    if (el.hasAttribute(name) !== value) el.toggleAttribute(name, value)
  } else if (value == null) {
    if (el.hasAttribute(name)) el.removeAttribute(name)
  } else {
    const str = String(value)
    if (el.getAttribute(name) !== str) el.setAttribute(name, str)
  }
}

function buildProps (node) {
  const props = {}
  for (const attr of node.attrs) {
    if (attr == null) continue
    if (typeof attr === 'object' && attr.name) props[attr.name] = attr.value
    else if (typeof attr === 'object') Object.assign(props, attr) // spread
  }
  props.children = node.children
  return props
}
