import { numberToVar, varToNumber, range } from './utils.js'
import { Opaque } from './Opaque.js'
import { Signature } from './Signature.js'

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

const literalReaders = range(5).map(width => (r, code) => ({
  type: `literal(${width})`,
  width,
  getDecoded: () => code.slice(-width)
}))

const opaqueReaders = range(4).map(index => (r, code) => {
  const lengthWidth = index + 1
  const lengthAt = code.length - lengthWidth
  const length = varToNumber(code.subarray(lengthAt, code.length))
  return {
    type: `opaque(${lengthWidth})`,
    width: lengthWidth + length,
    getDecoded: () => new Uint8Array(code.subarray(lengthAt - length, lengthAt))
  }
})

const uint7Readers = range(128).map(n => () => ({
  type: `uint7(${n})`,
  width: 0,
  getDecoded: () => new Uint8Array([n])
}))

function withFooter (parts, footer) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0) + 1)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  out[out.length - 1] = footer
  return out
}

/** @param {number} address @returns {[Uint8Array, number]} */
function partFromAddress (address) {
  const addrBytes = numberToVar(address)
  return [addrBytes, addrBytes.length - 1]
}

function addressPart (r, code) {
  return partFromAddress(r.addressOf(code) ?? r.append(code))
}

function encodeMultipart (r, values, codec, asRefs) {
  if (values.length !== codec.partReaders.length) throw new Error('part count mismatch')
  const parts = []
  let base = 1
  let footer = codec.baseFooter
  for (let i = values.length - 1; i >= 0; i--) {
    const [part, option] = partFromAddress(r.encode(values[i], asRefs))
    footer += base * option
    base *= codec.partReaders[i].length
    parts.unshift(part)
  }
  return withFooter(parts, footer)
}

export function decodeParts (r, code) {
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

export const isPlainObject = value =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array) &&
  !(value instanceof Date) &&
  !(value instanceof Opaque)

export function makeCodecs () {

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

  const WORD = {
    partReaders: [literalReaders],
    encode (r, v) {
      if (v instanceof Uint8Array && v.length >= 1 && v.length <= 4) {
        return withFooter([v], WORD.baseFooter + v.length)
      }
    },
    decode (r, code) { return decodeParts(r, code)[0].getDecoded() }
  }

  const UINT8ARRAY = {
    partReaders: [addressReaders],
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
    partReaders: [addressReaders],
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

  const UINT7 = {
    partReaders: [uint7Readers],
    encode (r, v) {
      if (Number.isInteger(v) && v >= 0 && v < 128) return new Uint8Array([UINT7.baseFooter + v])
    },
    decode (r, code) { return decodeParts(r, code)[0].getDecoded()[0] }
  }

  const FLOAT64 = {
    partReaders: [addressReaders],
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
    partReaders: [addressReaders],
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
    getWidth: () => 97,
    encode (r, v) {
      if (v instanceof Signature) {
        return withFooter([v.chainHash, v.compactRawBytes], SIGNATURE.baseFooter)
      }
    },
    decode (r, code) {
      return new Signature(code.slice(0, 32), code.slice(32, 96))
    }
  }

  const DUPLE = {
    partReaders: [addressReaders, addressReaders],
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
        const nameIsRef = asRefs === 'all' || (Array.isArray(asRefs) && asRefs[1])
        const valueIsRef = asRefs === 'all' || asRefs === true || (Array.isArray(asRefs) && asRefs[0])
        return new Duple([
          nameIsRef ? parts[0].address : parts[0].getDecoded(false),
          valueIsRef ? parts[1].address : parts[1].getDecoded(false)
        ])
      }
      if (asRefs === 'all') {
        return new Duple([
          leftIsDuple ? parts[0].getDecoded('all') : parts[0].address,
          rightIsDuple ? parts[1].getDecoded('all') : parts[1].address
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
    partReaders: [addressReaders],
    encode (r, v, asRefs) {
      if (!Array.isArray(v) || v.length === 0) return
      if (v.length === 1 && Object.keys(v).length === 1) return
      if (v.length > 1 && Object.keys(v).length === v.length) {
        return encodeMultipart(r, [new Duple(v)], ARRAY, asRefs)
      }
      const length = asRefs ? r.encode(v.length) : v.length
      const obj = Object.assign({}, v, { length })
      return encodeMultipart(r, [obj], ARRAY, asRefs)
    },
    decode (r, code, asRefs) {
      const part = decodeParts(r, code)[0]
      const inner = part.getDecoded(asRefs === true ? 'all' : asRefs)
      if (inner instanceof Duple) return inner.flat()
      if (asRefs === true) {
        const named = part.getDecoded(true)
        const out = new Array(r.decode(named.length))
        for (const [k, v] of Object.entries(named)) {
          if (k !== 'length') out[Number(k)] = v
        }
        return out
      }
      return Object.assign([], inner)
    }
  }

  const EMPTY_OBJECT = {
    encode (r, v) {
      if (!isPlainObject(v)) return
      if (Object.keys(v).length === 0) return new Uint8Array([EMPTY_OBJECT.baseFooter])
    },
    decode: () => ({})
  }

  const OBJECT = {
    partReaders: [addressReaders],
    encode (r, v, asRefs) {
      if (!isPlainObject(v) || Object.keys(v).length === 0) return
      const duples = Object.entries(v).map(([k, val]) => new Duple([k, val]))
      const tree = duples.length === 1 ? duples[0] : new Duple(duples)
      return encodeMultipart(r, [tree], OBJECT, asRefs)
    },
    decode (r, code, asRefs) {
      const tree = decodeParts(r, code)[0].getDecoded(asRefs)
      return Object.fromEntries(tree.flatDuples().map(d => [d.v[0], d.v[1]]))
    }
  }

  const OPAQUE = {
    partReaders: [opaqueReaders],
    encode (r, v) {
      if (!(v instanceof Opaque)) return
      if (v.value.length >= 0x100000000) throw new Error(`Opaque: ${v.value.length} bytes exceeds the 4-byte length a footer option can say`)
      const length = numberToVar(v.value.length)
      return withFooter([v.value, length], OPAQUE.baseFooter + length.length - 1)
    },
    decode (r, code) { return new Opaque(decodeParts(r, code)[0].getDecoded()) }
  }

  const EMPTY_UINT8ARRAY = {
    encode: (r, v) => v instanceof Uint8Array && v.length === 0 && new Uint8Array([EMPTY_UINT8ARRAY.baseFooter]),
    decode: () => new Uint8Array(0)
  }

  const SINGLE_ARRAY = {
    partReaders: [addressReaders],
    encode (r, v, asRefs) {
      if (!Array.isArray(v) || v.length !== 1 || Object.keys(v).length !== 1) return
      return encodeMultipart(r, [v[0]], SINGLE_ARRAY, asRefs)
    },
    decode (r, code, asRefs) {
      const part = decodeParts(r, code)[0]
      if (asRefs === true || asRefs === 'all') return [part.address]
      return [part.getDecoded(asRefs)]
    }
  }

  return { UNDEFINED, NULL, FALSE, TRUE, WORD, UINT8ARRAY, EMPTY_STRING, STRING, UINT7, FLOAT64, DATE, SIGNATURE, DUPLE, EMPTY_ARRAY, ARRAY, EMPTY_OBJECT, OBJECT, EMPTY_UINT8ARRAY, OPAQUE, SINGLE_ARRAY }
}
