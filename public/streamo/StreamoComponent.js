/**
 * StreamoComponent — base class for hot-reloadable custom element components
 *
 * Two levels of component in streamo:
 *
 *   1. Function components — plain functions used directly as tags in h``:
 *
 *        function Card ({ title, children }) {
 *          return h`<div class="card"><h2>${title}</h2>${children}</div>`
 *        }
 *        mount(h`<${Card} title="Hello"><p>hi</p></${Card}>`, body, recaller)
 *
 *      Attr values are passed as-is: reactive function attrs stay as functions,
 *      so the component can forward them straight into its own slots.
 *
 *   2. Custom element components (this file) — for hot-reloading via content
 *      addresses. Each file version gets a unique element name; stale elements
 *      become orphans (different tag → no recycling → cleaned up automatically).
 *
 *      Typical pattern:
 *
 *        // When the address of Card.js changes in the reactive store:
 *        const cardTag = () => {
 *          const addr = repo.get('components.card')
 *          if (!addr) return null
 *          return defineComponent(componentKey('s-card', addr), ({ title }) =>
 *            h`<div class="card"><h2>${title}</h2></div>`
 *          )
 *        }
 *        mount(h`${() => { const t = cardTag(); return t && h`<${t} title="Hello"/>` }}`, body, recaller)
 */

import { Recaller } from './utils/Recaller.js'
import { mount, dismount } from './mount.js'

export class StreamoComponent extends HTMLElement {
  #recaller
  #root

  connectedCallback () {
    this.#recaller = new Recaller(this.localName)
    this.#root = this.attachShadow({ mode: 'open' })
    mount(this.render(this.#buildProps()), this.#root, this.#recaller)
  }

  disconnectedCallback () {
    if (this.#root) {
      dismount(this.#root, this.#recaller)
      this.#root = null
    }
  }

  // Override in subclasses or via defineComponent.
  render (props) { return [] }

  #buildProps () {
    const props = {}
    for (const { name, value } of this.attributes) props[name] = value
    props.children = [...this.childNodes]
    return props
  }
}

/**
 * Generate a valid custom element name from a prefix and a content address.
 * The address provides uniqueness — a new address means a new element name,
 * so stale elements are naturally orphaned without any explicit cleanup.
 *
 * @param {string} prefix  e.g. 's-card' (must contain a hyphen)
 * @param {string} address hex content address from the reactive store
 * @returns {string} e.g. 's-card-a1b2c3d4e5f6g7h8'
 */
export function componentKey (prefix, address) {
  return `${prefix}-${String(address).slice(0, 16).toLowerCase()}`
}

/**
 * Register a render function as a custom element. Safe to call multiple times
 * with the same name — subsequent calls are no-ops.
 *
 * @param {string}   name      valid custom element name (must contain a hyphen)
 * @param {Function} renderFn  (props) => virtual nodes
 * @returns {string} the name, for use directly as a tag
 */
export function defineComponent (name, renderFn) {
  if (!customElements.get(name)) {
    customElements.define(name, class extends StreamoComponent {
      render (props) { return renderFn(props) }
    })
  }
  return name
}
