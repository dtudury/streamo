/**
 * @file turtleLog — verbose colored event log for wire moments.
 *
 * Ported in spirit from turtb's `AbstractUpdater.logUpdate`. Each peer
 * gets a unique checkerboard "block" derived from its pubkey, so a
 * scrollback of mixed traffic remains demuxable by eye. A glyph per
 * event-type adds a second axis you can scan vertically.
 *
 * Line shape:
 *   [▛▞▖🐢 ▝▞▟] <02e7…b93a> ← ✍️ sig          chainHash=ab12…cd34 …
 *   [▛▞▖🐢 ▝▞▟] <02e7…b93a> → 👂 subscribe    fromOffset=143657 …
 *
 * Default-off. Enable via `STREAMO_LOG_TURTLES=1` in env, or
 * `setTurtleLog(true)` at runtime.
 */

let enabled = !!(globalThis.process?.env?.STREAMO_LOG_TURTLES)

export function setTurtleLog (v) { enabled = !!v }
export function turtleLogEnabled () { return enabled }

const GLYPHS = {
  hello:        '👋',
  subscribe:    '👂',
  subscribed:   '✓ ',
  interest:     '🔎',
  announce:     '📣',
  reject:       '⛔',
  chunk:        '📦',
  sig:          '✍️',
  conflict:     '💥',
  pushRejected: '↩️ ',
  caughtUp:     '🌊',
  open:         '🤝',
  close:        '👋',
  ping:         '💓'
}

// OKLab→linear-sRGB (Björn Ottosson's matrices). OKLab/OKLCH is a
// perceptual color space — L=0.7 means "perceptually 70% lightness"
// regardless of hue, so two turtles with the same L but different
// hues read as equally bright to a human eye. HSL doesn't: HSL-yellow
// at L=0.7 looks blinding compared to HSL-blue at L=0.7.
function oklabToLinear (L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ]
}

const linearToSrgb = c =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055

const inGamut = linear => linear.every(c => c >= 0 && c <= 1)

/**
 * Render an OKLCH color into sRGB, preserving L and H exactly and
 * binary-searching down on chroma until the result fits the gamut.
 * Matches David's priority order: hue, then luminance, then saturation.
 */
function oklchToRgb (L, C, H) {
  const rad = H * Math.PI / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  let lo = 0, hi = C
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(oklabToLinear(L, mid * cos, mid * sin))) lo = mid
    else hi = mid
  }
  const linear = oklabToLinear(L, lo * cos, lo * sin)
  return linear.map(c => Math.round(Math.max(0, Math.min(1, linearToSrgb(c))) * 255))
}

/**
 * Derive two color triples + a swap bit from a key. Takes bytes from
 * the *tail* of the hex key — sidesteps the secp256k1 02/03 prefix
 * at byte 0, which has 7 stuck bits.
 *
 * - hue A → light variant (L=0.70) — perceptually 70% bright
 * - hue B → dark variant  (L=0.40) — perceptually 40% bright
 * - swap bit decides whether bg is light + fg is dark, or vice-versa
 *
 * Same perceptual lightness across all hues. Chroma starts at 0.2
 * and gets clipped down per-hue to whatever sRGB can hold — so
 * yellows stay vivid, blues mute themselves a bit, all within human-
 * eye-equal lightness bands.
 *
 * @param {string} keyHex
 * @returns {{ bg: [number, number, number], fg: [number, number, number] }}
 */
function colorsFromKey (keyHex) {
  const tail = keyHex.slice(-6).padStart(6, '0')          // 3 bytes
  const byte = i => parseInt(tail.slice(i * 2, i * 2 + 2), 16)
  const hueA = byte(0) * 360 / 256
  const hueB = byte(1) * 360 / 256
  const swap = byte(2) & 1
  const C = 0.2
  const light = oklchToRgb(0.70, C, hueA)
  const dark  = oklchToRgb(0.40, C, hueB)
  return swap ? { bg: dark, fg: light } : { bg: light, fg: dark }
}

function turtleBlock (keyHex) {
  const { bg, fg } = colorsFromKey(keyHex)
  return `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]};38;2;${fg[0]};${fg[1]};${fg[2]}m▛▞▖🐢 ▝▞▟\x1b[0m`
}

const ARROW_IN  = '\x1b[31m←\x1b[0m'
const ARROW_OUT = '\x1b[32m→\x1b[0m'
const DIM       = s => `\x1b[2m${s}\x1b[0m`

function shortKey (keyHex) {
  return `<${keyHex.slice(0, 4)}…${keyHex.slice(-4)}>`
}

function formatDetails (details) {
  if (!details) return ''
  if (typeof details === 'string') return details
  const parts = []
  for (const [k, v] of Object.entries(details)) {
    if (v == null) continue
    let pretty = v
    if (v instanceof Uint8Array) {
      const hex = Array.from(v.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('')
      const tail = Array.from(v.slice(-4)).map(b => b.toString(16).padStart(2, '0')).join('')
      pretty = v.length > 8 ? `${hex}…${tail}` : hex
    } else if (typeof v === 'string' && v.length > 12 && /^[0-9a-f]+$/i.test(v)) {
      pretty = `${v.slice(0, 4)}…${v.slice(-4)}`
    }
    parts.push(`${DIM(k + '=')}${pretty}`)
  }
  return parts.join(' ')
}

function line (arrow, event, keyHex, details) {
  const block = turtleBlock(keyHex)
  const glyph = GLYPHS[event] ?? '🐢'
  const id = shortKey(keyHex)
  // pad event name so columns roughly align
  const evt = event.padEnd(12)
  return `${block} ${id} ${arrow} ${glyph} ${evt} ${formatDetails(details)}`
}

/** Log an event the local node *received* from the wire. */
export function turtleIn (event, keyHex, details) {
  if (!enabled) return
  console.log(line(ARROW_IN, event, keyHex, details))
}

/** Log an event the local node *sent* to the wire. */
export function turtleOut (event, keyHex, details) {
  if (!enabled) return
  console.log(line(ARROW_OUT, event, keyHex, details))
}

/** Log a local state change (no direction — internal substrate event). */
export function turtleLocal (event, keyHex, details) {
  if (!enabled) return
  const block = turtleBlock(keyHex)
  const glyph = GLYPHS[event] ?? '🐢'
  const id = shortKey(keyHex)
  const evt = event.padEnd(12)
  console.log(`${block} ${id} ${DIM('·')} ${glyph} ${evt} ${formatDetails(details)}`)
}
