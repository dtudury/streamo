/**
 * mount — reactive DOM renderer for h virtual trees
 *
 * Naive laid-bare version. Slots are abandoned. The whole tree is a single
 * watch boundary: when any reactive read fires, the root render re-evaluates
 * top-to-bottom and reconciles the DOM in place. The recycler keeps it cheap.
 *
 * The reconcile algorithm is three best-fit passes against the parent's
 * current children: match by data-key, then by id, then by tag. Unmatched
 * old children are removed; unmatched new vnodes get fresh elements. Each
 * kept element is terraformed (attrs reset, children recursively reconciled).
 * Positioning happens via insertBefore, never replaceChildren, so focused
 * descendants stay focused across reorder.
 *
 * Function components must return exactly one HElement (we unwrap an array
 * of one). Inline functions in child position are tiny anonymous components.
 * Function-valued attributes are invoked at render time; the root watcher
 * captures the dep automatically.
 */

import { HElement, HText } from './h.js'

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS  = 'http://www.w3.org/2000/svg'

const rootWatchers = new WeakMap() // container → watcher fn

export function dismount (root, recaller) {
  const watcher = rootWatchers.get(root)
  if (watcher && recaller) recaller.unwatch(watcher)
  rootWatchers.delete(root)
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

// ── reconcileChildren ────────────────────────────────────────────────────
//
// The single reconcile operation. Mount is just reconcileChildren against an
// empty old-children set.

function reconcileChildren (parent, vnodes, recaller, ns) {
  // ── Resolve pass ──
  // Flatten arrays. Drop null/false. Invoke inline functions and function-
  // components, unwrap single-element returns.
  const resolved = []
  const resolve = (v) => {
    if (v == null || v === false) return
    if (Array.isArray(v)) { v.forEach(resolve); return }
    if (typeof v === 'function') { resolve(v(parent)); return }
    if (v instanceof HElement && typeof v.tag === 'function') {
      const inner = v.tag(buildProps(v))
      const arr = Array.isArray(inner) ? inner : [inner]
      const elements = arr.filter(x => x instanceof HElement)
      if (elements.length !== 1) return // invalid component output; drop
      const child = elements[0]
      // Inherit data-key from invocation if the inner element doesn't carry one
      const wrapperKey = staticAttrValue(v, 'data-key')
      if (wrapperKey != null && staticAttrValue(child, 'data-key') == null) {
        child.attrs = [...child.attrs, { name: 'data-key', value: wrapperKey }]
      }
      resolved.push(child)
      return
    }
    resolved.push(v)
  }
  vnodes.forEach(resolve)

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
  for (const child of oldChildren) {
    if (child) child.remove()
  }

  // ── Build / terraform ──
  for (let i = 0; i < resolved.length; i++) {
    const v = resolved[i]
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
    parent.removeChild(parent.childNodes[parent.childNodes.length - 1])
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
