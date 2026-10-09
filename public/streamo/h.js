
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
])

const RAW_TEXT = new Set(['style', 'script'])

export class HElement {
  constructor (tag, attrs, children) {
    this.tag = tag
    this.attrs = attrs
    this.children = children
  }
}

export class HText {
  constructor (value) {
    this.value = value
  }
}

class Scanner {
  static #skeletonCache = new WeakMap()
  #tokens
  #i = 0

  constructor (strings, values) {
    let skeleton = Scanner.#skeletonCache.get(strings)
    if (!skeleton) {
      skeleton = []
      for (let i = 0; i < strings.length; i++) {
        for (const c of strings[i]) skeleton.push(c)
        if (i < strings.length - 1) skeleton.push({ slotIdx: i })
      }
      Scanner.#skeletonCache.set(strings, skeleton)
    }
    this.#tokens = new Array(skeleton.length)
    for (let i = 0; i < skeleton.length; i++) {
      const t = skeleton[i]
      this.#tokens[i] = (t && t.slotIdx !== undefined) ? { slot: values[t.slotIdx] } : t
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
    this.#i++
    for (const [seq, char] of [['amp;', '&'], ['apos;', "'"], ['gt;', '>'], ['lt;', '<'], ['quot;', '"'], ['nbsp;', '\u00a0']]) {
      if (this.readIf(seq)) return char
    }
    throw new Error('unknown HTML escape sequence')
  }

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

const END_ATTRS = Symbol('end')

function parseAttr (sc) {
  sc.skipSpace()
  const c = sc.peek()
  if (!c || c === '/' || c === '>') return END_ATTRS
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
  if (!selfClose && typeof tag === 'string' && RAW_TEXT.has(tag.toLowerCase())) {
    return new HElement(tag, attrs, parseRawText(sc, tag))
  }
  const children = selfClose ? [] : parseChildren(sc, tag)
  return new HElement(tag, attrs, children)
}

function parseRawText (sc, tag) {
  const children = []
  let buf = ''
  const lower = tag.toLowerCase()
  const flushBuf = () => { if (buf) { children.push(new HText(buf)); buf = '' } }
  while (!sc.done) {
    if (sc.isSlot()) {
      flushBuf()
      children.push(sc.advance().slot)
      continue
    }
    if (sc.peek() === '<' && sc.peek(1) === '/') {
      let name = ''
      let j = 2
      while (true) {
        const c = sc.peek(j)
        if (c === undefined || c?.slot !== undefined || c.match(/[\s/>]/)) break
        name += c
        j++
      }
      if (name.toLowerCase() === lower) {
        flushBuf()
        for (let k = 0; k < j; k++) sc.advance()
        sc.skipSpace()
        sc.readIf('/')
        sc.assertChar(/>/)
        return children
      }
    }
    buf += sc.peek()
    sc.advance()
  }
  flushBuf()
  return children
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

export function h (strings, ...values) {
  const sc = new Scanner(strings, values)
  return parseChildren(sc, null)
}

export function memo (fn) {
  let lastProps = null
  let lastOutput = null
  return function memoized (props) {
    if (lastProps !== null && shallowEqual(props, lastProps)) return lastOutput
    lastProps = props
    lastOutput = fn(props)
    return lastOutput
  }
}

function shallowEqual (a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!Object.is(a[k], b[k])) return false
  return true
}

export const handle = fn => element => event => { fn(event, element) }
