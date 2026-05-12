// Generic value-rendering primitives — produce h-vnodes from a value.
// No Repo, no view-state, no event handlers — just value-in, vnode-out.
//
// typedValue: a streamo-typed value renderer that gives each value a
// visual identity matching its underlying codec (string → quoted, date
// → calendar chip, Uint8Array → bytes chart, etc.).
//
// bytesChart: the three-row hex/char/decimal byte visualizer used by
// typedValue (for inline previews) and by rawChunkSection (for full
// chunk dumps).

import { h } from '../../streamo/h.js'
import { isDuple } from './shapes.js'

// Streamo-typed value renderer — every value gets a visual identity
// matching its underlying codec, instead of being flattened through
// JSON.stringify. Primitives render with type-specific styling
// (string → quoted mono in green frame, date → <time> with calendar
// chip, number → number chip, etc.); composites currently render as
// count chips ({ N fields } / [ N elements ]) — depth-controlled
// expansion lives in valueTree.
export function typedValue (v, depth = 0) {
  if (v === null) return h`<span class="tv tv-null" title="NULL">null</span>`
  if (v === undefined) return h`<span class="tv tv-undefined" title="UNDEFINED">undefined</span>`
  if (typeof v === 'boolean') {
    return h`<span class=${['tv', 'tv-bool', v ? 'tv-true' : 'tv-false']} title=${v ? 'TRUE' : 'FALSE'}>${v ? '✓' : '✗'} ${String(v)}</span>`
  }
  if (typeof v === 'string') {
    const display = v.length > 60 ? v.slice(0, 60) + '…' : v
    return h`<span class="tv tv-string" title=${v.length === 0 ? 'EMPTY_STRING' : 'STRING'}><span class="tv-quote">“</span>${display}<span class="tv-quote">”</span></span>`
  }
  if (typeof v === 'number') {
    // UINT7 is the codec for non-negative integers < 128; everything else
    // routes through FLOAT64. Surfacing this distinction makes "why is
    // this 1 byte vs 9" tactile when you hover.
    const codec = (Number.isInteger(v) && v >= 0 && v < 128) ? 'UINT7' : 'FLOAT64'
    return h`<span class="tv tv-num" title=${codec}>${String(v)}</span>`
  }
  if (v instanceof Date) {
    return h`<span class="tv tv-date" title="DATE"><span class="tv-glyph">📅</span><time datetime=${v.toISOString()}>${v.toLocaleString()}</time></span>`
  }
  if (v instanceof Uint8Array) {
    return bytesChart(v, { max: 8 })
  }
  if (isDuple(v)) {
    if (depth > 1) return h`<span class="tv tv-duple" title="DUPLE">Duple(…)</span>`
    return h`<span class="tv tv-duple" title="DUPLE">Duple(${typedValue(v.v[0], depth + 1)}, ${typedValue(v.v[1], depth + 1)})</span>`
  }
  if (Array.isArray(v)) {
    return h`<span class="tv tv-array" title=${v.length === 0 ? 'EMPTY_ARRAY' : 'ARRAY'}>[ ${v.length} ${v.length === 1 ? 'element' : 'elements'} ]</span>`
  }
  if (typeof v === 'object') {
    const n = Object.keys(v).length
    return h`<span class="tv tv-object" title=${n === 0 ? 'EMPTY_OBJECT' : 'OBJECT'}>{ ${n} ${n === 1 ? 'field' : 'fields'} }</span>`
  }
  return h`<span class="tv">${String(v)}</span>`
}

// Three-row byte chart: hex / char / decimal, with each byte in a
// fixed-width column. Tries to honor "beautifully formatted while
// also being tight" — monospace, narrow gutters, dim subordinate
// rows. Used by typedValue for inline Uint8Array previews (8 bytes,
// no offset) and by rawChunkSection for the full chunk dump
// (offset column on the left, 16 bytes per group, capped at 256).
//
//   ┌──────────────────────────────────────────┐
//   │     61   6c   69   63   65   20   66  6f │  ← hex (olive)
//   │      a    l    i    c    e         f   o │  ← char (ink, dim for non-printable)
//   │     97  108  105   99  101   32  102 111 │  ← decimal (dim, smaller)
//   └──────────────────────────────────────────┘
export function bytesChart (bytes, options = {}) {
  const { max = Infinity, perRow = 8, showOffset = false } = options
  const len = bytes.length
  if (len === 0) return h`<span class="dim mono">(empty)</span>`
  const showLen = Math.min(len, max)
  const slice = bytes.subarray(0, showLen)
  const truncated = len > showLen
  const groups = []
  for (let i = 0; i < slice.length; i += perRow) {
    groups.push({ offset: i, bytes: slice.subarray(i, Math.min(i + perRow, slice.length)) })
  }
  return h`<div class="bytes-chart">
    ${groups.map(group => h`<table class=${['bytes-group', showOffset ? 'with-offset' : null]}>
      <tr class="hex">
        ${showOffset ? h`<th>${group.offset.toString(16).padStart(4, '0')}</th>` : null}
        ${[...group.bytes].map(b => h`<td>${b.toString(16).padStart(2, '0')}</td>`)}
      </tr>
      <tr class="char">
        ${showOffset ? h`<th></th>` : null}
        ${[...group.bytes].map(b => {
          const printable = b >= 0x20 && b <= 0x7E
          return h`<td class=${printable ? 'printable' : 'nonprint'}>${printable ? String.fromCharCode(b) : '·'}</td>`
        })}
      </tr>
      <tr class="dec">
        ${showOffset ? h`<th></th>` : null}
        ${[...group.bytes].map(b => h`<td>${b}</td>`)}
      </tr>
    </table>`)}
    ${truncated ? h`<div class="bytes-chart-more dim">… +${len - showLen} more bytes</div>` : null}
  </div>`
}
