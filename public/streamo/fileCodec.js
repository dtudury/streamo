export function decodeBytes (bytes) {
  if (bytes.includes(0)) return new Uint8Array(bytes)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return new Uint8Array(bytes) }
}

export function decodeFile (rel, value) {
  if (typeof value !== 'string') return value
  if (rel.endsWith('.jsonl')) {
    try {
      const lines = value.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      const records = lines.map(line => JSON.parse(line))
      const encoded = encodeFile(rel, records)
      if (encoded !== value && encoded !== value + '\n') return value
      return records
    } catch { return value }
  }
  if (rel.endsWith('.json')) {
    try { return JSON.parse(value) } catch {}
  }
  return value
}

export function encodeFile (rel, value) {
  const isJsonPath = rel.endsWith('.json')
  const typeDesc = value === null ? 'null'
    : value === undefined ? 'undefined'
    : value instanceof Uint8Array ? 'Uint8Array'
    : typeof value === 'object' ? (Array.isArray(value) ? 'array' : 'object')
    : typeof value
  if (rel.endsWith('.jsonl')) {
    if (Array.isArray(value)) return value.length ? value.map(record => JSON.stringify(record)).join('\n') + '\n' : ''
    if (typeof value === 'string' || value instanceof Uint8Array) return value
    throw new Error(`encodeFile: ${rel} is a .jsonl path but value is ${typeDesc}; .jsonl slots require an array of records`)
  }
  if (isJsonPath) {
    if (typeof value === 'string' || value instanceof Uint8Array) return value
    if (value == null || typeof value !== 'object') {
      throw new Error(`encodeFile: ${rel} is a .json path but value is ${typeDesc}; .json slots require an object, an array, or the raw text`)
    }
    return JSON.stringify(value, null, 2) + '\n'
  }
  if (typeof value === 'string' || value instanceof Uint8Array) return value
  throw new Error(`encodeFile: ${rel} requires a string or Uint8Array value; got ${typeDesc}`)
}

export function filesEqual (a, b) {
  if (!a || !b) return a === b
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) return false
  for (const k of aKeys) {
    const av = a[k]
    const bv = b[k]
    if (av instanceof Uint8Array && bv instanceof Uint8Array) {
      if (av.length !== bv.length) return false
      if (!av.every((byte, i) => byte === bv[i])) return false
    } else if (av !== bv) {
      if (av == null || bv == null) return false
      if (typeof av === 'object' && typeof bv === 'object') {
        if (JSON.stringify(av) !== JSON.stringify(bv)) return false
      } else {
        return false
      }
    }
  }
  return true
}
