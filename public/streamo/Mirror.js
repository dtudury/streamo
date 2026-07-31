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
   *   publicKeyHex: string,
   *   local: StreamoRecord | WritableStreamoRecord,
   *   recaller?: import('./utils/Recaller.js').Recaller
   * }} options
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

  // ---- transitional read delegation ------------------------------------
  //
  // Per migration step 4: reads delegate to `local` so existing callers keep
  // working when `registry.get()` starts returning a Mirror; writes do not,
  // so `set`/`commit`/`append`/`merge`/`checkout` have to move to
  // `mirror.local.*` and the compiler-of-last-resort (a TypeError) says so.
  //
  // This is deliberately asymmetric and that asymmetry is a cost, not a
  // feature: an object where `get()` works and `set()` throws invites
  // exactly the confusion CLAUDE.md prop 7 says to design out. It's here
  // because the alternative is migrating ~59 call sites in the same change
  // that flips the registry, and a half-flipped registry is worse. Delete
  // this block once callers read through `.local`; nothing should grow.

  /** @returns {number} */
  get byteLength () { return this.local.byteLength }
  /** @returns {number} */
  get signedLength () { return this.local.signedLength }
  get lastCommit () { return this.local.lastCommit }
  get committedChainHash () { return this.local.committedChainHash }

  /** Decode a value at a path. See `Streamo.get`. */
  get (...args) { return this.local.get(...args) }
  /** Raw bytes in `[start, end)`. Unframed positions. */
  slice (start, end) { return this.local.slice(start, end) }
  /** Framed bytes from an unframed offset. See `Addressifier.makeReadableStream`. */
  makeReadableStream (options) { return this.local.makeReadableStream(options) }

  /**
   * True if `local` is a WritableStreamoRecord (authorable). Non-reactive —
   * a Mirror's authorability is fixed at construction (per the 11.0
   * class-split's type-level guarantee).
   */
  get isAuthorable () {
    return this.local instanceof WritableStreamoRecord
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

  //
  // TODO: reactive push machinery — a `recaller.watch` that fires when
  // `local.byteLength > remoteLength` AND `isAuthorable` AND connection
  // is live, drains the delta from `local.makeReadableStream({fromOffset:
  // remoteLength})`, and pushes via `session.pushCommit`. Follow-up per
  // migration step 3 / wire-mirror-split step 2.
}
