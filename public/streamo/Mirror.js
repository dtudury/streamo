/**
 * @file Mirror — the container that holds one editable StreamoRecord (`local`)
 * plus a cursor (`remoteLength`) marking how far the wire has confirmed.
 *
 * See `docs/EXPLORATION-mirror.md` for the full design.
 *
 * **One Mirror per (registry, publicKeyHex).** Authoring is
 * `mirror.local.set(...)`. There is no Draft class in the target design;
 * this scaffold coexists with Draft until the migration progresses.
 *
 * **SCAFFOLD status (Vireo 2026-07-27 late):** constructor + reactive
 * `remoteLength` cursor + reactive `divergence` cell (with `acknowledge()`
 * method). Push machinery and receive-stream handler are follow-up work
 * per the doc's migration steps 3–5. Design decisions the scaffold
 * commits: reactive-cell-with-acknowledge for divergence (open question
 * 2 in EXPLORATION-mirror.md), explicit `.local.set(...)` API (question
 * 1), push routed through session (question 3).
 */
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { arraysEqual } from './utils.js'
import { Draft } from './Draft.js'

export class Mirror {
  /** @type {string} hex-encoded public key of the mirrored Record. */
  publicKeyHex
  /** @type {StreamoRecord | WritableStreamoRecord} the byte-store you read/write. */
  local
  /** @type {import('./utils/Recaller.js').Recaller} */
  recaller

  #remoteLength = 0
  /** @type {null | {preClone: StreamoRecord, wireBytes: Uint8Array, atRemoteLength: number, acknowledge: () => void}} */
  #divergence = null

  /**
   * @param {{
   *   publicKeyHex?: string,
   *   local?: StreamoRecord | WritableStreamoRecord,
   *   recaller?: import('./utils/Recaller.js').Recaller
   * }} [options]
   *   `publicKeyHex` and `local` are **required at runtime** — marked
   *   optional in the type only so the `= {}` default literal below
   *   type-checks. The three throws immediately following are the real
   *   contract, and they say which one is missing. Same shape, and the same
   *   reason, as `StreamoRecordRegistry`'s `recaller`.
   *
   *   `recaller` defaults to `local.recaller` (the typical shared-Recaller
   *   case). Pass an explicit recaller only if you need Mirror's reactive
   *   events on a different one than local's chunk-arrival events.
   */
  constructor ({ publicKeyHex, local, recaller = null } = {}) {
    if (!publicKeyHex) throw new TypeError('Mirror: publicKeyHex required')
    if (!local) throw new TypeError('Mirror: local (StreamoRecord or WritableStreamoRecord) required')
    if (!(local instanceof StreamoRecord)) {
      throw new TypeError('Mirror: local must be a StreamoRecord (or subclass)')
    }
    const rec = recaller ?? local.recaller
    if (!rec) throw new TypeError('Mirror: recaller required (either explicit or via local.recaller)')

    this.publicKeyHex = publicKeyHex
    this.local = local
    this.recaller = rec
  }

  /**
   * Reactive: the byte-length up to which the wire has confirmed. Watchers
   * inside a `recaller.watch(...)` block that read this get subscribed to
   * advances. `_awaitChainHash(target)` callers migrate to
   * `mirror.recaller.when(() => mirror.remoteLength >= X)` where X is the
   * byte-position of the target commit's SIG.
   */
  get remoteLength () {
    this.recaller.reportKeyAccess(this, 'remoteLength')
    return this.#remoteLength
  }

  /**
   * Advance remoteLength (typically called by the receive handler once wire
   * bytes have been validated + appended). Fires watchers depending on
   * `remoteLength` if the value changed. Refuses backward moves — that
   * shape would signal a bug in the receive handler (wire never rewinds).
   */
  set remoteLength (value) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`Mirror.remoteLength: must be a non-negative finite number, got ${value}`)
    }
    if (value < this.#remoteLength) {
      throw new Error(`Mirror.remoteLength: refusing to move backward (${this.#remoteLength} → ${value})`)
    }
    if (value === this.#remoteLength) return
    this.#remoteLength = value
    this.recaller.reportKeyMutation(this, 'remoteLength')
  }

  /**
   * Reactive: divergence state. `null` when no divergence pending; otherwise
   * `{ preClone, wireBytes, atRemoteLength, acknowledge }`. Call
   * `divergence.acknowledge()` to clear — that's the design choice for
   * open question 2 in EXPLORATION-mirror.md (reactive cell with explicit
   * ack, avoiding the stale-state trap of a cell the consumer forgot to
   * handle).
   */
  get divergence () {
    this.recaller.reportKeyAccess(this, 'divergence')
    return this.#divergence
  }

  /**
   * Signal divergence — called by the receive handler when incoming wire
   * bytes at `remoteLength` do not extend `local`'s bytes cleanly (the
   * local had unpushed commits past `remoteLength`, and the wire's new
   * bytes differ).
   *
   * @param {{preClone: StreamoRecord, wireBytes: Uint8Array, atRemoteLength: number}} info
   */
  reportDivergence ({ preClone, wireBytes, atRemoteLength }) {
    const acknowledge = () => this.#clearDivergence()
    this.#divergence = { preClone, wireBytes, atRemoteLength, acknowledge }
    this.recaller.reportKeyMutation(this, 'divergence')
  }

  #clearDivergence () {
    if (this.#divergence === null) return
    this.#divergence = null
    this.recaller.reportKeyMutation(this, 'divergence')
  }

  // Transitional: delete once callers read through `.local`. Writes are
  // absent on purpose so they have to move.
  get byteLength () { return this.local.byteLength }
  get signedLength () { return this.local.signedLength }
  get lastCommit () { return this.local.lastCommit }
  get committedChainHash () { return this.local.committedChainHash }
  get (...args) { return this.local.get(...args) }
  // Spelled out rather than `...args`: `decode` takes two positional
  // parameters, not a rest, so a spread through it has no tuple to check
  // against. Delegating the real arity is both the fix and the documentation.
  decode (codeOrAddressOrVariable, asRefs = false) {
    return this.local.decode(codeOrAddressOrVariable, asRefs)
  }
  slice (start, end) { return this.local.slice(start, end) }
  makeReadableStream (options) { return this.local.makeReadableStream(options) }

  /**
   * Can this be authored to? Delegates — `isAuthorable` is declared on
   * StreamoRecord (false) and overridden on WritableStreamoRecord (true),
   * so the question has the same answer shape whether you hold a Record or
   * a Mirror. Non-reactive: fixed at construction by the 11.0 class split.
   */
  get isAuthorable () {
    return this.local.isAuthorable
  }

  /**
   * The wire-inbound handler — replaces `relayInboundStream.js`, which
   * decided the same question by comparing chain hashes at each SIG and
   * staging chunks until one arrived.
   *
   * **`remoteLength` advances by the payload length, never payload + 4.**
   * Wire bytes carry a 4-byte length prefix; `byteLength`, `fromOffset` and
   * `remoteLength` don't count it (`wireByteLength` is the one that does).
   * Advance by the framed count and `remoteLength` runs permanently ahead,
   * so every `remoteLength >= X` watch fires early and silently.
   *
   * @param {{maxFrameSize?: number}} [options] `maxFrameSize` is a
   *   defensive cap so a malformed length prefix can't allocate unbounded
   *   memory.
   * @returns {WritableStream}
   */
  makeReceiveStream ({ maxFrameSize = 64 * 1024 * 1024 } = {}) {
    let buf = new Uint8Array(0)
    let bufOffset = 0
    // Where the next incoming chunk lands. Starts at the confirmed cursor
    // and walks forward across writes; `remoteLength` is only published
    // once a write's frames are fully processed.
    let cursor = this.#remoteLength
    const mirror = this

    return new WritableStream({
      write (incoming) {
        // Compact leftover + incoming, then walk frames with subarray views
        // so extraction stays O(1) per chunk rather than O(N) per slice.
        const leftover = buf.length - bufOffset
        if (leftover === 0) buf = incoming
        else {
          const next = new Uint8Array(leftover + incoming.length)
          next.set(buf.subarray(bufOffset), 0)
          next.set(incoming, leftover)
          buf = next
        }
        bufOffset = 0

        while (buf.length - bufOffset >= 4) {
          const view = new DataView(buf.buffer, buf.byteOffset + bufOffset, 4)
          const len = view.getUint32(0, true)
          if (len === 0) throw new Error('malformed frame: zero-length chunk')
          if (len > maxFrameSize) {
            throw new Error(`malformed frame: length ${len} exceeds ${maxFrameSize}`)
          }
          if (buf.length - bufOffset < 4 + len) break
          const code = buf.subarray(bufOffset + 4, bufOffset + 4 + len)
          bufOffset += 4 + len

          if (cursor < mirror.local.byteLength) {
            // Occupied territory: these positions already hold bytes.
            const mine = mirror.local.slice(cursor, cursor + len)
            if (!arraysEqual(mine, code)) {
              mirror.reportDivergence({
                preClone: mirror.local,
                wireBytes: code.slice(),
                atRemoteLength: mirror.#remoteLength
              })
              throw new Error(
                `local diverged from the wire at byte ${cursor}: ` +
                'local holds unpushed commits the wire did not accept ' +
                '(push in flight, or another author won the position)'
              )
            }
            // Byte-identical — our own commit coming back down. Nothing to
            // append; the cursor advance is the whole update.
          } else {
            mirror.local.append(code.slice())
          }
          cursor += len
        }

        mirror.remoteLength = cursor
      }
    })
  }

  /**
   * Reactive: has the wire caught us up to where it said it would?
   *
   * This is `StreamoRecord.caughtUpToRelay` with its proxy removed. That
   * version fell back to `relayChainHash !== null` and said so in its own
   * comment — *"not as precise as the watermark, but keeps isReadyToAuthor
   * from returning true before wire has told us anything."* **`remoteLength`
   * is that watermark.** So this isn't a migration of the check, it's the
   * check the comment was describing.
   *
   * Two paths, same as before:
   *   1. registrySync acks `{type:'subscribed', atOffset}` → compare the
   *      cursor against that offset.
   *   2. originSync's handshake carries no ack, so the offset stays null
   *      forever → fall back to "has the wire confirmed anything at all."
   */
  get caughtUpToRelay () {
    const watermark = this.local._session?.getRelaySubscribedAtOffset?.(this.publicKeyHex) ?? null
    if (watermark !== null) return this.remoteLength >= watermark
    return this.remoteLength > 0
  }

  /**
   * Reactive: safe to make disk-vs-repo authority decisions and commit
   * local writes — fileSync's startup gate. No relay means nobody can
   * contradict us, so authoring is trivially safe.
   */
  get isReadyToAuthor () {
    if (!this.local.hasRelay) return true
    return this.caughtUpToRelay
  }

  /**
   * Await a commit's round-trip. This is what `_awaitChainHash` dissolves
   * into — same three outcomes, but "landed" is a byte-position rather than
   * a chain-hash equality, so nothing here interprets the chain.
   *
   * **Three outcomes, and watching only the good one produces a hang.**
   * `_awaitChainHash` bundled landing with two rejection paths under a name
   * that advertises only the first; that's why it looked like a one-line
   * replacement and wasn't. Keeping them together here on purpose:
   *
   * - **landed** — `remoteLength >= targetLength`
   * - **rejected** — `session.getPushRejected`, armed by the relay's
   *   `rejected` message (`registrySync.js`), independent of the receive path
   * - **diverged** — `this.divergence` (set by `makeReceiveStream`) *or*
   *   `session.getConflictDetected` (set by the old `relayInboundStream`).
   *   Both are watched so this works either side of the receive-path swap;
   *   the `conflictDetected` arm goes when `relayInboundStream.js` does.
   *
   * **Sessionless bypass**, inherited from `_awaitChainHash` and load-bearing:
   * with no session, no wire will ever advance `remoteLength`, so waiting is
   * waiting forever. Resolve instead — that's what lets fileSync's
   * archive-only paths and sessionless tests use the same code path.
   * Failure checks run *first* so a test that pre-arms a rejection still
   * takes the reject branch.
   *
   * @param {number} targetLength byte-position the commit occupies once
   *   signed — capture `local.byteLength` *after* auto-sign has appended
   *   the SIG, not before.
   * @returns {Promise<void>}
   */
  awaitLanded (targetLength) {
    return new Promise((resolve, reject) => {
      const fn = () => {
        const session = this.local._session
        const done = (fail) => {
          this.recaller.unwatch(fn)
          fail ? reject(fail) : resolve()
        }

        const rejected = session?.getPushRejected?.(this.publicKeyHex) ?? null
        if (rejected) {
          return done(Object.assign(
            new Error(`push rejected: ${rejected.reason ?? 'unknown reason'}`),
            { pushRejected: rejected }
          ))
        }

        const conflict = session?.getConflictDetected?.(this.publicKeyHex) ?? null
        const diverged = this.divergence
        if (conflict || diverged) {
          return done(Object.assign(
            new Error('local store diverged from incoming chain'),
            { conflictDetected: conflict, divergence: diverged }
          ))
        }

        if (this.remoteLength >= targetLength) return done()
        if (!session) return done()
      }
      this.recaller.watch('mirror:awaitLanded', fn)
    })
  }

  /**
   * The author entrypoint the design names: `mirror.newDraft(signer)`
   * instead of callers reaching into `.local` themselves.
   *
   * Hands Draft `this`, not `this.local` — Draft splits the two internally
   * (authoring verbs on the record, round-trip await on the Mirror). Passing
   * a bare record still works and takes the legacy `_awaitChainHash` path;
   * that fallback is what makes this migration incremental, and it goes when
   * `relayInboundStream.js` does.
   *
   * @param {import('./Signer.js').Signer | null} [signer] defaults to the
   *   signer already attached to `local`, so the common case is `newDraft()`.
   * @param {string | null} [signerName]
   * @returns {import('./Draft.js').Draft}
   */
  newDraft (signer = null, signerName = null) {
    if (!this.isAuthorable) {
      throw new TypeError(
        `Mirror.newDraft: local is not authorable (${this.publicKeyHex.slice(0, 8)}…). ` +
        'Only a Mirror whose local is a WritableStreamoRecord can author.'
      )
    }
    return new Draft(this, signer, signerName)
  }

  //
  // TODO: reactive push machinery — a `recaller.watch` that fires when
  // `local.byteLength > remoteLength` AND `isAuthorable` AND connection
  // is live, drains the delta from `local.makeReadableStream({fromOffset:
  // remoteLength})`, and pushes via `session.pushCommit`. Follow-up per
  // migration step 3 / wire-mirror-split step 2.
}
