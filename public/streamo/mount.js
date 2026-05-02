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

/**
 * Mount an array of virtual nodes (result of h``) into `container`.
 * @param {Array} nodes
 * @param {Element} container
 * @param {import('./utils/Recaller.js').Recaller} recaller
 */
export function mount (nodes, container, recaller) {
  for (const node of [nodes].flat()) {
    mountNode(node, container, recaller)
  }
}

function mountNode (node, container, recaller) {
  if (node == null) return
  if (Array.isArray(node)) {
    node.forEach(n => mountNode(n, container, recaller))
    return
  }
  if (node instanceof HElement) {
    const el = document.createElementNS(
      node.attrs.find(a => a?.name === 'xmlns')?.value ?? 'http://www.w3.org/1999/xhtml',
      node.tag
    )
    for (const attr of node.attrs) {
      if (attr == null) continue
      applyAttr(el, attr, recaller)
    }
    mount(node.children, el, recaller)
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
    mountSlot(node, container, recaller)
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

function mountSlot (cell, container, recaller) {
  const start = document.createComment('')
  const end = document.createComment('')
  container.appendChild(start)
  container.appendChild(end)

  const watcher = () => {
    const newVNodes = [cell(container)].flat(Infinity).filter(n => n != null)
    reconcileSlot(start, end, newVNodes, recaller)
  }
  addCleanup(start, watcher)
  recaller.watch(cell.name || '(h cell)', watcher)
}

function reconcileSlot (start, end, newVNodes, recaller) {
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

  // Reinsert recycled elements (static attrs patched) and mount fresh ones, in order
  for (const vnode of newVNodes) {
    const recycled = vnodeToEl.get(vnode)
    if (recycled) {
      patchElement(recycled, vnode)
      end.before(recycled)
    } else {
      const frag = document.createDocumentFragment()
      mountNode(vnode, frag, recaller)
      end.before(frag)
    }
  }
}

// Update static attributes on a recycled element.
// Reactive (function/array) attrs are already self-updating via their existing watchers.
function patchElement (el, vnode) {
  for (const attr of vnode.attrs) {
    if (attr == null) continue
    if (typeof attr === 'object' && !attr.name) continue // spread — skip
    if (typeof attr.value === 'function' || Array.isArray(attr.value)) continue // reactive — skip
    if (attr.value !== undefined) setAttr(el, attr.name, attr.value)
    else el.toggleAttribute(attr.name, true)
  }
}

// ── Attribute cells ───────────────────────────────────────────────────────
//
// attr=${cell}          → cell(el), return value applied via setAttr
// onclick=${cell}       → cell(el), return value assigned to el.onclick
// attr="prefix-${cell}" → each fn part called with el, results joined as string

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
    // mixed static/dynamic: each function part is a cell called with el
    const watcher = () => {
      setAttr(el, name, value.map(p => typeof p === 'function' ? p(el) : String(p ?? '')).join(''))
    }
    addCleanup(el, watcher)
    recaller.watch(`attr:${name}`, watcher)
    return
  }
  if (value !== undefined) setAttr(el, name, value)
  else el.toggleAttribute(name, true) // boolean attribute (no value)
}

function setAttr (el, name, value) {
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
