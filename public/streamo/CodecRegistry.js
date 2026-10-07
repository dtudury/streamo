/**
 * @file CodecRegistry — codec dispatcher on top of Addressifier.
 *
 * Resolves bytes ↔ JS values via a registered codec table; chunks identify
 * their codec by their last byte (the footer). There is one `r`
 * (registry interface), passed to every codec method. There used to be
 * two — a read-only flavour with no `append` — because answering a read
 * could have to materialize an inline part. Every part is an address now,
 * so nothing reads its way into a write and the flavour has no job.
 *
 * See design.md §3–4.
 */
import { Addressifier } from './Addressifier.js'
import { makeCodecs, decodeParts } from './codecs.js'
import { numberToVar, varToNumber } from './utils.js'

/**
 * Extends Addressifier with a codec system.
 *
 * Each stored value is a Uint8Array whose last byte (the footer) identifies
 * its codec. Footers are assigned sequentially as codecs are registered.
 * Multi-part codecs multiply their option counts to produce a footer range
 * (mixed-radix offset from baseFooter).
 *
 * Codecs are built by makeCodecs() in codecs.js and wired in here. Each
 * codec's encode/decode takes `r` as a leading argument; this class
 * builds two `r` flavors and dispatches the right one per entry point.
 */
export class CodecRegistry extends Addressifier {
  /** @type {Array} footer → codec */
  footerToCodec = []

  #codecs
  #r

  constructor () {
    super()
    this.#codecs = makeCodecs()
    const self = this
    this.#r = {
      encode: (v, asRefs) => self.encode(v, asRefs),
      decode: (code, asRefs) => self.#decodeWith(self.#r, code, asRefs),
      append: code => self.#appendSubcode(code),
      resolve: addr => self.resolve(addr),
      addressOf: code => self.addressOf(code),
      get byteLength () { return self.byteLength },
      footerToCodec: this.footerToCodec
    }
    this.#registerAll()
  }

  // Re-expose byteLength so subclasses can override it
  get byteLength () { return super.byteLength }

  /**
   * Decode any JS value from a code (Uint8Array) or an address (number).
   * @param {Uint8Array|number} codeOrAddress
   * @param {boolean|boolean[]} [asRefs=false]
   * @returns {any}
   */
  decode (codeOrAddress, asRefs = false) {
    return this.#decodeWith(this.#r, codeOrAddress, asRefs)
  }

  #decodeWith (r, codeOrAddress, asRefs) {
    const code = typeof codeOrAddress === 'number' ? this.resolve(codeOrAddress) : codeOrAddress
    if (!(code instanceof Uint8Array)) throw new Error('expected a Uint8Array or an address')
    const codec = this.footerToCodec[code.at(-1)]
    return codec.decode(r, code, asRefs)
  }

  encode (value, asRefs) {
    // An address under asRefs is already the encoding of that value.
    if (asRefs && typeof value === 'number') return value
    for (const name in this.#codecs) {
      const codec = this.#codecs[name]
      const code = codec.encode?.(this.#r, value, asRefs)
      if (code) return this.#appendSubcode(code)
    }
    throw new Error(`no codec for value: ${value}`)
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
   * Every part is an address, so this never has to store anything to answer.
   * It took a `materialize` flag until 2026-10-06: an inline child had no
   * separate address, and the only way to hand one back was to append it
   * mid-read. With inline parts gone both arms of that branch had become the
   * same expression, so the flag was deciding nothing.
   *
   * @param {number} address
   * @returns {Object|Array|number}
   */
  asRefs (address) {
    const code = this.resolve(address)
    const { type } = this.footerToCodec[code.at(-1)]
    if (type === 'OBJECT' || type === 'EMPTY_OBJECT' ||
        type === 'ARRAY' || type === 'EMPTY_ARRAY') {
      return this.#decodeWith(this.#r, address, true)
    }
    return address
  }

  /**
   * Decode the value at `address`, descending lazily into composite children
   * along `path`. Only the chunks the path actually touches are decoded;
   * sibling subtrees are skipped entirely. O(depth) instead of O(record).
   *
   * The walk uses `asRefs(address)` at each step to follow addressed
   * children without materializing them as JS values. When a path element
   * lands on an **inline** child (asRefs can't give a separate address —
   * the bytes are embedded in the parent chunk), this falls back to a full
   * `decode(address)` at that level and walks the remainder of the path
   * through the resulting JS value. Correctness preserved; the fallback
   * is rare for records at any scale because the encoder addresses any
   * child whose code is longer than a varint of the next address.
   *
   * No reactive bookkeeping happens here — this is the pure codec layer.
   * Callers (Streamo.get / StreamoRecord.get) register their own deps.
   *
   * @param {number} address  Starting address. Must be >= 0.
   * @param {...(string|number)} path  Keys to descend through.
   * @returns {any}
   */
  decodeAt (address, ...path) {
    try {
      for (let i = 0; i < path.length; i++) {
        const refs = this.asRefs(address)
        if (refs === address) return undefined // non-composite at this level
        const key = path[i]
        if (!(key in refs)) return undefined
        address = refs[key]
      }
      // Path consumed. Decode the leaf.
      return this.decode(address)
    } catch (err) {
      // Defensive: during origin-sync's initial replay, the recaller fires
      // reactive readers on every chunk arrival. A chunk's referenced inner
      // chunks may not be appended yet at the moment a watcher runs — the
      // resolve() call throws a TypeError on the missing address. Treat
      // that as "value at this path isn't fully decodable right now"; the
      // watcher re-runs when more bytes land and the read succeeds. Real
      // shape-mismatch bugs in writers are caught at the encode site, not
      // here; this catch only papers over the in-flight-replay race that
      // would otherwise kill the process the first time an author-mode
      // client subscribes to a populated relay.
      if (err instanceof TypeError && /uint8Array|Cannot read properties of undefined/.test(err.message)) {
        return undefined
      }
      throw err
    }
  }

  /**
   * Copy the value at `sourceAddress` out of `source` into this registry, and
   * return its address here. Bit-identical to encoding the same value fresh,
   * which is what makes the result canonical and dedup-able.
   *
   * Descends the CHUNK GRAPH, not the decoded value. Each chunk's parts are
   * read with `decodeParts`; a part is either an address (recurse into it) or
   * literal data embedded in this chunk (WORD/UINT7/OPAQUE payloads), which
   * cannot be copied piecewise.
   *
   * `asRefs` is the wrong instrument here, and it is worth saying why because
   * it looks right: it returns SEMANTIC children, so a DUPLE tree comes back
   * flattened and re-encoding rebuilds the tree in a different order than the
   * one that produced it. Tried 2026-10-07 — 91 of 107 bit-identity cases,
   * failing at N=1 and at every 2^k+1 above 32, where the tree is most
   * lopsided.
   *
   * `sharedThrough` is the last address this registry and `source` are known
   * to agree on. At or below it an address means the same thing in both, so it
   * carries over untouched and whole unchanged subtrees cost nothing — which
   * is the entire point of copyFrom over decode-then-re-encode.
   *
   * @param {CodecRegistry} source
   * @param {number} sourceAddress
   * @param {number} [sharedThrough=-1]
   * @returns {number} the address in THIS registry
   */
  copyFrom (source, sourceAddress, sharedThrough = -1) {
    if (typeof sourceAddress !== 'number') {
      throw new Error('copyFrom: expected an address')
    }
    if (sourceAddress <= sharedThrough) return sourceAddress

    const bytes = source.resolve(sourceAddress)
    const codec = source.footerToCodec[bytes.at(-1)]
    const parts = decodeParts(source.#r, bytes)

    // Nothing to descend into, or a part that is not a reference: decode the
    // value and re-encode it in this registry's state. Cannot dedup by
    // addressOf(bytes) first — those bytes carry SOURCE-side addresses, which
    // may collide with this-side chunks of different content.
    if (!parts.length || parts.some(part => part.address === undefined)) {
      return this.encode(source.decode(sourceAddress))
    }

    // Copy children in REVERSE: that is the order encodeMultipart appends
    // them, their order sets their addresses, their addresses set the varint
    // widths in this chunk, and those widths are what bit-identity means.
    const copied = new Array(parts.length)
    for (let i = parts.length - 1; i >= 0; i--) {
      copied[i] = this.copyFrom(source, parts[i].address, sharedThrough)
    }

    // Rebuild this chunk pointing at the copies. The footer is a mixed-radix
    // offset from baseFooter over each part's option index, exactly as
    // encodeMultipart builds it. Codec tables are identical across registries
    // — makeCodecs() runs in the same order everywhere — so the source's
    // baseFooter and part-option counts are this registry's too.
    let footer = codec.baseFooter
    let base = 1
    const partBytes = new Array(parts.length)
    for (let i = parts.length - 1; i >= 0; i--) {
      const addrBytes = numberToVar(copied[i])
      partBytes[i] = addrBytes
      footer += base * (addrBytes.length - 1) // option 0..3 → a 1..4-byte address
      base *= codec.partReaders[i].length
    }
    const out = new Uint8Array(partBytes.reduce((n, p) => n + p.length, 0) + 1)
    let pos = 0
    for (const p of partBytes) { out.set(p, pos); pos += p.length }
    out[pos] = footer
    return this.#appendSubcode(out)
  }

  /**
   * Appends a compound code by splitting into constituent subcodes
   * (back-to-front, footer-determined widths) and appending each
   * independently. Returns the address of the outermost subcode.
   *
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
    // EXPERIMENT 2026-10-06 (David): the split already happens here, so the
    // duplicate check belongs here too. Index each subcode at the address it
    // WILL have, then hand the whole code to super.append as one chunk.
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

  // Internal append used by codecs (single chunk, no splitting)
  #appendSubcode (code) {
    const existing = this.addressOf(code)
    if (existing !== undefined) return existing
    const address = super.append(code)
    this._index(code, address)
    return address
  }

  #registerAll () {
    const r = this.#r // registration reads widths only
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
            const part = opts[option % opts.length](r, code.subarray(0, -total))
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
