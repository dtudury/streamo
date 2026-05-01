/**
 * h — HTML template parser
 *
 * Usage:
 *   const nodes = h`<div class=${cls}>${() => streamo.get('name')}</div>`
 *
 * Parses the template into a virtual tree of HElement / HText nodes.
 * Interpolated values (slots) are stored as-is — functions are NOT called here.
 * Pass the result to `mount` (./mount.js) to render it into the DOM.
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
])

// ── Virtual tree types ───────────────────────────────────────────────────

export class HElement {
  constructor (tag, attrs, children) {
    this.tag = tag
    this.attrs = attrs       // Array.<{name, value}|any>
    this.children = children // Array of slots
  }
}

export class HText {
  constructor (value) {
    this.value = value // string
  }
}

// ── Scanner ──────────────────────────────────────────────────────────────

class Scanner {
  #tokens
  #i = 0

  constructor (strings, values) {
    this.#tokens = []
    for (let i = 0; i < strings.length; i++) {
      for (const c of strings[i]) this.#tokens.push(c)
      if (i < values.length) this.#tokens.push({ slot: values[i] })
    }
  }

  peek (offset = 0) { return this.#tokens[this.#i + offset] }
  isSlot (offset = 0) { return this.peek(offset)?.slot !== undefined }
  advance () { return this.#tokens[this.#i++] }
  get done () { return this.#i >= this.#tokens.length }

  readIf (str) {
    for (let i = 0; i < str.length; i++) {
      const c = this.peek(i)
      if (!c || c.slot !== undefined || c !== str[i]) return false
    }
    this.#i += str.length
    return true
  }

  assertChar (re) {
    const c = this.peek()
    if (!c || c.slot !== undefined || !c.match(re)) {
      throw new Error(`expected ${re}, got ${JSON.stringify(c)} at token ${this.#i}`)
    }
    this.#i++
  }

  skipSpace () {
    while (!this.done && !this.isSlot() && this.peek().match(/\s/)) this.#i++
  }

  /** Read chars until regex matches or a slot is hit. */
  readTo (re) {
    const parts = []
    while (!this.done && !this.isSlot() && !this.peek().match(re)) {
      const c = this.peek()
      if (c === '&') {
        parts.push(this.#readEscaped())
      } else {
        parts.push(c)
        this.#i++
      }
    }
    return parts.join('')
  }

  #readEscaped () {
    this.#i++ // consume '&'
    for (const [seq, char] of [['amp;', '&'], ['apos;', "'"], ['gt;', '>'], ['lt;', '<'], ['quot;', '"'], ['nbsp;', '\u00a0']]) {
      if (this.readIf(seq)) return char
    }
    throw new Error('unknown HTML escape sequence')
  }

  /**
   * Read an attribute value that may contain interleaved slots and literal text.
   * Returns a string if there are no slots, otherwise an array of string/slot parts.
   */
  readAttrValue (closingQuote) {
    const parts = []
    while (!this.done) {
      if (this.isSlot()) {
        parts.push(this.advance().slot)
      } else if (this.peek() === closingQuote) {
        break
      } else if (this.peek() === '&') {
        parts.push(this.#readEscaped())
      } else {
        let s = ''
        while (!this.done && !this.isSlot() && this.peek() !== closingQuote && this.peek() !== '&') {
          s += this.peek()
          this.#i++
        }
        if (s) parts.push(s)
      }
    }
    if (parts.every(p => typeof p === 'string')) return parts.join('')
    return parts
  }
}

// ── Parser ───────────────────────────────────────────────────────────────

const END_ATTRS = Symbol('end')

function parseAttr (sc) {
  sc.skipSpace()
  const c = sc.peek()
  if (!c || c === '/' || c === '>') return END_ATTRS
  // dynamic attribute object spread (e.g. ${attrs})
  if (sc.isSlot()) return sc.advance().slot
  const name = sc.readTo(/[\s=/>]/)
  if (!name) throw new Error('attribute must have a name')
  sc.skipSpace()
  if (!sc.readIf('=')) return { name }
  sc.skipSpace()
  if (sc.isSlot()) return { name, value: sc.advance().slot }
  const quote = (sc.peek() === '"' || sc.peek() === "'") ? sc.advance() : null
  if (quote) {
    const raw = sc.readAttrValue(quote)
    sc.assertChar(new RegExp(quote))
    const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw
    return { name, value }
  }
  return { name, value: sc.readTo(/[\s/>]/) }
}

function parseAttrs (sc) {
  const attrs = []
  while (true) {
    const attr = parseAttr(sc)
    if (attr === END_ATTRS) return attrs
    attrs.push(attr)
  }
}

function parseTag (sc) {
  sc.skipSpace()
  if (sc.isSlot()) return sc.advance().slot
  return sc.readTo(/[\s/>]/)
}

function parseElement (sc) {
  if (sc.isSlot()) return sc.advance().slot
  if (sc.peek() !== '<') {
    const text = sc.readTo(/</)
    return text ? new HText(text) : null
  }
  sc.assertChar(/</)
  const closing = sc.readIf('/')
  const tag = parseTag(sc)
  const isVoid = VOID.has(tag)
  const attrs = parseAttrs(sc)
  const selfClose = sc.readIf('/') || isVoid
  sc.assertChar(/>/)
  if (closing) return { _closing: tag }
  const children = selfClose ? [] : parseChildren(sc, tag)
  return new HElement(tag, attrs, children)
}

function parseChildren (sc, closingTag) {
  const children = []
  while (!sc.done) {
    const node = parseElement(sc)
    if (node === null) continue
    if (node?._closing) return children
    children.push(node)
  }
  return children
}

/**
 * Tagged template literal — parses the template into a virtual tree.
 * @param {TemplateStringsArray} strings
 * @param {...any} values
 * @returns {Array} array of HElement / HText / slot values
 */
export function h (strings, ...values) {
  const sc = new Scanner(strings, values)
  return parseChildren(sc, null)
}
