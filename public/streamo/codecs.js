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
    return [
      this.v[0] instanceof Duple ? this.v[0].flat() : this.v[0],
      this.v[1] instanceof Duple ? this.v[1].flat() : this.v[1]
    ].flat()
  }

  flatDuples () {
    const bothDuple = this.v.every(v => v instanceof Duple)
    const noDuple = this.v.every(v => !(v instanceof Duple))
    if (bothDuple) return [...this.v[0].flatDuples(), ...this.v[1].flatDuples()]
    if (noDuple) return [this]
    throw new Error('mixed Duple tree')
  }
}

/**
 * Build all codecs for a CodecRegistry.
 *
 * Each codec is an object with:
 *   type         — string name
 *   baseFooter   — set by the registry after registration
 *   partReaders  — optional array of option-arrays (see below)
 *   getWidth     — optional override; defaults to sum of part widths + 1
 *   encode(v)    — returns Uint8Array or falsy
 *   decode(code, asRefs) — returns the JS value
 *
 * The registry is passed as `r` so codecs can call r.encode / r.decode /
 * r.append / r.resolve for sub-values.
 *
 * @param {object} r  registry interface: { encode, decode, append, resolve, addressOf, footerToCodec }
 * @returns {Array} codec definitions in registration order
 */
export function makeCodecs (r) {
  // ── Part reader factories ────────────────────────────────────────────────
  // A partReader is a function (code: Uint8Array) → { type, width, address?, getCode?, getDecoded }

  const inlineReader = [code => {
    const codec = r.footerToCodec[code.at(-1)]
    const width = codec.getWidth(code)
    return {
      type: `inline(${width})`,
      width,
      getCode: () => code.slice(-width),
      getDecoded: asRefs => r.decode(code.slice(-width), asRefs)
    }
  }]

  const addressReaders = range(4).map(i => code => {
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

  const inlineOrAddress = [...inlineReader, ...addressReaders] // 5 options: option 0 = inline, 1-4 = 1..4-byte address

  const wordReaders = range(4).map(i => code => {
    const width = i + 1
    return { type: `word(${width})`, width, getDecoded: () => code.slice(-width) }
  })

  const literalReaders = range(5).map(width => code => ({
    type: `literal(${width})`,
    width,
    getDecoded: () => code.slice(-width)
  }))

  const signatureReader = [code => ({
    type: 'sig(64)',
    width: 64,
    getDecoded: () => code.slice(-64)
  })]

  const uint7Readers = range(128).map(n => () => ({
    type: `uint7(${n})`,
    width: 0,
    getDecoded: () => new Uint8Array([n])
  }))

  // ── Shared helper ────────────────────────────────────────────────────────

  /**
   * Ensure `code` is stored and return [partBytes, optionIndex].
   * Option 0: inline (just the raw bytes).
   * Options 1-4: 1-4-byte little-endian address.
   */
  function inlineOrAddressPart (code) {
    const existingAddr = r.addressOf(code)
    const nextAddr = Math.max(0, r.byteLength + code.length - 1)
    if (existingAddr === undefined && code.length <= numberToVar(nextAddr).length) {
      return [code, 0]
    }
    const addr = existingAddr ?? r.append(code)
    const addrBytes = numberToVar(addr)
    return [addrBytes, addrBytes.length] // option = 1..4
  }

  function encodeMultipart (values, codec, asRefs) {
    if (values.length !== codec.partReaders.length) throw new Error('part count mismatch')
    const parts = []
    let base = 1
    let footer = codec.baseFooter
    for (let i = values.length - 1; i >= 0; i--) {
      const [part, option] = inlineOrAddressPart(r.encode(values[i], asRefs))
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

  function decodeParts (code) {
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
      const part = reader(code.subarray(0, end))
      end -= part.width
      parts.unshift(part)
    }
    return parts
  }

  // Stable address of a single-part value (needed for DUPLE decode with asRefs)
  function getPartAddress (part) {
    if (part.address !== undefined) return part.address
    const code = part.getCode()
    if (code.length === 1) return -(code[0] + 1) // negative address for single-byte primitives
    return r.addressOf(code) ?? r.append(code)
  }

  // ── Codec definitions ────────────────────────────────────────────────────

  const UNDEFINED = {
    encode: v => v === undefined && new Uint8Array([UNDEFINED.baseFooter]),
    decode: () => undefined
  }

  const NULL = {
    encode: v => v === null && new Uint8Array([NULL.baseFooter]),
    decode: () => null
  }

  const FALSE = {
    encode: v => v === false && new Uint8Array([FALSE.baseFooter]),
    decode: () => false
  }

  const TRUE = {
    encode: v => v === true && new Uint8Array([TRUE.baseFooter]),
    decode: () => true
  }

  /** ≤4-byte Uint8Array stored literally */
  const WORD = {
    partReaders: [literalReaders],
    encode (v) {
      if (v instanceof Uint8Array && v.length >= 1 && v.length <= 4) {
        const out = new Uint8Array(v.length + 1)
        out.set(v)
        out[v.length] = WORD.baseFooter + v.length
        return out
      }
    },
    decode (code) { return decodeParts(code)[0].getDecoded() }
  }

  /** Arbitrary-length Uint8Array (>4 bytes), stored via Duple tree of WORDs */
  const UINT8ARRAY = {
    partReaders: [inlineOrAddress],
    encode (v) {
      if (v instanceof Uint8Array && v.length > 4) {
        const words = []
        for (let i = 0; i < v.length; i += 4) words.push(v.slice(i, Math.min(i + 4, v.length)))
        return encodeMultipart([new Duple(words)], UINT8ARRAY)
      }
    },
    decode (code) {
      const parts = decodeParts(code)
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
    encode: v => v === '' && new Uint8Array([EMPTY_STRING.baseFooter]),
    decode: () => ''
  }

  const STRING = {
    partReaders: [inlineOrAddress],
    encode (v) {
      if (typeof v === 'string' && v !== '') {
        const bytes = new TextEncoder().encode(v)
        return encodeMultipart([bytes], STRING)
      }
    },
    decode (code) {
      return new TextDecoder().decode(decodeParts(code)[0].getDecoded(false))
    }
  }

  /** Non-negative integer 0..127 */
  const UINT7 = {
    partReaders: [uint7Readers],
    encode (v) {
      if (Number.isInteger(v) && v >= 0 && v < 128) return new Uint8Array([UINT7.baseFooter + v])
    },
    decode (code) { return decodeParts(code)[0].getDecoded()[0] }
  }

  const FLOAT64 = {
    partReaders: [inlineOrAddress],
    encode (v) {
      if (typeof v === 'number') {
        return encodeMultipart([new Uint8Array(new Float64Array([v]).buffer)], FLOAT64)
      }
    },
    decode (code) {
      const bytes = decodeParts(code)[0].getDecoded(false)
      return new Float64Array(bytes.buffer, bytes.byteOffset, 1)[0]
    }
  }

  const DATE = {
    partReaders: [inlineOrAddress],
    encode (v) {
      if (v instanceof Date) {
        return encodeMultipart([new Uint8Array(new Float64Array([v.getTime()]).buffer)], DATE)
      }
    },
    decode (code) {
      const bytes = decodeParts(code)[0].getDecoded(false)
      return new Date(new Float64Array(bytes.buffer, bytes.byteOffset, 1)[0])
    }
  }

  const SIGNATURE = {
    partReaders: [wordReaders, signatureReader],
    encode (v) {
      if (v instanceof Signature) {
        const addrBytes = numberToVar(v.address)
        const out = new Uint8Array(addrBytes.length + 64 + 1)
        out.set(addrBytes)
        out.set(v.compactRawBytes, addrBytes.length)
        out[addrBytes.length + 64] = SIGNATURE.baseFooter + addrBytes.length - 1
        return out
      }
    },
    decode (code) {
      const parts = decodeParts(code)
      return new Signature(varToNumber(parts[0].getDecoded()), parts[1].getDecoded())
    }
  }

  /** Internal balanced binary tree node. Never exposed to callers. */
  const DUPLE = {
    partReaders: [inlineOrAddress, inlineOrAddress],
    encode (v, asRefs) {
      if (v instanceof Duple) return encodeMultipart(v.v, DUPLE, asRefs)
    },
    decode (code, asRefs) {
      const parts = decodeParts(code)
      const leftCode = parts[0].getCode()
      const rightCode = parts[1].getCode()
      const leftIsDuple = r.footerToCodec[leftCode.at(-1)]?.type === 'DUPLE'
      const rightIsDuple = r.footerToCodec[rightCode.at(-1)]?.type === 'DUPLE'
      if (!leftIsDuple && !rightIsDuple) {
        // 'all' means return addresses for both slots (used by array asRefs)
        const nameIsRef = asRefs === 'all' || (Array.isArray(asRefs) && asRefs[1])
        const valueIsRef = asRefs === 'all' || asRefs === true || (Array.isArray(asRefs) && asRefs[0])
        return new Duple([
          nameIsRef ? getPartAddress(parts[0]) : parts[0].getDecoded(false),
          valueIsRef ? getPartAddress(parts[1]) : parts[1].getDecoded(false)
        ])
      }
      // Non-leaf: at least one child is itself a Duple subtree.
      // With 'all', recurse into sub-duples and take the address of any leaf.
      if (asRefs === 'all') {
        return new Duple([
          leftIsDuple ? parts[0].getDecoded('all') : getPartAddress(parts[0]),
          rightIsDuple ? parts[1].getDecoded('all') : getPartAddress(parts[1])
        ])
      }
      return new Duple([parts[0].getDecoded(asRefs), parts[1].getDecoded(asRefs)])
    }
  }

  const EMPTY_ARRAY = {
    encode: v => Array.isArray(v) && v.length === 0 && new Uint8Array([EMPTY_ARRAY.baseFooter]),
    decode: () => []
  }

  const ARRAY = {
    partReaders: [inlineOrAddress],
    encode (v, asRefs) {
      if (!Array.isArray(v) || v.length === 0) return
      if (v.length > 1 && Object.keys(v).length === v.length) {
        return encodeMultipart([new Duple(v)], ARRAY, asRefs)
      }
      // sparse or single-element array: encode as object with length key
      const obj = Object.assign({}, v, { length: v.length })
      return encodeMultipart([obj], ARRAY, asRefs)
    },
    decode (code, asRefs) {
      // 'all' mode: return an address for every element rather than decoded values
      const inner = decodeParts(code)[0].getDecoded(asRefs === true ? 'all' : asRefs)
      if (inner instanceof Duple) return inner.flat()
      return Object.assign([], inner)
    }
  }

  const EMPTY_OBJECT = {
    encode (v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) return
      if (Object.keys(v).length === 0) return new Uint8Array([EMPTY_OBJECT.baseFooter])
    },
    decode: () => ({})
  }

  const OBJECT = {
    partReaders: [inlineOrAddress],
    encode (v, asRefs) {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length === 0) return
      const duples = Object.entries(v).map(([k, val]) => new Duple([k, val]))
      const tree = duples.length === 1 ? duples[0] : new Duple(duples)
      return encodeMultipart([tree], OBJECT, asRefs)
    },
    decode (code, asRefs) {
      const tree = decodeParts(code)[0].getDecoded(asRefs)
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
    _encode (encodedValue) {
      const [part, option] = inlineOrAddressPart(encodedValue)
      const out = new Uint8Array(part.length + 1)
      out.set(part)
      out[part.length] = VARIABLE.baseFooter + option
      return out
    },
    decode (code, asRefs) {
      return decodeParts(code)[0].getDecoded(asRefs)
    }
  }

  return { UNDEFINED, NULL, FALSE, TRUE, WORD, UINT8ARRAY, EMPTY_STRING, STRING, UINT7, FLOAT64, DATE, SIGNATURE, DUPLE, EMPTY_ARRAY, ARRAY, EMPTY_OBJECT, OBJECT, VARIABLE }
}
