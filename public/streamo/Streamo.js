/**
 * @file Streamo — reactive content-addressed signed byte store.
 *
 * Layers Recaller-driven path-level reactivity on top of CodecRegistry,
 * plus a sign/verify API for secp256k1 attestations over a hash-chain
 * accumulator. Each non-signature chunk folds into the accumulator as
 *   acc_{n+1} = sha256(acc_n || sha256(chunk_n))
 * so a SIGNATURE commits to a single 32-byte value that summarizes the
 * entire prefix; a stateless relay can verify the next append knowing
 * only the latest committed accumulator. `valueAddress` skips trailing
 * SIGNATURE chunks so reading the latest value works whether or not it
 * has been auto-signed yet.
 *
 * Exports: Streamo (the class), ConflictError, changedPaths.
 *
 * See design.md §5.
 */
import { Recaller } from './utils/Recaller.js'
import { CodecRegistry } from './CodecRegistry.js'
import { Signature } from './Signature.js'
import { verifySignature } from './Signer.js'

const cryptoSubtle = typeof crypto !== 'undefined' ? crypto.subtle : (await import('crypto')).webcrypto.subtle
async function sha256 (bytes) {
  return new Uint8Array(await cryptoSubtle.digest('SHA-256', bytes))
}
const GENESIS_ACCUMULATOR = new Uint8Array(32) // 32 zero bytes; the chain seed
function arraysEqual (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
/**
 * Fold one chunk into a running accumulator using the chain-hash scheme.
 *   next = sha256(acc || sha256(chunk))
 * Pure helper; no streamo state touched.
 */
async function foldChunk (acc, chunk) {
  const chunkHash = await sha256(chunk)
  const combined = new Uint8Array(64)
  combined.set(acc, 0)
  combined.set(chunkHash, 32)
  return await sha256(combined)
}

/**
 * Thrown by conditionalSet() when the streamo has advanced past the expected tip.
 * Catch this to detect write conflicts and retry with a fresh read.
 */
export class ConflictError extends Error {
  /**
   * @param {number} expectedTip  byteLength the caller observed
   * @param {number} actualTip    byteLength at the moment of the attempted write
   */
  constructor (expectedTip, actualTip) {
    super(`conflict: expected tip ${expectedTip} but streamo is at ${actualTip}`)
    this.name = 'ConflictError'
    this.expectedTip = expectedTip
    this.actualTip = actualTip
  }
}

/**
 * Yield every path where addrA and addrB differ, including the root.
 * Compares by address so unchanged subtrees are skipped in O(1).
 *
 * Uses streamo.asRefs (mutation-impossible) rather than decode(_, true)
 * so the comparison cannot append chunks. Without this, calling
 * changedPaths during Streamo.set could materialize inline children as
 * separate chunks AFTER the new commit, moving valueAddress past the
 * commit and corrupting Repo.lastCommit.
 *
 * Tradeoff: asRefs returns `undefined` for inline children's addresses,
 * so changedPaths can't see differences that happen entirely inside
 * inline-only subtrees. The parent path still fires, which is enough
 * for any watcher that doesn't read at a depth past where the structure
 * goes inline.
 */
export function * changedPaths (streamo, addrA, addrB, path = []) {
  if (addrA === addrB) return
  yield path
  const refsA = addrA !== undefined ? streamo.asRefs(addrA) : undefined
  const refsB = addrB !== undefined ? streamo.asRefs(addrB) : undefined
  const isPlain = v => v != null && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  const objA = isPlain(refsA)
  const objB = isPlain(refsB)
  if (objA || objB) {
    // Array length is not in Object.keys but watchers may read arr.length
    // and register a dep on [...path, 'length']. Fire that path explicitly
    // so length-watchers see length changes; without this, they only fire
    // when an index they happen to read changes.
    if (Array.isArray(refsA) && Array.isArray(refsB) && refsA.length !== refsB.length) {
      yield [...path, 'length']
    }
    const keys = new Set([...Object.keys(refsA ?? {}), ...Object.keys(refsB ?? {})])
    for (const key of keys) {
      const a = objA ? refsA[key] : undefined
      const b = objB ? refsB[key] : undefined
      if (a !== b) yield * changedPaths(streamo, a, b, [...path, key])
    }
  }
}

/**
 * A Streamo is a reactive, signed, append-only data store.
 *
 * It combines:
 *   - CodecRegistry: encode/decode any JS value to/from bytes
 *   - Recaller: fine-grained reactive dependency tracking (watch/get/set)
 *   - secp256k1 signing: sign the streamo contents, verify signatures
 *
 * This is the primary user-facing class. The layers below it
 * (Addressifier, CodecRegistry) exist to serve it.
 */
export class Streamo extends CodecRegistry {
  #recaller
  #signedLength = 0
  #committedAccumulator = new Uint8Array(GENESIS_ACCUMULATOR)
  // Address of the current top value. Tracks explicitly so it stays correct
  // even when set() encodes a value whose outermost subcode already exists
  // in the content map (dedup) — in that case super.append() returns the
  // existing address but byteLength doesn't grow. Falling back to
  // byteLength-1 would land on the previous top, NOT on the value just set.
  // -1 means "uninitialized; fall back to chunk-walk in the getter."
  #valueAddress = -1
  // Reactive error flags raised by makeVerifiedWritableStream. The verifier
  // *also* throws, so default-uncaught code crashes its connection — these
  // flags exist for code that wants to be smarter (UI banner, merge recovery,
  // dropping the offending peer). Never auto-cleared: a fork is a fact about
  // the local store until something deliberate resolves it.
  #conflictDetected = false
  #verificationFailed = false

  /**
   * @param {Recaller} [recaller]
   */
  constructor ({ recaller, name = 'Streamo' } = {}) {
    super()
    this.#recaller = recaller ?? new Recaller(name)
  }

  get recaller () { return this.#recaller }

  get byteLength () {
    this.#recaller.reportKeyAccess(this, 'length')
    return super.byteLength
  }

  /**
   * Append code and notify reactive watchers.
   *
   * When the appended chunk is a SIGNATURE, adopt its accumulator as the new
   * committed value and advance the signed cursor. The chain integrity of
   * that accumulator is the upstream caller's responsibility: `sign()`
   * computes it correctly by construction, and `makeVerifiedWritableStream`
   * gates appends so an untrusted peer cannot insert a SIG whose accumulator
   * does not match the byte sequence we received. `makeWritableStream`
   * (the unverified path, e.g. local archive replay) trusts its source.
   *
   * @param {Uint8Array} code
   * @returns {number}
   */
  append (code) {
    const address = super.append(code)
    if (this.footerToCodec[code.at(-1)]?.type === 'SIGNATURE') {
      const sig = this.decode(code)
      this.#signedLength = super.byteLength
      this.#committedAccumulator = sig.accumulator
    } else {
      this.#valueAddress = address
    }
    this.#recaller.reportKeyMutation(this, 'length')
    return address
  }

  /**
   * Decode the value at a path within the most-recently-appended value,
   * registering reactive dependencies so watchers re-run on changes.
   *
   * If the first argument is a number it is treated as an explicit address
   * (no dependency registered). Otherwise byteLength is accessed (dependency
   * registered) and all arguments are treated as a path into the decoded value.
   *
   * @param {...(number|string)} args
   * @returns {any}
   */
  get (...args) {
    let address
    if (typeof args[0] === 'number') {
      address = args.shift()
    } else {
      address = this.valueAddress
      // 'length': re-run when external bytes arrive (append() fires 'length').
      // path string: re-run when set() mutates this specific path via changedPaths.
      this.#recaller.reportKeyAccess(this, 'length')
      this.#recaller.reportKeyAccess(this, JSON.stringify(args))
    }
    if (address < 0) return undefined
    let value = this.decode(address)
    for (const key of args) {
      if (value == null) return undefined
      value = value[key]
    }
    return value
  }

  /**
   * Encode and append a new value, optionally updating at a path within the
   * current top-level decoded value. Notifies reactive watchers of which paths
   * changed.
   *
   * Signature: set([address,] ...path, value)
   * - If first arg is a number, use it as the base address.
   * - The last argument is always the value to set.
   * - Intermediate arguments are the path to update.
   *
   * @param {...(number|string|any)} args
   * @returns {number} address of the newly appended code
   */
  set (...args) {
    const baseAddress = typeof args[0] === 'number' ? args.shift() : this.valueAddress
    const value = args.pop()
    const path = args

    const prevAddress = super.byteLength > 0 ? this.valueAddress : undefined

    let newAddress
    if (path.length === 0 || baseAddress < 0) {
      // Whole-value set: encode and store, bypassing Streamo.append so 'length'
      // is not fired — changedPaths will emit the right path-level mutations.
      let encodedValue = value
      if (path.length > 0) {
        // Empty streamo with a path: build nested object from path
        let obj = value
        for (let i = path.length - 1; i >= 0; i--) obj = { [path[i]]: obj }
        encodedValue = obj
      }
      // Capture super.append's return: it's the outermost subcode's address
      // whether newly appended OR content-deduplicated to an existing chunk.
      // Falling back to byteLength-1 would be wrong when dedup happens — the
      // new "top" is at the existing address, not at the unchanged tail.
      newAddress = super.append(this.encode(encodedValue))
    } else {
      // Path update: navigate via _asRefsForWrite to avoid decoding untouched
      // subtrees, then rebuild only the changed path bottom-up, reusing sibling
      // addresses. (The public asRefs is mutation-impossible; the internal
      // _asRefsForWrite allows materializing inline children, which is
      // appropriate here because we're inside a write op.)
      const levels = []
      let addr = baseAddress
      for (let i = 0; i < path.length - 1; i++) {
        const refs = this._asRefsForWrite(addr)
        levels.push({ refs, key: path[i] })
        addr = Array.isArray(refs) ? refs[+path[i]] : refs[path[i]]
      }
      levels.push({ refs: this._asRefsForWrite(addr), key: path[path.length - 1] })

      // Encode the new leaf value
      const leafCode = this.encode(value)
      let childAddr = this.addressOf(leafCode) ?? super.append(leafCode)

      // Rebuild from leaf to root, reusing unchanged siblings by address
      for (let i = levels.length - 1; i >= 0; i--) {
        const { refs, key } = levels[i]
        const newRefs = Array.isArray(refs) ? [...refs] : { ...refs }
        newRefs[Array.isArray(refs) ? +key : key] = childAddr
        const code = this.encode(newRefs, true)
        childAddr = this.addressOf(code) ?? super.append(code)
      }
      // After the walk-up, childAddr is the address of the new root —
      // possibly an existing address if everything deduplicated.
      newAddress = childAddr
    }

    this.#valueAddress = newAddress
    for (const changed of changedPaths(this, prevAddress, newAddress)) {
      this.#recaller.reportKeyMutation(this, JSON.stringify(changed))
    }
    return newAddress
  }

  /**
   * Navigate a path and return refs (addresses instead of decoded values).
   * With no path, returns root refs. Returns a plain number if the target is
   * a leaf (non-object/array), or undefined if the path doesn't exist.
   *
   * @param {...string} path
   * @returns {Object|number|undefined}
   */
  getRefs (...path) {
    let address = this.valueAddress
    if (address < 0) return undefined
    for (const key of path) {
      const refs = this.asRefs(address)
      if (typeof refs === 'number') return undefined
      address = Array.isArray(refs) ? refs[+key] : refs[key]
      if (address === undefined) return undefined
    }
    return this.asRefs(address)
  }

  /**
   * Like set(), but the last argument is an address (number) rather than a
   * decoded value. Rebuilds only the changed path bottom-up, reusing sibling
   * addresses — same as set() but skips the leaf-encoding step.
   *
   * Requires at least one path key and an existing object at that path.
   *
   * @param {...(string|number)} args  ...path, address
   * @returns {number} address of the newly appended code
   */
  setRefs (...args) {
    let childAddr = args.pop()
    const path = args
    const baseAddress = this.valueAddress
    const prevAddress = super.byteLength > 0 ? this.valueAddress : undefined

    const levels = []
    let addr = baseAddress
    for (let i = 0; i < path.length - 1; i++) {
      const refs = this._asRefsForWrite(addr)
      levels.push({ refs, key: path[i] })
      addr = Array.isArray(refs) ? refs[+path[i]] : refs[path[i]]
    }
    levels.push({ refs: this._asRefsForWrite(addr), key: path[path.length - 1] })

    for (let i = levels.length - 1; i >= 0; i--) {
      const { refs, key } = levels[i]
      const newRefs = Array.isArray(refs) ? [...refs] : { ...refs }
      newRefs[Array.isArray(refs) ? +key : key] = childAddr
      const code = this.encode(newRefs, true)
      childAddr = this.addressOf(code) ?? super.append(code)
    }

    // childAddr is the address of the new root — possibly an existing
    // address if the path-update fully deduplicated. Use it directly
    // instead of byteLength-1, which would land on the unchanged tail.
    const newAddress = childAddr
    this.#valueAddress = newAddress
    for (const changed of changedPaths(this, prevAddress, newAddress)) {
      this.#recaller.reportKeyMutation(this, JSON.stringify(changed))
    }
    return newAddress
  }

  /**
   * Like set(), but only succeeds if the streamo's current byteLength equals
   * `expectedTip` — i.e., nothing has been written since the caller last read.
   *
   * Throws ConflictError when the precondition fails. Callers should catch it,
   * re-read the latest state, re-apply their change, and retry.
   *
   * @param {number} expectedTip  byteLength observed when the change was prepared
   * @param {...(string|any)} args  same arguments as set()
   * @returns {number} address of the newly appended code
   */
  conditionalSet (expectedTip, ...args) {
    const actual = super.byteLength
    if (actual !== expectedTip) throw new ConflictError(expectedTip, actual)
    return this.set(...args)
  }

  /**
   * Snapshot this streamo up to (and including) `address`.
   * The returned Streamo shares no mutable state with the original.
   * @param {number} address
   * @param {{ recaller?: Recaller, name?: string }} [options]
   * @returns {Streamo}
   */
  clone (address, { recaller = this.#recaller, name } = {}) {
    return this._applyClone(new Streamo({ recaller, name }), address)
  }

  // ── Signing ──────────────────────────────────────────────────────────────

  /**
   * Address of the most-recently-appended non-signature chunk.
   * After streamo.sign() appends a SIGNATURE chunk, byteLength - 1 points to the
   * signature rather than the user data. This getter skips backward past any
   * trailing SIGNATURE chunks so get() and set() always operate on real data.
   */
  get valueAddress () {
    // Prefer the explicit pointer (updated by set/setRefs/append for the
    // current top value). It stays correct even when set() deduplicates to
    // an existing address — byteLength-1 would lie in that case.
    if (this.#valueAddress >= 0) return this.#valueAddress
    // Fallback for fresh / cloned streams that haven't seen an explicit
    // set or append yet: walk back from byteLength-1 past any SIGNATURE
    // chunks. Same as the original behavior.
    let address = super.byteLength - 1
    while (address >= 0) {
      const code = this.resolve(address)
      if (this.footerToCodec[code.at(-1)]?.type !== 'SIGNATURE') break
      address -= code.length
    }
    return address
  }

  /** Byte length that has been covered by a signature. */
  get signedLength () { return this.#signedLength }

  /** The 32-byte accumulator committed by the most recent SIGNATURE chunk
   * (or the 32-byte genesis seed if no signature has been appended yet). */
  get committedAccumulator () { return this.#committedAccumulator }

  /**
   * Reactive: true once makeVerifiedWritableStream has rejected a SIG whose
   * accumulator didn't match the locally-folded chain. Two devices with the
   * same signing key signed over different chunk sequences — the chain can't
   * be appended without corruption. (This is a *conflict*, not a fork: a
   * fork in streamo's vocabulary is a deliberate new Repo with a lineage
   * note. A conflict is the runtime "these bytes can't be appended" failure.)
   * Application code should watch this to surface a recovery UX.
   */
  get conflictDetected () {
    this.#recaller.reportKeyAccess(this, 'conflictDetected')
    return this.#conflictDetected
  }

  /**
   * Reactive: true once makeVerifiedWritableStream has rejected a SIG whose
   * crypto signature didn't verify under the expected pubkey. Indicates an
   * attack or corruption, not a fork — the appropriate response is to drop
   * the offending peer, not to merge.
   */
  get verificationFailed () {
    this.#recaller.reportKeyAccess(this, 'verificationFailed')
    return this.#verificationFailed
  }

  /** @override Also resets the chain state. */
  _reset () {
    super._reset()
    this.#signedLength = 0
    this.#committedAccumulator = new Uint8Array(GENESIS_ACCUMULATOR)
    this.#valueAddress = -1
    this.#conflictDetected = false
    this.#verificationFailed = false
    this.#recaller.reportKeyMutation(this, 'conflictDetected')
    this.#recaller.reportKeyMutation(this, 'verificationFailed')
  }

  /**
   * Compute the running accumulator over every chunk appended since the
   * last SIGNATURE (or from genesis if there is none). Walks chunks
   * newest-first by footer-derived width, then folds them in append order.
   *
   * @returns {Promise.<Uint8Array>} 32-byte accumulator
   */
  async #pendingAccumulator () {
    const chunks = []
    let addr = super.byteLength - 1
    while (addr >= this.#signedLength) {
      const code = this.resolve(addr)
      chunks.unshift(code)
      addr -= code.length
    }
    let acc = this.#committedAccumulator
    for (const chunk of chunks) acc = await foldChunk(acc, chunk)
    return acc
  }

  /**
   * Sign the chunks appended since the last signature (or from the start).
   * Computes the running accumulator, signs it, and appends a SIGNATURE
   * chunk carrying both the accumulator and the signature bytes.
   *
   * @param {import('./Signer.js').Signer} signer
   * @param {string} streamoName
   * @returns {Promise.<Signature>}
   */
  async sign (signer, streamoName) {
    const before = super.byteLength
    const accumulator = await this.#pendingAccumulator()
    const compactRawBytes = await signer.sign(streamoName, accumulator)
    if (super.byteLength !== before) throw new Error('streamo was modified while signing')
    const sig = new Signature(accumulator, compactRawBytes)
    this.append(this.encode(sig))
    return sig
  }

  /**
   * Verify a signature's cryptographic authenticity against `publicKey`.
   * Returns true iff `sig.compactRawBytes` is a valid signature over
   * `sig.accumulator` by `publicKey`.
   *
   * This does NOT re-verify that `sig.accumulator` is consistent with the
   * streamo's bytes — that check happens at write time (see
   * `makeVerifiedWritableStream`). Once a SIG is in the store, the chain
   * was already validated when it was accepted.
   *
   * @param {Signature} sig
   * @param {Uint8Array} publicKey
   * @returns {Promise.<boolean>}
   */
  async verify (sig, publicKey) {
    return verifySignature(publicKey, sig.accumulator, sig.compactRawBytes)
  }

  /**
   * Like makeWritableStream(), but gates every chunk against the author's
   * accumulator chain before it can corrupt the store.
   *
   * Non-signature chunks are *staged* (folded into a tentative accumulator
   * but not appended). When a SIGNATURE arrives, two checks fire:
   *   1. chain — sig.accumulator must equal the tentative accumulator
   *   2. crypto — sig.compactRawBytes must verify against sig.accumulator
   *      under `publicKey`.
   * If both pass, the staged chunks and the SIG are appended in order. If
   * either fails, the stream errors and the staged batch is discarded —
   * the store is never polluted with chunks that no SIG covers.
   *
   * This closes the historical [commit, bad_sig] corruption: an attacker
   * with no signing key cannot make us write *any* bytes without producing
   * a SIG that crypto-verifies under the author's public key.
   *
   * @param {Uint8Array} publicKey
   * @param {number} [maxFrameSize]
   * @returns {WritableStream}
   */
  makeVerifiedWritableStream (publicKey, maxFrameSize = 64 * 1024 * 1024) {
    const self = this
    let buf = new Uint8Array(0)
    // Anchor on genesis because the wire today replays from byte 0 — the
    // sender's makeReadableStream emits from offset 0, so we have to fold
    // matching chunks from the same point. A future cleanup could change
    // the wire to send "anchored batches" (sender skips bytes the receiver
    // already has, verifier starts from committedAccumulator), but that's
    // a wire-protocol change not yet done.
    let pendingAcc = new Uint8Array(GENESIS_ACCUMULATOR)
    let staged = [] // new (not-already-present) non-sig chunks awaiting a covering SIG
    // Cumulative bytes consumed from the wire. Used to check that staged
    // chunks would land at addresses matching the wire's expected positions
    // before we append them — see the alignment check at sig commit.
    let wireByteLength = 0
    return new WritableStream({
      async write (incoming) {
        const next = new Uint8Array(buf.length + incoming.length)
        next.set(buf); next.set(incoming, buf.length)
        buf = next
        while (buf.length >= 4) {
          const len = new Uint32Array(buf.slice(0, 4).buffer)[0]
          if (len === 0) throw new Error('malformed frame: zero-length chunk')
          if (len > maxFrameSize) throw new Error(`malformed frame: length ${len} exceeds ${maxFrameSize}`)
          if (buf.length < 4 + len) break
          const code = buf.slice(4, 4 + len)
          buf = buf.slice(4 + len)

          const alreadyHave = self.addressOf(code) !== undefined
          const codec = self.footerToCodec[code.at(-1)]

          if (codec?.type === 'SIGNATURE') {
            const sig = self.decode(code)
            if (!arraysEqual(sig.accumulator, pendingAcc)) {
              // Fork: honest signer, conflicting history. The signer's other
              // device signed over a chunk sequence we don't share. Raise the
              // reactive flag *before* throwing so watchers see it even when
              // the throw kills the connection.
              self.#conflictDetected = true
              self.#recaller.reportKeyMutation(self, 'conflictDetected')
              throw new Error('signature accumulator does not match chain')
            }
            const valid = await verifySignature(publicKey, sig.accumulator, sig.compactRawBytes)
            if (!valid) {
              // Attack or corruption: the signature doesn't crypto-verify
              // under the expected pubkey. Different threat from a fork —
              // separate flag so UX can respond differently (drop the peer
              // rather than offer a merge).
              self.#verificationFailed = true
              self.#recaller.reportKeyMutation(self, 'verificationFailed')
              throw new Error('signature verification failed')
            }
            // Alignment check: staged chunks were encoded with internal
            // references (e.g. COMMIT.dataAddress) pointing to byte positions
            // in the SENDER's chain. We can only safely append them if our
            // local byteLength equals the wire's position right before them
            // — otherwise the staged chunks land at addresses where their
            // references resolve to the wrong bytes, corrupting decodes.
            // This catches the "local has unsigned-or-locally-signed content
            // past the last shared sig" case (multi-tab offline writes),
            // which the accumulator check alone cannot see.
            if (staged.length > 0) {
              const stagedTotal = staged.reduce((sum, c) => sum + c.length, 0)
              const expectedLocalByteLength = wireByteLength - stagedTotal
              if (self.byteLength !== expectedLocalByteLength) {
                self.#conflictDetected = true
                self.#recaller.reportKeyMutation(self, 'conflictDetected')
                throw new Error(
                  `local store diverged from wire: wire expects byteLength ${expectedLocalByteLength} ` +
                  `for staged chunks but local is at ${self.byteLength}`
                )
              }
            }
            // Commit batch: append staged chunks (all new), then the SIG itself.
            for (const c of staged) self.append(c)
            staged = []
            if (!alreadyHave) self.append(code)
            // pendingAcc stays at sig.accumulator; next non-sig chunks fold from here.
          } else {
            pendingAcc = await foldChunk(pendingAcc, code)
            if (!alreadyHave) staged.push(code)
          }
          wireByteLength += code.length
        }
      }
    })
  }
}
