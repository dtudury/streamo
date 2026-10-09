import { Addressifier } from './Addressifier.js'
import { makeCodecs, decodeParts } from './codecs.js'
import { numberToVar } from './utils.js'

export class CodecRegistry extends Addressifier {
  footerToCodec = []

  #codecs

  constructor () {
    super()
    this.#codecs = makeCodecs()
    this.#registerAll()
  }

  get byteLength () { return super.byteLength }

  decode (codeOrAddress, asRefs = false) {
    const code = typeof codeOrAddress === 'number' ? this.resolve(codeOrAddress) : codeOrAddress
    if (!(code instanceof Uint8Array)) throw new Error('expected a Uint8Array or an address')
    const codec = this.footerToCodec[code.at(-1)]
    return codec.decode(this, code, asRefs)
  }

  encode (value, asRefs) {
    if (asRefs && typeof value === 'number') return value
    for (const name in this.#codecs) {
      const codec = this.#codecs[name]
      const code = codec.encode?.(this, value, asRefs)
      if (code) return this.appendChunk(code)
    }
    throw new Error(`no codec for value: ${value}`)
  }

  asRefs (address) {
    const code = this.resolve(address)
    const { type } = this.footerToCodec[code.at(-1)]
    if (type === 'OBJECT' || type === 'EMPTY_OBJECT' ||
        type === 'ARRAY' || type === 'EMPTY_ARRAY' || type === 'SINGLE_ARRAY') {
      return this.decode(address, true)
    }
    return address
  }

  decodeAt (address, ...path) {
    try {
      for (let i = 0; i < path.length; i++) {
        const refs = this.asRefs(address)
        if (refs === address) return undefined
        const key = path[i]
        if (!(key in refs)) return undefined
        address = refs[key]
      }
      return this.decode(address)
    } catch (err) {
      if (err instanceof TypeError && /uint8Array|Cannot read properties of undefined/.test(err.message)) {
        return undefined
      }
      throw err
    }
  }

  copyFrom (source, sourceAddress, sharedThrough = -1) {
    if (typeof sourceAddress !== 'number') {
      throw new Error('copyFrom: expected an address')
    }
    if (sourceAddress <= sharedThrough) return sourceAddress

    const bytes = source.resolve(sourceAddress)
    const codec = source.footerToCodec[bytes.at(-1)]
    const parts = decodeParts(source, bytes)

    if (!parts.length || parts.some(part => part.address === undefined)) {
      return this.encode(source.decode(sourceAddress))
    }

    const copied = new Array(parts.length)
    for (let i = parts.length - 1; i >= 0; i--) {
      copied[i] = this.copyFrom(source, parts[i].address, sharedThrough)
    }

    let footer = codec.baseFooter
    let base = 1
    const partBytes = new Array(parts.length)
    for (let i = parts.length - 1; i >= 0; i--) {
      const addrBytes = numberToVar(copied[i])
      partBytes[i] = addrBytes
      footer += base * (addrBytes.length - 1)
      base *= codec.partReaders[i].length
    }
    const out = new Uint8Array(partBytes.reduce((n, p) => n + p.length, 0) + 1)
    let pos = 0
    for (const p of partBytes) { out.set(p, pos); pos += p.length }
    out[pos] = footer
    return this.appendChunk(out)
  }

  append (code) {
    const subcodes = []
    let rest = code
    while (rest.length) {
      const codec = this.footerToCodec[rest.at(-1)]
      const width = codec.getWidth(rest)
      subcodes.unshift(rest.subarray(-width))
      rest = rest.subarray(0, -width)
    }
    let last = -1
    for (const sub of subcodes) {
      if (this.addressOf(sub) !== undefined) {
        throw new Error(`chunk already exists (subcode ending at ${this.byteLength + sub.length - 1})`)
      }
      last = super.append(sub)
      this._index(sub, last)
    }
    return last
  }

  appendChunk (code) {
    const existing = this.addressOf(code)
    if (existing !== undefined) return existing
    const address = super.append(code)
    this._index(code, address)
    return address
  }

  #registerAll () {
    for (const name in this.#codecs) {
      const codec = this.#codecs[name]
      codec.type = name
      codec.baseFooter = this.footerToCodec.length
      if (!codec.getWidth) {
        codec.getWidth = code => {
          const footer = code.at(-1)
          const c = this.footerToCodec[footer]
          if (!c?.partReaders?.length) return 1
          let option = footer - c.baseFooter
          let total = 1
          for (let i = c.partReaders.length - 1; i >= 0; i--) {
            const opts = c.partReaders[i]
            const part = opts[option % opts.length](this, code.subarray(0, -total))
            total += part.width
            option = Math.floor(option / opts.length)
          }
          return total
        }
      }
      const options = (codec.partReaders ?? []).reduce((n, opts) => n * opts.length, 1)
      for (let i = 0; i < options; i++) this.footerToCodec.push(codec)
    }
  }
}
