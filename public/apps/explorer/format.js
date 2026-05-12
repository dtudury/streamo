// Tiny UI-text formatters shared across the explorer's views.
// Pure value-to-string shapers — no streamo or DOM dependencies.

export const truncKey = k => k.slice(0, 12) + '…'

export const truncHex = (b, n = 16) =>
  Array.from(b.subarray(0, n))
    .map(x => x.toString(16).padStart(2, '0'))
    .join('') + (b.length > n ? '…' : '')

export const fmtDate = d => d ? d.toLocaleString() : ''

export function safeJSON (value) {
  return JSON.stringify(value, (_, v) => {
    if (v instanceof Uint8Array) return `Uint8Array(${v.length})`
    if (v instanceof Date) return v.toISOString()
    return v
  }, 2)
}
