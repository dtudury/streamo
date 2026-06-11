/**
 * @file CodecRegistry — codec dispatcher on top of Addressifier.
 *
 * Resolves bytes ↔ JS values via a registered codec table; chunks identify
 * their codec by their last byte (the footer). Public read APIs (asRefs,
 * decode) are mutation-impossible by construction — not by a flag the
 * caller could flip, but by which `r` (registry interface) the entry
 * point dispatches with. `#readOnlyR` has no `append`, so the codec
 * helpers that materialize inline parts as chunks (getPartAddress)
 * return undefined rather than mutate.
 *
 * See design.md §3–4.
 */
import { Addressifier } from './Addressifier.js'
import { makeCodecs } from './codecs.js'
import { Variable } from './Variable.js'
import { numberToVar, varToNumber } from './utils.js'

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
  decode (codeOrAddressOrVariable, asRefs = false) {
    return this.#decodeWith(this.#readWriteR, codeOrAddressOrVariable, asRefs)
  }

  #decodeWith (r, codeOrAddressOrVariable, asRefs) {
    let code
    if (codeOrAddressOrVariable instanceof Variable) {
      code = codeOrAddressOrVariable.resolve(r)
    } else if (typeof codeOrAddressOrVariable === 'number') {
      code = this.resolve(codeOrAddressOrVariable)
    } else {
      code = codeOrAddressOrVariable
    }
    if (!(code instanceof Uint8Array)) throw new Error('expected Uint8Array, address, or Variable')
    const codec = this.footerToCodec[code.at(-1)]
    return codec.decode(r, code, asRefs)
  }

  encode (value, asRefs) {
    if (asRefs && typeof value === 'number') {
      const bytes = this.resolve(value)
      return Variable.addressed(this.footerToCodec[bytes.at(-1)], value)
    }
    for (const name in this.#codecs) {
      const codec = this.#codecs[name]
      const code = codec.encode?.(this.#readWriteR, value, asRefs)
      if (code) return Variable.inline(this.footerToCodec[code.at(-1)], code)
    }
    throw new Error(`no codec for value: ${value}`)
  }

  /**
   * Encode a value as a BOXED (boxed address) so that changing the
   * top-level value is representable as a new append.
   * @param {any} value
   * @returns {Uint8Array}
   */
  encodeVariable (value) {
    const variable = this.encode(value)
    const bytes = variable.isInline ? variable.bytes : variable.resolve(this.#readWriteR)
    return this.#codecs.BOXED._encode(this.#readWriteR, bytes)
  }

  // Mirror of compose. WORD/UINT7 have literal-data parts that aren't
  // child references — flagged via `hasLiteralParts` so callers know
  // decompose alone can't recompose the chunk.
  decompose (variable) {
    const chunkBytes = variable.resolve(this.#readOnlyR)
    const footer = chunkBytes.at(-1)
    const codec = this.footerToCodec[footer]
    if (!codec?.partReaders?.length) return { codec, children: [] }

    const children = []
    let option = footer - codec.baseFooter
    let end = -1
    let hasLiteralParts = false
    for (let i = codec.partReaders.length - 1; i >= 0; i--) {
      const opts = codec.partReaders[i]
      const reader = opts[option % opts.length]
      option = Math.floor(option / opts.length)
      const part = reader(this.#readOnlyR, chunkBytes.subarray(0, end))
      end -= part.width
      if (part.address !== undefined) {
        const childBytes = this.resolve(part.address)
        const childCodec = this.footerToCodec[childBytes.at(-1)]
        children.unshift(Variable.addressed(childCodec, part.address))
      } else if (part.getCode) {
        const childBytes = part.getCode()
        const childCodec = this.footerToCodec[childBytes.at(-1)]
        children.unshift(Variable.inline(childCodec, childBytes))
      } else {
        // Literal-data part — embedded bytes, not a child reference
        hasLiteralParts = true
      }
    }
    return { codec, children, hasLiteralParts }
  }

  // Assemble a chunk from children whose inline/addressed state is
  // already decided. Returns inline; caller opts into materialize.
  compose (codec, children) {
    if (!codec.partReaders?.length) {
      if (children.length !== 0) throw new Error('codec has no parts; expected empty children')
      return Variable.inline(codec, new Uint8Array([codec.baseFooter]))
    }
    if (children.length !== codec.partReaders.length) {
      throw new Error(`compose: codec wants ${codec.partReaders.length} children, got ${children.length}`)
    }
    let footer = codec.baseFooter
    let base = 1
    const parts = []
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      let partBytes, option
      if (child.isInline) {
        partBytes = child.bytes
        option = 0
      } else if (child.isAddressed) {
        partBytes = numberToVar(child.address)
        option = partBytes.length
      } else {
        throw new Error('compose: child Variable has neither bytes nor address')
      }
      footer += base * option
      base *= codec.partReaders[i].length
      parts.unshift(partBytes)
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) + 1)
    let pos = 0
    for (const p of parts) { out.set(p, pos); pos += p.length }
    out[pos] = footer
    return Variable.inline(codec, out)
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
  // Default (materialize=false): inline children come back as `undefined`
  // (no separate address; bytes live in the parent chunk). The readOnly
  // R sees no `append`, so mutation is unreachable by control flow.
  //
  // materialize=true: inline children get appended to this and surface as
  // real addresses. Used by Streamo.set/setRefs during write-side path
  // traversal, where the mutation is part of the same write op anyway.
  asRefs (address, materialize = false) {
    const code = this.resolve(address)
    const { type } = this.footerToCodec[code.at(-1)]
    if (type === 'BOXED' ||
        type === 'OBJECT' || type === 'EMPTY_OBJECT' ||
        type === 'ARRAY'  || type === 'EMPTY_ARRAY') {
      return materialize
        ? this.#decodeWith(this.#readWriteR, address, true)
        : this.#decodeWith(this.#readOnlyR, address, true)
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

  // Three branches:
  //   1. shared region   → addressed && address ≤ sharedThrough; return as-is
  //   2. inline          → decode + re-encode in this's state
  //   3. addressed/new   → dedup-or-recurse; recursion: decompose, copyFrom each child, compose, materialize
  // Leaf-data chunks (WORD, UINT7) bail to decode + re-encode — decompose can't surface their literal bytes as children.
  // Negative-address primitives are universal across registries.
  copyFrom (source, sourceOrAddress, sharedThrough = -1) {
    let sourceVariable
    if (typeof sourceOrAddress === 'number') {
      if (sourceOrAddress < 0) {
        const byte = -sourceOrAddress - 1
        return Variable.addressed(source.footerToCodec[byte], sourceOrAddress)
      }
      const sourceBytes = source.resolve(sourceOrAddress)
      const codec = source.footerToCodec[sourceBytes.at(-1)]
      sourceVariable = Variable.addressed(codec, sourceOrAddress)
    } else if (sourceOrAddress instanceof Variable) {
      sourceVariable = sourceOrAddress
    } else {
      throw new Error('copyFrom: expected number or Variable')
    }

    if (sourceVariable.isAddressed && sourceVariable.address <= sharedThrough) {
      return sourceVariable
    }
    if (sourceVariable.isInline) {
      const value = source.decode(sourceVariable.bytes)
      return this.encode(value)
    }
    // Cannot dedup by addressOf(sourceBytes) — those bytes carry SOURCE-side
    // internal addresses that may collide with this-side chunks of different
    // content. Real dedup happens in the final materialize.
    const { codec, children, hasLiteralParts } = source.decompose(sourceVariable)
    if (hasLiteralParts) {
      const value = source.decode(sourceVariable.address)
      return this.encode(value).materialize(this)
    }
    // Walk children in REVERSE to match encodeMultipart's order: child
    // encoding order determines child addresses, which determine varint
    // widths in the parent's encoding, which determine bit-identity with
    // fresh encode.
    const newChildren = new Array(children.length)
    for (let i = children.length - 1; i >= 0; i--) {
      newChildren[i] = this.copyFrom(source, children[i], sharedThrough)
    }
    return this.compose(codec, newChildren).materialize(this.#readWriteR)
  }

  /**
   * Appends a compound code by splitting into constituent subcodes
   * (back-to-front, footer-determined widths) and appending each
   * independently. Returns the address of the outermost subcode.
   *
   * Throws on Variable — use `variable.materialize(r)`.
   */
  append (code) {
    if (code instanceof Variable) {
      throw new Error('cannot append a Variable directly; use variable.materialize(r)')
    }
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
