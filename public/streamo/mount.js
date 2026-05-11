/**
 * mount — reactive DOM renderer for h virtual trees
 *
 * Cells are functions interpolated into an h template. There are four positions
 * a cell can appear, each with a consistent contract: the first argument is always
 * the relevant DOM element (or container), and the return value is what gets applied.
 *
 *   Position          Syntax                    Called as       Return value
 *   ─────────────────────────────────────────────────────────────────────────
 *   child slot        ${cell}                   cell(container) rendered as children
 *   attribute value   attr=${cell}              cell(el)        set as attribute
 *   event handler     onclick=${cell}           cell(el)        assigned to el.onclick
 *   mixed attribute   attr="prefix-${cell}"     cell(el)        stringified and joined
 *
 * All cells are wrapped in a recaller.watch() so they re-run automatically
 * whenever reactive data they accessed is mutated.
 *
 * For event handlers (on* attributes), the cell returns the handler function.
 * That handler's first argument is the DOM Event.
 */

import { HElement, HText } from './h.js'

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS  = 'http://www.w3.org/2000/svg'

// ── Watcher cleanup registry ──────────────────────────────────────────────
//
// Each node tracks the watcher functions registered against it.
// cleanupNode() walks the subtree unwatching all of them, so removed
// nodes never accumulate stale watchers.

const nodeCleanups = new WeakMap() // Node → Set<Function>

function addCleanup (node, f) {
  let set = nodeCleanups.get(node)
  if (!set) { set = new Set(); nodeCleanups.set(node, set) }
  set.add(f)
}

function cleanupNode (node, recaller) {
  const fns = nodeCleanups.get(node)
  if (fns) {
    for (const f of fns) recaller.unwatch(f)
    nodeCleanups.delete(node)
  }
  for (const child of [...node.childNodes]) cleanupNode(child, recaller)
}

// Call when removing a mounted root (e.g. in disconnectedCallback of a custom element).
export function dismount (root, recaller) {
  cleanupNode(root, recaller)
}

/**
 * Mount an array of virtual nodes (result of h``) into `container`.
 * @param {Array}  nodes
 * @param {Element} container
 * @param {import('./utils/Recaller.js').Recaller} recaller
 * @param {string} [ns]  XML namespace inherited from parent (defaults to XHTML)
 */
export function mount (nodes, container, recaller, ns = HTML_NS) {
  // mount() owns its container — clear any pre-existing children
  // before rendering. This makes the contract predictable: whatever
  // was in the container before is replaced wholesale. (The earlier
  // append-only behavior had a footgun: a loading shim in body
  // would sit stacked above the mounted app forever, because mount
  // didn't know it was supposed to take over.)
  for (const child of [...container.childNodes]) child.remove()
  for (const node of [nodes].flat()) {
    mountNode(node, container, recaller, ns)
  }
}

function mountNode (node, container, recaller, ns = HTML_NS) {
  if (node == null) return
  if (Array.isArray(node)) {
    node.forEach(n => mountNode(n, container, recaller, ns))
    return
  }
  if (node instanceof HElement) {
    if (typeof node.tag === 'function') {
      mountNode(node.tag(buildProps(node)), container, recaller, ns)
      return
    }
    // Determine this element's namespace:
    //   xmlns attr > svg tag > foreignObject resets to HTML > inherit from parent
    const nsAttr = node.attrs.find(a => a?.name === 'xmlns')?.value
    const elemNs = nsAttr
      ?? (node.tag === 'svg' ? SVG_NS
        : node.tag === 'foreignObject' ? HTML_NS
        : ns)
    const el = document.createElementNS(elemNs, node.tag)
    for (const attr of node.attrs) {
      if (attr == null) continue
      applyAttr(el, attr, recaller)
    }
    mount(node.children, el, recaller, elemNs)
    container.appendChild(el)
    return
  }
  if (node instanceof HText) {
    container.appendChild(document.createTextNode(node.value))
    return
  }
  if (node instanceof Node) {
    container.appendChild(node)
    return
  }
  if (typeof node === 'function') {
    mountSlot(node, container, recaller, ns)
    return
  }
  // primitive — string, number, etc.
  container.appendChild(document.createTextNode(String(node)))
}

// ── Child slot ────────────────────────────────────────────────────────────
//
// ${cell} in content position.
// Comment anchors delimit the slot's DOM range. On re-render, existing
// elements are matched by data-key (exact) or tag (positional fallback)
// and recycled in place. Unmatched nodes are cleaned up before removal.

function mountSlot (cell, container, recaller, ns = HTML_NS) {
  const start = document.createComment('')
  const end = document.createComment('')
  container.appendChild(start)
  container.appendChild(end)

  const watcher = () => {
    const newVNodes = [cell(container)].flat(Infinity).filter(n => n != null)
    reconcileSlot(start, end, newVNodes, recaller, ns)
  }
  addCleanup(start, watcher)
  recaller.watch(cell.name || '(h cell)', watcher)
}

function reconcileSlot (start, end, newVNodes, recaller, ns = HTML_NS) {
  // Collect existing Element nodes between the anchors — only elements can be recycled
  const existingEls = []
  let node = start.nextSibling
  while (node !== end) {
    if (node.nodeType === Node.ELEMENT_NODE) existingEls.push(node)
    node = node.nextSibling
  }

  // Build lookup: keyed elements by data-key, unkeyed elements pooled by tag.
  // Keyed and unkeyed pools are kept separate so a keyed vnode never steals
  // an unkeyed element and vice versa.
  const keyedMap = new Map()
  const tagPool = new Map()
  for (const el of existingEls) {
    const key = el.getAttribute('data-key')
    if (key != null) {
      keyedMap.set(key, el)
    } else {
      const tag = el.tagName.toLowerCase()
      if (!tagPool.has(tag)) tagPool.set(tag, [])
      tagPool.get(tag).push(el)
    }
  }

  // Match each new HElement vnode to an existing element
  const recycledEls = new Set()
  const vnodeToEl = new Map()
  for (const vnode of newVNodes) {
    if (!(vnode instanceof HElement)) continue
    const keyAttr = vnode.attrs.find(a => a?.name === 'data-key')
    const keyVal = keyAttr?.value
    // Only use static (non-reactive) key values for matching
    const key = (keyVal != null && typeof keyVal !== 'function' && !Array.isArray(keyVal))
      ? String(keyVal) : null

    let el = null
    if (key != null) {
      // Keyed: only match an existing element with the same data-key
      const candidate = keyedMap.get(key)
      if (candidate && !recycledEls.has(candidate)) el = candidate
    } else {
      // Unkeyed: take the first unused same-tag element from the pool
      const pool = tagPool.get(vnode.tag)
      if (pool) el = pool.find(e => !recycledEls.has(e)) ?? null
    }

    if (el) {
      recycledEls.add(el)
      vnodeToEl.set(vnode, el)
    }
  }

  // Detach recycled elements before wiping so they survive the cleanup pass
  for (const el of recycledEls) el.remove()

  // Clean up and remove all remaining old content
  while (start.nextSibling !== end) {
    const old = start.nextSibling
    cleanupNode(old, recaller)
    old.remove()
  }

  // Reinsert recycled elements (recursively reconciled) and mount fresh
  // ones, in order. Recursive reconcile preserves descendant DOM and
  // watchers — only attrs of the matched element are reset, children
  // that match by data-key/tag are themselves reconciled in place. This
  // is what lets a deeply nested data-keyed element (e.g. the byte
  // strip's container) survive an outer-slot re-render with its
  // scrollLeft, focus, and inner slot state intact.
  for (const vnode of newVNodes) {
    const recycled = vnodeToEl.get(vnode)
    if (recycled) {
      reconcileElement(recycled, vnode, recaller, ns)
      end.before(recycled)
    } else {
      const frag = document.createDocumentFragment()
      mountNode(vnode, frag, recaller, ns)
      end.before(frag)
    }
  }
}

// ── Recursive reconcile ──────────────────────────────────────────────────
//
// reconcileElement updates a matched element's attributes and recursively
// reconciles its children — preserving descendant DOM (and any browser
// state on it: scrollLeft, focus, scroll positions, inner slot anchors)
// when the new vnode tree's structure agrees with the existing one.
//
// The element's OWN attr watchers are unwatched and re-applied (their
// closures may have changed across the outer render). Descendant
// watchers are NOT touched — only re-applied where their containing
// element gets reconciled itself, deeper in the recursion.
//
// Children that don't match a new vnode (by data-key for keyed elements,
// by tag-pool for unkeyed) are cleaned up and removed; new vnodes that
// don't match an existing child are fresh-mounted.

function reconcileElement (el, vnode, recaller, ns) {
  // Determine child namespace, mirroring mountNode
  const nsAttr = vnode.attrs.find(a => a?.name === 'xmlns')?.value
  const elemNs = nsAttr
    ?? (vnode.tag === 'svg' ? SVG_NS
      : vnode.tag === 'foreignObject' ? HTML_NS
      : ns)
  // Snapshot scrollLeft/scrollTop so a hypothetical reflow during
  // child reconcile doesn't lose the user's scroll position.
  const scrollLeft = el.scrollLeft
  const scrollTop = el.scrollTop
  reconcileAttrs(el, vnode, recaller)
  reconcileChildren(el, vnode.children, recaller, elemNs)
  el.scrollLeft = scrollLeft
  el.scrollTop = scrollTop
}

function reconcileAttrs (el, vnode, recaller) {
  // Cleanup el's OWN attr watchers — descendants' watchers are NOT
  // touched (they belong to elements that may themselves be matched
  // and reconciled deeper in the recursion).
  const fns = nodeCleanups.get(el)
  if (fns) {
    for (const f of fns) recaller.unwatch(f)
    nodeCleanups.delete(el)
  }
  const oldAttrNames = Array.from(el.attributes, a => a.name)
  for (const name of oldAttrNames) el.removeAttribute(name)
  for (const attr of vnode.attrs) {
    if (attr == null) continue
    applyAttr(el, attr, recaller)
  }
}

function reconcileChildren (parent, vnodeChildren, recaller, ns) {
  // Flatten arrays/null in the vnode list so positional walking is clean.
  const flat = []
  const flatten = (v) => {
    if (v == null) return
    if (Array.isArray(v)) v.forEach(flatten)
    else flat.push(v)
  }
  vnodeChildren.forEach(flatten)

  // Collect existing element children (only elements are recyclable —
  // text nodes, comments, and slot anchors get cleaned up + rebuilt).
  const existingEls = []
  for (const child of parent.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) existingEls.push(child)
  }

  // Same matching strategy as reconcileSlot: keyed-by-data-key first,
  // unkeyed by tag pool.
  const keyedMap = new Map()
  const tagPool = new Map()
  for (const el of existingEls) {
    const key = el.getAttribute('data-key')
    if (key != null) {
      keyedMap.set(key, el)
    } else {
      const tag = el.tagName.toLowerCase()
      if (!tagPool.has(tag)) tagPool.set(tag, [])
      tagPool.get(tag).push(el)
    }
  }

  const recycledEls = new Set()
  const vnodeToEl = new Map()
  for (const vnode of flat) {
    if (!(vnode instanceof HElement)) continue
    if (typeof vnode.tag === 'function') continue  // function components mount fresh
    const keyAttr = vnode.attrs.find(a => a?.name === 'data-key')
    const keyVal = keyAttr?.value
    const key = (keyVal != null && typeof keyVal !== 'function' && !Array.isArray(keyVal))
      ? String(keyVal) : null
    let el = null
    if (key != null) {
      const candidate = keyedMap.get(key)
      if (candidate && !recycledEls.has(candidate)) el = candidate
    } else {
      const pool = tagPool.get(vnode.tag)
      if (pool) el = pool.find(e => !recycledEls.has(e)) ?? null
    }
    if (el) {
      recycledEls.add(el)
      vnodeToEl.set(vnode, el)
    }
  }

  // Detach recycled, cleanup + remove the rest (text nodes, comments,
  // unmatched elements all go through cleanupNode so any watchers in
  // their subtrees are released).
  for (const el of recycledEls) el.remove()
  while (parent.firstChild) {
    const old = parent.firstChild
    cleanupNode(old, recaller)
    old.remove()
  }

  // Insert in order: recursively reconcile recycled, mount fresh otherwise.
  for (const vnode of flat) {
    const recycled = vnodeToEl.get(vnode)
    if (recycled) {
      reconcileElement(recycled, vnode, recaller, ns)
      parent.appendChild(recycled)
    } else {
      mountNode(vnode, parent, recaller, ns)
    }
  }
}

// ── Function components ───────────────────────────────────────────────────
//
// When an HElement's tag is a function, call it with a props object instead
// of creating a DOM element. Attr values are passed as-is — reactive function
// attrs stay as functions so the component can forward them into its own slots.

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

// ── Attribute cells ───────────────────────────────────────────────────────
//
// attr=${cell}          → cell(el), return value applied via setAttr
// onclick=${cell}       → cell(el), return value assigned to el.onclick
// attr="prefix-${cell}" → each fn part called with el, results joined as string
// class=${[...]}        → falsy items filtered, truthy items joined with space
// class=${{k:bool}}     → keys with truthy values joined with space

function applyAttr (el, attr, recaller) {
  if (typeof attr === 'object' && !attr.name) {
    // spread object: ${attrs} in attribute position
    for (const [k, v] of Object.entries(attr)) applyAttr(el, { name: k, value: v }, recaller)
    return
  }
  const { name, value } = attr
  if (typeof value === 'function') {
    const watcher = () => setAttr(el, name, value(el))
    addCleanup(el, watcher)
    recaller.watch(`attr:${name}`, watcher)
    return
  }
  if (Array.isArray(value)) {
    if (value.some(p => typeof p === 'function')) {
      // Mixed static/dynamic attr from template interpolation — evaluate and concatenate
      const watcher = () => {
        setAttr(el, name, value.map(p => typeof p === 'function' ? p(el) : String(p ?? '')).join(''))
      }
      addCleanup(el, watcher)
      recaller.watch(`attr:${name}`, watcher)
    } else {
      // Static array value (e.g. class list) — delegate to setAttr for normalization
      setAttr(el, name, value)
    }
    return
  }
  if (value !== undefined) setAttr(el, name, value)
  else el.toggleAttribute(name, true) // boolean attribute (no value)
}

function setAttr (el, name, value) {
  // Normalize class arrays and objects into a space-separated string
  if (name === 'class') {
    if (Array.isArray(value)) {
      value = value.filter(Boolean).join(' ')
    } else if (value !== null && value !== undefined && typeof value === 'object') {
      value = Object.entries(value).filter(([, v]) => v).map(([k]) => k).join(' ')
    }
  }
  if (name.startsWith('on')) {
    el[name] = typeof value === 'function' ? value : null
  } else if (name === 'value' && 'value' in el) {
    el.value = value
  } else if (typeof value === 'boolean') {
    el.toggleAttribute(name, value)
  } else if (value == null) {
    el.removeAttribute(name)
  } else {
    el.setAttribute(name, value)
  }
}
