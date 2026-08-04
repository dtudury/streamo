/**
 * md — Markdown parser, in the shape of `h`
 *
 * Usage:
 *   import { md } from './md.js'
 *   import { mount } from './mount.js'
 *   mount(document.body, () => md(text))
 *
 * Parses markdown into the **same virtual tree `h` produces** — `HElement` and
 * `HText` from `./h.js`. No HTML string is ever built. `mount` renders the
 * result exactly as it renders an `h` template, which means everything mount
 * already does (keying, reactive slots, event props) works here for free.
 *
 * That is the whole design, and it's David's line about the view layer: *"all
 * we make is a function that maps data shapes to html shapes."* Markdown is
 * just another data shape. So this file is a **parser**, not a renderer — it
 * stops at the tree and hands off.
 *
 * ## Why not `marked` / `markdown-it`
 *
 * Because we are not rendering *markdown*. We are rendering **our corpus** —
 * files we write, with a vocabulary we choose. The one feature that actually
 * matters is `[[wikilinks]]`, and no off-the-shelf renderer knows what those
 * are; you'd immediately be writing a plugin, and then you own a plugin *and*
 * a dependency.
 *
 * **The tell for when to switch: the moment the input stops being ours.**
 * Rendering `memory/` — this. Rendering something a stranger pasted — take
 * `marked` immediately, because correctness against adversarial input is then
 * the entire job, and markdown is famous for that 20% being forever. Emphasis
 * alone (`***a**b*`) is not reachable by regex, which is why CommonMark's spec
 * runs to ~700 examples.
 *
 * ## Deliberately not handled
 *
 * Nested lists, ordered lists, tables, reference links, raw HTML blocks,
 * setext headings, hard line breaks. Each would earn its place by a real file
 * needing it. Unhandled markup degrades to literal text rather than throwing —
 * a document that renders slightly wrong beats a document that doesn't render.
 */

import { HElement, HText } from './h.js'

const el = (tag, children, attrs = []) => new HElement(tag, attrs, children)
const text = value => new HText(value)

// ── Line scanner ─────────────────────────────────────────────────────────
//
// `h` scans characters because HTML is character-structured. Markdown is
// **line**-structured: what a line means is decided by its first few
// characters, and blocks end at blank lines. So the block scanner works in
// lines, and only the inline pass drops to characters. That difference is the
// single reason this isn't a copy of `h`'s Scanner.

class Lines {
  #lines
  #i = 0
  constructor (src) { this.#lines = src.replace(/\r\n?/g, '\n').split('\n') }
  get done () { return this.#i >= this.#lines.length }
  peek (offset = 0) { return this.#lines[this.#i + offset] }
  advance () { return this.#lines[this.#i++] }
  skipBlank () { while (!this.done && this.peek().trim() === '') this.#i++ }
}

// ── Inline ───────────────────────────────────────────────────────────────
//
// One pass, longest-marker-first. Order matters: `**` must be tried before
// `*`, or bold parses as two empty italics. Code spans are checked first
// because their content is opaque — `` `a *b* c` `` has no emphasis in it,
// and forgetting that is the classic markdown bug.

// Annotated as tuples, not inferred. Without this TypeScript widens each row
// to `(RegExp | ((m) => HElement))[]`, so destructuring `[re, make]` gives
// both names the union — `re.exec` and `make(...)` both become errors even
// though every row is well-formed. The annotation is the shape the array
// already had; it just wasn't stated.
/** @type {Array<[RegExp, (m: RegExpExecArray) => HElement]>} */
const INLINE = [
  // [[wikilink]] and [[wikilink|label]] — the reason this file exists.
  // Emitted as a real anchor with a data attribute so the app can decide what
  // a wikilink *means* (route, fetch, open a pane) without re-parsing.
  [/^\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/, (m) =>
    el('a', [text(m[2] || m[1])], [
      { name: 'href', value: `#${m[1].trim()}` },
      { name: 'data-wikilink', value: m[1].trim() }
    ])],
  [/^`([^`]+)`/, m => el('code', [text(m[1])])],
  [/^\*\*([^*]+)\*\*/, m => el('strong', [text(m[1])])],
  [/^\*([^*]+)\*/, m => el('em', [text(m[1])])],
  [/^\[([^\]]*)\]\(([^)\s]+)\)/, m =>
    el('a', [text(m[1])], [{ name: 'href', value: m[2] }])]
]

export function inline (src) {
  const out = []
  let buf = ''
  let i = 0
  const flush = () => { if (buf) { out.push(text(buf)); buf = '' } }
  while (i < src.length) {
    const rest = src.slice(i)
    let hit = null
    for (const [re, make] of INLINE) {
      const m = re.exec(rest)
      if (m) { hit = { m, make }; break }
    }
    if (hit) {
      flush()
      out.push(hit.make(hit.m))
      i += hit.m[0].length
    } else {
      // No marker matched here, so this character is literal. Advancing by one
      // rather than scanning ahead is what makes unmatched markup degrade to
      // text instead of throwing — an unclosed `*` is just an asterisk.
      buf += src[i]
      i++
    }
  }
  flush()
  return out
}

// ── Blocks ───────────────────────────────────────────────────────────────

const parseFence = (ls) => {
  const open = ls.advance()
  const lang = open.replace(/^```/, '').trim()
  const body = []
  // Unterminated fence runs to EOF on purpose: a half-written document should
  // still render, and the alternative is throwing on a file someone is
  // mid-edit in — which is exactly when they want to look at it.
  while (!ls.done && !/^```/.test(ls.peek())) body.push(ls.advance())
  if (!ls.done) ls.advance()
  return el('pre', [
    el('code', [text(body.join('\n'))],
      lang ? [{ name: 'data-lang', value: lang }] : [])
  ])
}

const parseHeading = (ls) => {
  const m = /^(#{1,6})\s+(.*)$/.exec(ls.advance())
  return el(`h${m[1].length}`, inline(m[2].trim()))
}

const parseList = (ls) => {
  const items = []
  while (!ls.done && /^\s*[-*+]\s+/.test(ls.peek())) {
    items.push(el('li', inline(ls.advance().replace(/^\s*[-*+]\s+/, ''))))
  }
  return el('ul', items)
}

const parseQuote = (ls) => {
  const body = []
  while (!ls.done && /^>\s?/.test(ls.peek())) body.push(ls.advance().replace(/^>\s?/, ''))
  return el('blockquote', [el('p', inline(body.join(' ')))])
}

const parseParagraph = (ls) => {
  const body = []
  // A paragraph ends at a blank line **or at anything that starts a block**.
  // Without the second half, a heading immediately after a paragraph gets
  // swallowed as more paragraph text — the most common bug in a hand-rolled
  // markdown parser, and the reason to check block starts here rather than
  // only at the top of the loop.
  while (!ls.done && ls.peek().trim() !== '' && !startsBlock(ls.peek())) {
    body.push(ls.advance().trim())
  }
  return el('p', inline(body.join(' ')))
}

const startsBlock = line =>
  /^#{1,6}\s/.test(line) || /^```/.test(line) ||
  /^\s*[-*+]\s+/.test(line) || /^>/.test(line) || /^(---+|\*\*\*+)\s*$/.test(line)

/**
 * Parse markdown into an `h`-compatible virtual tree.
 *
 * @param {string} src
 * @returns {Array<HElement|HText>} pass straight to `mount`
 */
export function md (src) {
  const ls = new Lines(src ?? '')
  const out = []
  while (true) {
    ls.skipBlank()
    if (ls.done) break
    const line = ls.peek()
    if (/^```/.test(line)) out.push(parseFence(ls))
    else if (/^#{1,6}\s/.test(line)) out.push(parseHeading(ls))
    else if (/^(---+|\*\*\*+)\s*$/.test(line)) { ls.advance(); out.push(el('hr', [])) }
    else if (/^\s*[-*+]\s+/.test(line)) out.push(parseList(ls))
    else if (/^>/.test(line)) out.push(parseQuote(ls))
    else out.push(parseParagraph(ls))
  }
  return out
}
