/**
 * Decode file bytes: UTF-8 text → string, binary → Uint8Array.
 * @param {Buffer} bytes
 * @returns {string|Uint8Array}
 */
export function decodeBytes (bytes) {
  if (bytes.includes(0)) return new Uint8Array(bytes)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return new Uint8Array(bytes) }
}

/**
 * Decode a file's value for storage: JSON files become parsed objects, JSONL
 * files become arrays of records, everything else stays as-is. Anything that
 * fails to parse stays a string.
 *
 * `.jsonl` only takes the parsed path when the round-trip back through
 * `encodeFile` is provably byte-exact — no trailing newline, a blank line, or
 * an unparseable line all fall through to the string. Structure is worth
 * having but not worth silently rewriting somebody's file to get.
 *
 * @param {string} rel  relative path
 * @param {string|Uint8Array} value
 * @returns {object|Array|string|Uint8Array}
 */
export function decodeFile (rel, value) {
  if (typeof value !== 'string') return value
  if (rel.endsWith('.jsonl')) {
    try {
      const lines = value.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      // A blank or malformed line throws here and keeps the string.
      const records = lines.map(line => JSON.parse(line))
      // Check against the real inverse rather than a proxy for it — the two
      // can't drift if the test is the function itself. An earlier version
      // reasoned that trailing-newline + parseable was proof enough; it
      // wasn't, and 2 of 69 real transcripts said so. Both had records written
      // by a different tool as `{"a": 1}` where Claude Code writes `{"a":1}`,
      // and JSON.stringify normalises the spaces away.
      //
      // A missing trailing newline is the one difference we accept gaining
      // back (David, 2026-08-13: *"it's okay if we lose a trailing newline"*).
      // Everything else has to return byte-identical.
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

/**
 * Encode a file value for writing to disk. Strict shape contract:
 *   - `.json` files: value must be a plain object or array → JSON-encoded
 *   - other files:   value must be a string or Uint8Array → written as bytes
 * Any other combination throws. The earlier null-return + silent-skip
 * behavior hid contract violations; throwing surfaces them at the write
 * site where they can be debugged.
 *
 * @param {string} rel
 * @param {any} value
 * @returns {string|Uint8Array}
 */
export function encodeFile (rel, value) {
  const isJsonPath = rel.endsWith('.json')
  const typeDesc = value === null ? 'null'
    : value === undefined ? 'undefined'
    : value instanceof Uint8Array ? 'Uint8Array'
    : typeof value === 'object' ? (Array.isArray(value) ? 'array' : 'object')
    : typeof value
  if (rel.endsWith('.jsonl')) {
    // Empty array → empty file, not a lone newline. `[]` and `''` have to be
    // the same thing in both directions or the round-trip isn't one.
    if (Array.isArray(value)) return value.length ? value.map(record => JSON.stringify(record)).join('\n') + '\n' : ''
    // decodeFile hands back the raw string for any .jsonl it can't round-trip
    // exactly, so a string here is that file coming home unchanged — not a
    // contract violation. Throwing on it would make the read path capable of
    // manufacturing a write-path error. `.json` carried exactly that
    // asymmetry until 2026-08-20 and now follows this rule too.
    if (typeof value === 'string' || value instanceof Uint8Array) return value
    throw new Error(`encodeFile: ${rel} is a .jsonl path but value is ${typeDesc}; .jsonl slots require an array of records`)
  }
  if (isJsonPath) {
    // Same rule as .jsonl above: decodeFile hands back the raw string for a
    // .json it could not parse, so a string here is that file coming home
    // unchanged. Throwing on it let the read path manufacture a write-path
    // error — and because writeToFolder throws mid-loop, one half-typed
    // .json anywhere in the tree aborted the entire flush.
    if (typeof value === 'string' || value instanceof Uint8Array) return value
    if (value == null || typeof value !== 'object') {
      throw new Error(`encodeFile: ${rel} is a .json path but value is ${typeDesc}; .json slots require an object, an array, or the raw text`)
    }
    return JSON.stringify(value, null, 2) + '\n'
  }
  if (typeof value === 'string' || value instanceof Uint8Array) return value
  throw new Error(`encodeFile: ${rel} requires a string or Uint8Array value; got ${typeDesc}`)
}

/**
 * Rough equality check for a files object (handles Uint8Array values).
 * @param {Object} a
 * @param {Object} b
 * @returns {boolean}
 */
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
