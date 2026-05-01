/**
 * Minimal DOM mock for testing mount() in Node.
 *
 * Implements only the subset of DOM APIs that hx.js mount() actually calls:
 *   - createElement / createElementNS / createTextNode / createComment / createDocumentFragment
 *   - appendChild, remove, before, nextSibling, childNodes
 *   - setAttribute, getAttribute, removeAttribute, toggleAttribute
 *   - textContent (read)
 */

class MockNode {
  #children = []
  #parent = null

  constructor (nodeType) {
    this.nodeType = nodeType
  }

  get childNodes () { return [...this.#children] }
  get parentNode () { return this.#parent }

  get textContent () {
    return this.#children.map(c => c.textContent).join('')
  }

  get nextSibling () {
    if (!this.#parent) return null
    const sibs = this.#parent.#children
    return sibs[sibs.indexOf(this) + 1] ?? null
  }

  appendChild (child) {
    if (child.#parent) child.remove()
    child.#parent = this
    this.#children.push(child)
    return child
  }

  remove () {
    if (!this.#parent) return
    this.#parent.#children = this.#parent.#children.filter(c => c !== this)
    this.#parent = null
  }

  before (...nodes) {
    if (!this.#parent) return
    const i = this.#parent.#children.indexOf(this)
    const toInsert = []
    for (const n of nodes) {
      if (n.nodeType === 11) { // DocumentFragment
        const cs = [...n.#children]
        n.#children = []
        cs.forEach(c => { c.#parent = this.#parent })
        toInsert.push(...cs)
      } else {
        if (n.#parent) n.remove()
        n.#parent = this.#parent
        toInsert.push(n)
      }
    }
    this.#parent.#children.splice(i, 0, ...toInsert)
  }
}

class MockElement extends MockNode {
  #attrs = {}

  constructor (tag) {
    super(1)
    this.tag = tag
  }

  setAttribute (name, val) { this.#attrs[name] = String(val) }
  getAttribute (name) { return this.#attrs[name] ?? null }
  removeAttribute (name) { delete this.#attrs[name] }
  toggleAttribute (name, force) {
    if (force) this.#attrs[name] = ''
    else delete this.#attrs[name]
  }
  addEventListener () {}
}

class MockText extends MockNode {
  constructor (value) {
    super(3)
    this.nodeValue = value
  }

  get textContent () { return this.nodeValue }
}

class MockComment extends MockNode {
  constructor (value) {
    super(8)
    this.nodeValue = value
  }

  get textContent () { return '' }
}

class MockFragment extends MockNode {
  constructor () { super(11) }
}

export const mockDocument = {
  createElement: tag => new MockElement(tag),
  createElementNS: (_ns, tag) => new MockElement(tag),
  createTextNode: text => new MockText(text),
  createComment: text => new MockComment(text),
  createDocumentFragment: () => new MockFragment()
}

export { MockNode }
