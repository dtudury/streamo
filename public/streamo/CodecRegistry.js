import { Addressifier } from './Addressifier.js'
import { makeCodecs } from './codecs.js'

/**
 * Extends Addressifier with a codec system.
 *
 * Each stored value is a Uint8Array whose last byte (the footer) identifies
 * its codec. Footers are assigned sequentially as codecs are registered.
 * Multi-part codecs multiply their option counts to produce a footer range
 * (mixed-radix offset from baseFooter).
 *
 * Negative addresses encode single-byte primitive values without appending:
 *   address = -(footer + 1)   →   footer = -address - 1
 * So UNDEFINED, NULL, FALSE, TRUE, and every UINT7 value are addressable
 * without touching the store.
 *
 * Codecs are built by makeCodecs() in codecs.js and wired in here.
 */
export class CodecRegistry extends Addressifier {
  /** @type {Array} footer → codec */
  footerToCodec = []

  #codecs
  // Depth counter for read-only mode. asRefs() increments this around the
  // decode call so that codec-level helpers (specifically getPartAddress in
  // codecs.js) know NOT to materialize inline children by appending. When
  // > 0, any code path that would have mutated the store returns undefined
  // instead. Write paths (Streamo.set / setRefs) bypass asRefs and call
  // decode(addr, true) directly so this counter stays 0 — mutation allowed.
  #readOnly = 0

  constructor () {
    super()
    const self = this
    this.#codecs = makeCodecs({
      encode: (v, asRefs) => self.encode(v, asRefs),
      decode: (code, asRefs) => self.decode(code, asRefs),
      append: code => self.#appendSubcode(code),
      resolve: addr => self.resolve(addr),
      addressOf: code => self.addressOf(code),
      get byteLength () { return self.byteLength },
      get readOnly () { return self.#readOnly > 0 },
      footerToCodec: this.footerToCodec
    })
    this.#registerAll()
  }

  // Re-expose byteLength so subclasses can override it
  get byteLength () { return super.byteLength }

  /**
   * Resolve an address to its Uint8Array.
   * Negative addresses map to single-byte codes: -(footer+1) → [footer].
   * @param {number} address
   * @returns {Uint8Array}
   */
  resolve (address) {
    if (address < 0) return new Uint8Array([-address - 1])
    return super.resolve(address)
  }

  /**
   * Decode any JS value from a code (Uint8Array) or address (number).
   * @param {Uint8Array|number} codeOrAddress
   * @param {boolean|boolean[]} [asRefs=false]
   * @returns {any}
   */
  decode (codeOrAddress, asRefs = false) {
    const code = typeof codeOrAddress === 'number'
      ? this.resolve(codeOrAddress)
      : codeOrAddress
    if (!(code instanceof Uint8Array)) throw new Error('expected Uint8Array')
    const codec = this.footerToCodec[code.at(-1)]
    return codec.decode(code, asRefs)
  }

  /**
   * Encode a JS value to a Uint8Array.
   *
   * When `asRefs` is truthy and `value` is a number it is treated as an
   * address and resolved directly — this is the inverse of asRefs(), letting
   * callers round-trip through asRefs → encode without deserialising subtrees.
   *
   * @param {any} value
   * @param {boolean|boolean[]|string} [asRefs]
   * @returns {Uint8Array}
   */
  encode (value, asRefs) {
    if (asRefs && typeof value === 'number') return this.resolve(value)
    for (const name in this.#codecs) {
      const codec = this.#codecs[name]
      const code = codec.encode?.(value, asRefs)
      if (code) return code
    }
    throw new Error(`no codec for value: ${value}`)
  }

  /**
   * Encode a value as a VARIABLE (boxed address) so that changing the
   * top-level value is representable as a new append.
   * @param {any} value
   * @returns {Uint8Array}
   */
  encodeVariable (value) {
    return this.#codecs.VARIABLE._encode(this.encode(value))
  }

  /**
   * Return the immediate children of the value at `address` as addresses
   * rather than decoded values:
   *   Object → { key: valueAddress }  (names stay as strings)
   *   Array  → [ addr0, addr1, … ]
   *   Other  → address itself
   *
   * Useful for structural comparison without fully deserialising large trees.
   *
   * @param {number} address
   * @returns {Object|Array|number}
   */
  asRefs (address) {
    const code = this.resolve(address)
    const { type } = this.footerToCodec[code.at(-1)]
    if (type === 'VARIABLE' ||
        type === 'OBJECT' || type === 'EMPTY_OBJECT' ||
        type === 'ARRAY'  || type === 'EMPTY_ARRAY') {
      // Pure read: enter read-only mode for the duration of the decode so
      // codecs cannot append inline children. Inline addresses come back
      // as `undefined`; callers handle that case (e.g. by showing the
      // child without a clickable link). Math-impossible to mutate from
      // here regardless of caller — protection is in the function.
      this.#readOnly++
      try { return this.decode(address, true) }
      finally { this.#readOnly-- }
    }
    return address
  }

  /**
   * Internal: like asRefs but materializes inline children when needed
   * (write context). Used by Streamo.set / setRefs during path traversal,
   * which DOES need real addresses to navigate composite values; and the
   * mutation it triggers is part of the same write op anyway. Public callers
   * should use asRefs (above), which is mutation-impossible.
   * @param {number} address
   * @returns {Object|Array|number}
   */
  _asRefsForWrite (address) {
    const code = this.resolve(address)
    const { type } = this.footerToCodec[code.at(-1)]
    if (type === 'VARIABLE' ||
        type === 'OBJECT' || type === 'EMPTY_OBJECT' ||
        type === 'ARRAY'  || type === 'EMPTY_ARRAY') {
      return this.decode(address, true)
    }
    return address
  }

  /**
   * Copy a value from another CodecRegistry into this one by address.
   * Uses asRefs to traverse structure level-by-level, avoiding full JS
   * deserialization of composite values. Negative addresses (single-byte
   * primitives) are universal and returned as-is.
   *
   * @param {CodecRegistry} source
   * @param {number} address
   * @returns {number} address of the value in this registry
   */
  copyFrom (source, address) {
    if (address < 0) return address // universal: same footer in any registry
    const value = source.decode(address)
    const newCode = this.encode(value)
    return this.addressOf(newCode) ?? this.append(newCode)
  }

  /**
   * Appends a compound code by first splitting it into constituent subcodes
   * (back-to-front, footer-determined widths) and appending each independently.
   * Returns the address of the outermost subcode.
   * @param {Uint8Array} code
   * @returns {number}
   */
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
      const existing = this.addressOf(sub)
      last = existing !== undefined ? existing : super.append(sub)
    }
    return last
  }

  // Internal append used by codecs (single chunk, no splitting)
  #appendSubcode (code) {
    if (this.addressOf(code) !== undefined) return this.addressOf(code)
    return super.append(code)
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
            const part = opts[option % opts.length](code.subarray(0, -total))
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
