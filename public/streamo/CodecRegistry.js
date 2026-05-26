/**
 * @file CodecRegistry — codec dispatcher on top of Addressifier.
 *
 * Resolves bytes ↔ JS values via a registered codec table; chunks identify
 * their codec by their last byte (the footer). Public read APIs (asRefs,
 * directReferences, decode) are mutation-impossible by construction —
 * not by a flag the caller could flip, but by which `r` (registry
 * interface) the entry point dispatches with. `#readOnlyR` has no
 * `append`, so the codec helpers that materialize inline parts as
 * chunks (getPartAddress) return undefined rather than mutate.
 *
 * See design.md §3–4.
 */
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
 * Codecs are built by makeCodecs() in codecs.js and wired in here. Each
 * codec's encode/decode takes `r` as a leading argument; this class
 * builds two `r` flavors and dispatches the right one per entry point.
 */
export class CodecRegistry extends Addressifier {
  /** @type {Array} footer → codec */
  footerToCodec = []

  #codecs
  #readWriteR
  #readOnlyR

  constructor () {
    super()
    this.#codecs = makeCodecs()
    // Two r flavors share the same backing registry. #readOnlyR has no
    // `append`, which is the only difference — helpers that would
    // materialize inline parts as chunks check `if (!r.append) return
    // undefined` and yield instead of mutating. The `decode` on each
    // closes over its own r so recursion through composite values stays
    // in the same policy mode.
    const self = this
    this.#readWriteR = {
      encode: (v, asRefs) => self.encode(v, asRefs),
      decode: (code, asRefs) => self.#decodeWith(self.#readWriteR, code, asRefs),
      append: code => self.#appendSubcode(code),
      resolve: addr => self.resolve(addr),
      addressOf: code => self.addressOf(code),
      get byteLength () { return self.byteLength },
      footerToCodec: this.footerToCodec
    }
    this.#readOnlyR = {
      encode: (v, asRefs) => self.encode(v, asRefs),
      decode: (code, asRefs) => self.#decodeWith(self.#readOnlyR, code, asRefs),
      // append intentionally absent — getPartAddress falls back to undefined
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
    return this.#decodeWith(this.#readWriteR, codeOrAddress, asRefs)
  }

  #decodeWith (r, codeOrAddress, asRefs) {
    const code = typeof codeOrAddress === 'number'
      ? this.resolve(codeOrAddress)
      : codeOrAddress
    if (!(code instanceof Uint8Array)) throw new Error('expected Uint8Array')
    const codec = this.footerToCodec[code.at(-1)]
    return codec.decode(r, code, asRefs)
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
      const code = codec.encode?.(this.#readWriteR, value, asRefs)
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
    return this.#codecs.VARIABLE._encode(this.#readWriteR, this.encode(value))
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
      // Decode through #readOnlyR — codec helpers see no `append` and
      // return undefined for inline parts instead of materializing
      // them as chunks. Mutation is unreachable here by control flow,
      // not by caller discipline.
      return this.#decodeWith(this.#readOnlyR, address, true)
    }
    return address
  }

  /**
   * Direct chunk-graph references — the addresses this chunk's bytes point
   * to (NOT the user-level child values asRefs returns). Walks the codec's
   * parts: addressed parts contribute their target address; inline parts
   * are skipped (their bytes are embedded in this chunk, no separate
   * address). Pure read; never mutates.
   *
   * What you see varies by codec:
   *   - DUPLE   → up to 2 references (left, right)
   *   - OBJECT/ARRAY/VARIABLE → 1 reference (the embedded Duple-tree or
   *                              wrapped value, when stored separately)
   *   - STRING/UINT8ARRAY/DATE/FLOAT64 → 1 reference (the encoded bytes,
   *                                       when stored separately)
   *   - WORD, UINT7, EMPTY_*, primitives → none
   *   - SIGNATURE → none (its parts are data, not chunk references)
   *
   * Used by the explorer's storage tab to walk the chunk graph.
   *
   * @param {number} address
   * @returns {number[]}
   */
  directReferences (address) {
    const code = this.resolve(address)
    const codec = this.footerToCodec[code.at(-1)]
    if (!codec?.partReaders?.length) return []

    const refs = []
    const footer = code.at(-1)
    let option = footer - codec.baseFooter
    let end = -1
    for (let i = codec.partReaders.length - 1; i >= 0; i--) {
      const opts = codec.partReaders[i]
      const reader = opts[option % opts.length]
      option = Math.floor(option / opts.length)
      const part = reader(this.#readOnlyR, code.subarray(0, end))
      end -= part.width
      if (part.address !== undefined) refs.unshift(part.address)
    }
    return refs
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
        if (address < 0) return undefined // primitive — can't descend
        const refs = this.asRefs(address)
        if (refs === address) return undefined // non-composite at this level
        const key = path[i]
        if (!(key in refs)) return undefined
        const next = refs[key]
        if (next === undefined) {
          // Inline child: asRefs returned undefined because the bytes live
          // inside the parent chunk, no separate slot. Full-decode at this
          // level and walk the rest in JS.
          let value = this.decode(address)
          for (let j = i; j < path.length; j++) {
            if (value == null) return undefined
            value = value[path[j]]
          }
          return value
        }
        address = next
      }
      // Path consumed. Decode the leaf.
      if (address < 0) {
        // Negative address encodes a single-byte primitive — recover the
        // original byte and decode it as a one-byte chunk.
        return this.decode(new Uint8Array([-address - 1]))
      }
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
    const r = this.#readOnlyR  // width-only; never mutates
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
