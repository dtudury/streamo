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

// Tags whose content is opaque text, not HTML. Browsers special-case
// these — anything between <style>…</style> or <script>…</script> is
// treated as the tag's raw text content, not nested elements. We
// follow suit: a `<dd>` inside a CSS comment shouldn't trip the
// parser into thinking the document has a `<dd>` element in it.
const RAW_TEXT = new Set(['style', 'script'])

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
  // Tagged template literals intern the `strings` array — every h`...` call
  // site passes the SAME strings reference across invocations. So we can
  // cache the expensive character-by-character tokenization once per call
  // site and reuse it forever. The cached "skeleton" stores characters as
  // strings and slot positions as { slotIdx: i } markers (NOT the values,
  // which differ per call). The constructor stitches the skeleton together
  // with this call's actual values into the parser's expected token shape.
  //
  // For the parser downstream, nothing about the token shape changes —
  // peek() still returns `{ slot: <value> }` for slots and a single
  // character for static tokens. Only the tokenization phase is cached.
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
    // Per-call: substitute this call's values at slot positions. Each call
    // gets a fresh tokens array so the per-instance `#i` cursor and the
    // parser's downstream mutations (none today, but possible) don't bleed
    // across calls.
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
  if (!selfClose && typeof tag === 'string' && RAW_TEXT.has(tag.toLowerCase())) {
    return new HElement(tag, attrs, parseRawText(sc, tag))
  }
  const children = selfClose ? [] : parseChildren(sc, tag)
  return new HElement(tag, attrs, children)
}

// For RAW_TEXT tags (<style>, <script>): read content until we hit
// the matching </tag>, treating everything in between as opaque text.
// Slot interpolations are still honored — `<style>${cssRules}</style>`
// works because the cssRules value is interpolated as text. The </tag>
// itself is consumed here.
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
    // Look ahead for "</tag" with the next char being whitespace,
    // /, or > — that's the real closing tag, not the substring of
    // some user text.
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
        // Consume `</tag` and any trailing whitespace + `>`.
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

/**
 * Memoize a function-component so it returns a cached output when invoked
 * with shallowly-equal props. Use sparingly and carefully:
 *
 *   const Header = memo(({ title }) => h`<h1>${title}</h1>`)
 *
 * **Safety contract:** the wrapped function's body must NOT read reactive
 * state (no `.get()` on a Recaller-backed source, no `liveValue.get()`,
 * no `Repo.get(...)`). If it does, memoizing by props alone returns a
 * stale tree when reactive state changes without props changing — there's
 * no per-component subscription tracking to invalidate the cache. It IS
 * safe to compose a memoized component with non-memoized children: inner
 * function-components are still invoked fresh on each render even when
 * the outer is memoized.
 *
 * **Scope:** this is single-instance memoization. The wrapper closes
 * over one `lastProps`/`lastOutput` pair, so it thrashes when used as
 * the function-component for items in a list (each invocation with
 * different props overwrites the slot). Per-instance memoization
 * across a list needs a per-key cache that's coupled to mount's
 * identity tracking — out of scope for this helper today.
 *
 * Comparison is shallow (`Object.is`-style on each own key); add an
 * extra layer if you need deeper equality.
 *
 * @param {Function} fn function-component
 * @returns {Function} memoized wrapper
 */
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

/**
 * De-curry a flat (event, element) handler into the (element → event → ...)
 * shape that mount expects from function-valued event attributes.
 *
 * Function-valued attrs are reactive cells: mount calls them with `(element)`
 * once per render and assigns the *return value* to the attribute. For event
 * handlers, that means the attr needs to evaluate to a handler function —
 * so the cell itself has to return one. The natural shape `element => event
 * => fn(event, element)` is correct but unpleasant to write inline. `handle`
 * lets you write a flat handler:
 *
 *   <button onclick=${handle((event, element) => doThing(event, element))}>
 *
 * And in function-component scope, you usually close over what you need and
 * skip the arguments entirely:
 *
 *   <button onclick=${handle(() => toggleTodo(todo.id))}>
 *
 * **Defangs the "return `false` is silent `preventDefault`" trap.** Mount
 * assigns event handlers as DOM Level 0 properties (`el.onclick = fn`); per
 * HTML spec, if such a handler returns `false`, the browser treats it as
 * `event.preventDefault()`. A natural short-circuit body like `e =>
 * e.key === 'Escape' && cancelEdit()` returns `false` for any non-Escape
 * key, silently blocking the keystroke. By wrapping the inner call in a
 * block body, `handle` *always* returns `undefined` regardless of what the
 * user's `fn` returns — the trap dissolves for any handler routed through
 * `handle`. If you explicitly want `preventDefault`, call `event.preventDefault()`.
 *
 * @param {(event: Event, element: Element) => any} fn
 * @returns {(element: Element) => (event: Event) => void}
 */
export const handle = fn => element => event => { fn(event, element) }
