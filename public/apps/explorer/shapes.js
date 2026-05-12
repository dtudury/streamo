// Type-guards and small classifiers used across explorer views.
// Pure inspection — no Repo or DOM dependencies.

export function isCommitShape (v) {
  return v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.message === 'string' && v.date instanceof Date &&
    typeof v.dataAddress === 'number'
}

// A Duple is an object whose only own property is `v`, a length-2 array.
// codecs.js doesn't export the class so we duck-type. Used so we can
// render Duples as `[a, b]` rather than `{…} (1)`.
export function isDuple (v) {
  return v && typeof v === 'object' && Array.isArray(v.v) && v.v.length === 2 && Object.keys(v).length === 1
}

// Map a codec type to a visual category. Many distinct codecs map to a
// shared category so the byte-stream stripe stays readable: commits (the
// narrative anchors), signatures (attestations), composite values, the
// Duple tree-scaffolding, strings, bytes, numbers, etc.
export function codecCategory (type) {
  switch (type) {
    case 'SIGNATURE': return 'sig'
    case 'OBJECT': case 'EMPTY_OBJECT': case 'ARRAY': case 'EMPTY_ARRAY': return 'composite'
    case 'DUPLE': return 'duple'
    case 'STRING': case 'EMPTY_STRING': return 'string'
    case 'WORD': case 'UINT8ARRAY': case 'EMPTY_UINT8ARRAY': return 'bytes'
    case 'DATE': case 'FLOAT64': case 'UINT7': return 'num'
    case 'VARIABLE': return 'var'
    default: return 'other'
  }
}

// Cheap width estimator for inline rendering — we only inline when
// every entry is a primitive, so we can predict rendered width without
// touching the DOM. Conservative: real chips have padding/quotes that
// add ~2-3 chars beyond the bare value.
export function isInlinablePrimitive (v) {
  if (v === null || v === undefined) return true
  const t = typeof v
  if (t === 'number' || t === 'boolean' || t === 'string') return true
  if (v instanceof Date) return true
  // Uint8Array renders as a multi-row bytes chart — not inlinable.
  return false
}

export function estimateEntryWidth (k, v, isArray) {
  let w = isArray ? 0 : (String(k).length + 2)
  if (v === null) w += 4
  else if (v === undefined) w += 9
  else if (typeof v === 'boolean') w += v ? 6 : 7
  else if (typeof v === 'number') w += String(v).length
  else if (typeof v === 'string') w += Math.min(v.length, 60) + 2
  else if (v instanceof Date) w += 22
  return w
}
