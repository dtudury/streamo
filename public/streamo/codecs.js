/**
 * @file codecs — concrete codecs for every value type Streamo can encode.
 *
 * Primitives (UNDEFINED, NULL, FALSE, TRUE, UINT7, FLOAT64, DATE), bytes
 * (WORD, UINT8ARRAY, EMPTY_UINT8ARRAY), strings, composites (OBJECT,
 * ARRAY, EMPTY_*), the SIGNATURE chunk, and the internal balanced-tree
 * node Duple used to scale OBJECT/ARRAY storage. Every codec is a
 * { encode, decode, partReaders } object.
 *
 * The `r` (registry interface) is passed to every codec method and
 * helper as a leading argument — never captured in closure. That lets
 * the same codec object serve both write contexts (where r.append
 * materializes inline parts as addressable chunks) and read-only
 * contexts (where r.append is undefined, and helpers return undefined
 * rather than mutate). CodecRegistry constructs both flavors of r and
 * dispatches the right one per entry point; mutation-impossibility is
 * a property of which r you pass, not a flag you flip.
 *
 * See design.md §3.
 */
import { numberToVar, varToNumber, range } from './utils.js'
import { Signature } from './Signature.js'

/**
 * Balanced binary tree node — internal to this file.
 * Arrays and objects are encoded as trees of these nodes.
 * Not exported; callers always work with plain arrays and objects.
 */
class Duple {
  constructor (items) {
    if (items.length === 2) {
      this.v = items
    } else if (items.length > 2) {
      const split = 2 ** (31 - Math.clz32(items.length - 1))
      const right = items.length - split === 1 ? items[items.length - 1] : new Duple(items.slice(split))
      this.v = [new Duple(items.slice(0, split)), right]
    } else {
      throw new Error('Duple requires at least 2 items')
    }
  }

  flat () {
    // Walk the Duple tree, flattening only Duple nodes — never nested user
    // values. (Earlier code used Array.prototype.flat() which silently
    // flattened any nested array a caller had stored, so e.g. [3, [4,5]]
    // would round-trip as [3, 4, 5].)
    const out = []
    for (const child of this.v) {
      if (child instanceof Duple) out.push(...child.flat())
      else out.push(child)
    }
    return out
  }

  flatDuples () {
    const bothDuple = this.v.every(v => v instanceof Duple)
    const noDuple = this.v.every(v => !(v instanceof Duple))
    if (bothDuple) return [...this.v[0].flatDuples(), ...this.v[1].flatDuples()]
    if (noDuple) return [this]
    throw new Error('mixed Duple tree')
  }
}

// ── Part reader factories ──────────────────────────────────────────────────
// A partReader factory is `(r, code) => { type, width, address?, getCode?,
// getDecoded }`. Readers close over their `r` so getCode/getDecoded recurse
// through the same registry context.

const inlineReader = [(r, code) => {
  const codec = r.footerToCodec[code.at(-1)]
  const width = codec.getWidth(code)
  return {
    type: `inline(${width})`,
    width,
    getCode: () => code.slice(-width),
    getDecoded: asRefs => r.decode(code.slice(-width), asRefs)
  }
}]

const addressReaders = range(4).map(i => (r, code) => {
  const width = i + 1
  const address = varToNumber(code.slice(-width))
  return {
    type: `addr(${width})`,
    width,
    address,
    getCode: () => r.resolve(address),
    getDecoded: asRefs => r.decode(r.resolve(address), asRefs)
  }
})

// 5 options: option 0 = inline, 1-4 = 1..4-byte address.
const inlineOrAddress = [...inlineReader, ...addressReaders]

const wordReaders = range(4).map(i => (r, code) => {
  const width = i + 1
  return { type: `word(${width})`, width, getDecoded: () => code.slice(-width) }
})

const literalReaders = range(5).map(width => (r, code) => ({
  type: `literal(${width})`,
  width,
  getDecoded: () => code.slice(-width)
}))

const signatureReader = [(r, code) => ({
  type: 'sig(64)',
  width: 64,
  getDecoded: () => code.slice(-64)
})]

const uint7Readers = range(128).map(n => () => ({
  type: `uint7(${n})`,
  width: 0,
  getDecoded: () => new Uint8Array([n])
}))

// ── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Ensure `code` is stored and return [partBytes, optionIndex].
 * Option 0: inline (just the raw bytes).
 * Options 1-4: 1-4-byte little-endian address.
 *
 * Read-only contexts pass an `r` without `append`; in that case this
 * function never gets called from a decode path (it's encode-only).
 */
function inlineOrAddressPart (r, code) {
  const existingAddr = r.addressOf(code)
  const nextAddr = Math.max(0, r.byteLength + code.length - 1)
  if (existingAddr === undefined && code.length <= numberToVar(nextAddr).length) {
    return [code, 0]
  }
  const addr = existingAddr ?? r.append(code)
  const addrBytes = numberToVar(addr)
  return [addrBytes, addrBytes.length] // option = 1..4
}

function encodeMultipart (r, values, codec, asRefs) {
  if (values.length !== codec.partReaders.length) throw new Error('part count mismatch')
  const parts = []
  let base = 1
  let footer = codec.baseFooter
  for (let i = values.length - 1; i >= 0; i--) {
    const [part, option] = inlineOrAddressPart(r, r.encode(values[i], asRefs))
    footer += base * option
    base *= codec.partReaders[i].length
    parts.unshift(part)
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) + 1)
  let pos = 0
  for (const p of parts) { out.set(p, pos); pos += p.length }
  out[pos] = footer
  return out
}

function decodeParts (r, code) {
  const footer = code.at(-1)
  const codec = r.footerToCodec[footer]
  if (!codec?.partReaders?.length) return []
  const parts = []
  let option = footer - codec.baseFooter
  let end = -1
  for (let i = codec.partReaders.length - 1; i >= 0; i--) {
    const opts = codec.partReaders[i]
    const reader = opts[option % opts.length]
    option = Math.floor(option / opts.length)
    const part = reader(r, code.subarray(0, end))
    end -= part.width
    parts.unshift(part)
  }
  return parts
}

// Stable address of a single-part value (needed for DUPLE decode with asRefs).
//
// For inline multi-byte parts that aren't independently stored, the only
// way to "give back an address" is to materialize them as a separate chunk —
// i.e. mutate. That's appropriate in write contexts (Streamo.set). In a
// read-only context the caller passes an `r` without `append`, and we
// return undefined so the caller (asRefs's caller, e.g. the explorer)
// sees an undefined child address and renders it as inline.
function getPartAddress (r, part) {
  if (part.address !== undefined) return part.address
  const code = part.getCode()
  if (code.length === 1) return -(code[0] + 1) // negative address for single-byte primitives
  const existing = r.addressOf(code)
  if (existing !== undefined) return existing
  if (!r.append) return undefined
  return r.append(code)
}

/**
 * Build all codecs. Returned codecs are instance-agnostic — every
 * encode/decode takes `r` as its first argument, so the same codec
 * objects can serve a read-write or read-only registry context
 * depending on which `r` is passed in.
 *
 * Each codec is an object with:
 *   type         — string name (set by the registry after registration)
 *   baseFooter   — set by the registry after registration
 *   partReaders  — optional array of option-arrays (see below)
 *   getWidth     — optional override; defaults to sum of part widths + 1
 *   encode(r, v, asRefs)         — returns Uint8Array or falsy
 *   decode(r, code, asRefs)      — returns the JS value
 *
 * @returns {Object} map of codec name → codec definition
 */
export function makeCodecs () {
  // ── Codec definitions ────────────────────────────────────────────────────

  const UNDEFINED = {
    encode: (r, v) => v === undefined && new Uint8Array([UNDEFINED.baseFooter]),
    decode: () => undefined
  }

  const NULL = {
    encode: (r, v) => v === null && new Uint8Array([NULL.baseFooter]),
    decode: () => null
  }

  const FALSE = {
    encode: (r, v) => v === false && new Uint8Array([FALSE.baseFooter]),
    decode: () => false
  }

  const TRUE = {
    encode: (r, v) => v === true && new Uint8Array([TRUE.baseFooter]),
    decode: () => true
  }

  /** ≤4-byte Uint8Array stored literally */
  const WORD = {
    partReaders: [literalReaders],
    encode (r, v) {
      if (v instanceof Uint8Array && v.length >= 1 && v.length <= 4) {
        const out = new Uint8Array(v.length + 1)
        out.set(v)
        out[v.length] = WORD.baseFooter + v.length
        return out
      }
    },
    decode (r, code) { return decodeParts(r, code)[0].getDecoded() }
  }

  /** Arbitrary-length Uint8Array (>4 bytes), stored via Duple tree of WORDs */
  const UINT8ARRAY = {
    partReaders: [inlineOrAddress],
    encode (r, v) {
      if (v instanceof Uint8Array && v.length > 4) {
        const words = []
        for (let i = 0; i < v.length; i += 4) words.push(v.slice(i, Math.min(i + 4, v.length)))
        return encodeMultipart(r, [new Duple(words)], UINT8ARRAY)
      }
    },
    decode (r, code) {
      const parts = decodeParts(r, code)
      const duple = parts[0].getDecoded(false)
      const words = duple.flat()
      const total = words.reduce((n, w) => n + w.length, 0)
      const out = new Uint8Array(total)
      let pos = 0
      for (const w of words) { out.set(w, pos); pos += w.length }
      return out
    }
  }

  const EMPTY_STRING = {
    encode: (r, v) => v === '' && new Uint8Array([EMPTY_STRING.baseFooter]),
    decode: () => ''
  }

  const STRING = {
    partReaders: [inlineOrAddress],
    encode (r, v) {
      if (typeof v === 'string' && v !== '') {
        const bytes = new TextEncoder().encode(v)
        return encodeMultipart(r, [bytes], STRING)
      }
    },
    decode (r, code) {
      return new TextDecoder().decode(decodeParts(r, code)[0].getDecoded(false))
    }
  }

  /** Non-negative integer 0..127 */
  const UINT7 = {
    partReaders: [uint7Readers],
    encode (r, v) {
      if (Number.isInteger(v) && v >= 0 && v < 128) return new Uint8Array([UINT7.baseFooter + v])
    },
    decode (r, code) { return decodeParts(r, code)[0].getDecoded()[0] }
  }

  const FLOAT64 = {
    partReaders: [inlineOrAddress],
    encode (r, v) {
      if (typeof v === 'number') {
        return encodeMultipart(r, [new Uint8Array(new Float64Array([v]).buffer)], FLOAT64)
      }
    },
    decode (r, code) {
      const bytes = decodeParts(r, code)[0].getDecoded(false)
      return new Float64Array(bytes.buffer, bytes.byteOffset, 1)[0]
    }
  }

  const DATE = {
    partReaders: [inlineOrAddress],
    encode (r, v) {
      if (v instanceof Date) {
        return encodeMultipart(r, [new Uint8Array(new Float64Array([v.getTime()]).buffer)], DATE)
      }
    },
    decode (r, code) {
      const bytes = decodeParts(r, code)[0].getDecoded(false)
      return new Date(new Float64Array(bytes.buffer, bytes.byteOffset, 1)[0])
    }
  }

  const SIGNATURE = {
    partReaders: [wordReaders, signatureReader],
    encode (r, v) {
      if (v instanceof Signature) {
        const addrBytes = numberToVar(v.address)
        const out = new Uint8Array(addrBytes.length + 64 + 1)
        out.set(addrBytes)
        out.set(v.compactRawBytes, addrBytes.length)
        out[addrBytes.length + 64] = SIGNATURE.baseFooter + addrBytes.length - 1
        return out
      }
    },
    decode (r, code) {
      const parts = decodeParts(r, code)
      return new Signature(varToNumber(parts[0].getDecoded()), parts[1].getDecoded())
    }
  }

  /** Internal balanced binary tree node. Never exposed to callers. */
  const DUPLE = {
    partReaders: [inlineOrAddress, inlineOrAddress],
    encode (r, v, asRefs) {
      if (v instanceof Duple) return encodeMultipart(r, v.v, DUPLE, asRefs)
    },
    decode (r, code, asRefs) {
      const parts = decodeParts(r, code)
      const leftCode = parts[0].getCode()
      const rightCode = parts[1].getCode()
      const leftIsDuple = r.footerToCodec[leftCode.at(-1)]?.type === 'DUPLE'
      const rightIsDuple = r.footerToCodec[rightCode.at(-1)]?.type === 'DUPLE'
      if (!leftIsDuple && !rightIsDuple) {
        // 'all' means return addresses for both slots (used by array asRefs)
        const nameIsRef = asRefs === 'all' || (Array.isArray(asRefs) && asRefs[1])
        const valueIsRef = asRefs === 'all' || asRefs === true || (Array.isArray(asRefs) && asRefs[0])
        return new Duple([
          nameIsRef ? getPartAddress(r, parts[0]) : parts[0].getDecoded(false),
          valueIsRef ? getPartAddress(r, parts[1]) : parts[1].getDecoded(false)
        ])
      }
      // Non-leaf: at least one child is itself a Duple subtree.
      // With 'all', recurse into sub-duples and take the address of any leaf.
      if (asRefs === 'all') {
        return new Duple([
          leftIsDuple ? parts[0].getDecoded('all') : getPartAddress(r, parts[0]),
          rightIsDuple ? parts[1].getDecoded('all') : getPartAddress(r, parts[1])
        ])
      }
      return new Duple([parts[0].getDecoded(asRefs), parts[1].getDecoded(asRefs)])
    }
  }

  const EMPTY_ARRAY = {
    encode: (r, v) => Array.isArray(v) && v.length === 0 && new Uint8Array([EMPTY_ARRAY.baseFooter]),
    decode: () => []
  }

  const ARRAY = {
    partReaders: [inlineOrAddress],
    encode (r, v, asRefs) {
      if (!Array.isArray(v) || v.length === 0) return
      if (v.length > 1 && Object.keys(v).length === v.length) {
        return encodeMultipart(r, [new Duple(v)], ARRAY, asRefs)
      }
      // sparse or single-element array: encode as object with length key
      const obj = Object.assign({}, v, { length: v.length })
      return encodeMultipart(r, [obj], ARRAY, asRefs)
    },
    decode (r, code, asRefs) {
      // 'all' mode: return an address for every element rather than decoded values
      const inner = decodeParts(r, code)[0].getDecoded(asRefs === true ? 'all' : asRefs)
      if (inner instanceof Duple) return inner.flat()
      return Object.assign([], inner)
    }
  }

  const EMPTY_OBJECT = {
    // Accepts any non-array object with no own enumerable keys, including class
    // instances. (OBJECT also doesn't check the prototype on encode, so empty
    // class instances should be encodable too — keeping them symmetric.) Type
    // information is lost on round-trip in both cases; the decoded value is a
    // plain {}.
    encode (r, v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return
      if (v instanceof Uint8Array || v instanceof Date) return
      if (Object.keys(v).length === 0) return new Uint8Array([EMPTY_OBJECT.baseFooter])
    },
    decode: () => ({})
  }

  const OBJECT = {
    partReaders: [inlineOrAddress],
    encode (r, v, asRefs) {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length === 0) return
      const duples = Object.entries(v).map(([k, val]) => new Duple([k, val]))
      const tree = duples.length === 1 ? duples[0] : new Duple(duples)
      return encodeMultipart(r, [tree], OBJECT, asRefs)
    },
    decode (r, code, asRefs) {
      const tree = decodeParts(r, code)[0].getDecoded(asRefs)
      return Object.fromEntries(tree.flatDuples().map(d => [d.v[0], d.v[1]]))
    }
  }

  /**
   * A boxed value — wraps any encoded value so it can be stored as a
   * first-class address rather than inline. Used by Stream.set() to
   * store a changing top-level value.
   */
  const VARIABLE = {
    partReaders: [inlineOrAddress],
    encode: () => undefined, // not directly encodable; use _encode
    _encode (r, encodedValue) {
      const [part, option] = inlineOrAddressPart(r, encodedValue)
      const out = new Uint8Array(part.length + 1)
      out.set(part)
      out[part.length] = VARIABLE.baseFooter + option
      return out
    },
    decode (r, code, asRefs) {
      return decodeParts(r, code)[0].getDecoded(asRefs)
    }
  }

  // Empty-Uint8Array codec is appended at the END of the registration list so
  // it doesn't shift the footer values of existing codecs — chunks created
  // before this codec was added still decode correctly.
  const EMPTY_UINT8ARRAY = {
    encode: (r, v) => v instanceof Uint8Array && v.length === 0 && new Uint8Array([EMPTY_UINT8ARRAY.baseFooter]),
    decode: () => new Uint8Array(0)
  }

  return { UNDEFINED, NULL, FALSE, TRUE, WORD, UINT8ARRAY, EMPTY_STRING, STRING, UINT7, FLOAT64, DATE, SIGNATURE, DUPLE, EMPTY_ARRAY, ARRAY, EMPTY_OBJECT, OBJECT, VARIABLE, EMPTY_UINT8ARRAY }
}
