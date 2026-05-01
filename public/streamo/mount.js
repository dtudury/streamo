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
// Two comment nodes act as stable anchors so the rendered output can be
// replaced in-place when the watcher fires.

function mountSlot (cell, container, recaller) {
  const start = document.createComment('')
  const end = document.createComment('')
  container.appendChild(start)
  container.appendChild(end)

  recaller.watch(cell.name || '(h cell)', () => {
    while (start.nextSibling !== end) start.nextSibling.remove()
    const frag = document.createDocumentFragment()
    mountNode(cell(container), frag, recaller)
    end.before(frag)
  })
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
    recaller.watch(`attr:${name}`, () => setAttr(el, name, value(el)))
    return
  }
  if (Array.isArray(value)) {
    // mixed static/dynamic: each function part is a cell called with el
    recaller.watch(`attr:${name}`, () => {
      setAttr(el, name, value.map(p => typeof p === 'function' ? p(el) : String(p ?? '')).join(''))
    })
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
