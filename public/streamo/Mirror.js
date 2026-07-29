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

  /**
   * True if `local` is a WritableStreamoRecord (authorable). Non-reactive —
   * a Mirror's authorability is fixed at construction (per the 11.0
   * class-split's type-level guarantee).
   */
  get isAuthorable () {
    return this.local instanceof WritableStreamoRecord
  }

  // TODO: makeReceiveStream() — the wire-inbound handler, replacing
  // `relayInboundStream.js`. Parses length-prefixed frames via
  // `Streamo.makeWritableStream` inherited machinery; compares incoming
  // bytes against `local` from `remoteLength`; accepts + advances
  // remoteLength OR calls reportDivergence. Follow-up work per migration
  // step 5 in EXPLORATION-mirror.md.
  //
  // TODO: reactive push machinery — a `recaller.watch` that fires when
  // `local.byteLength > remoteLength` AND `isAuthorable` AND connection
  // is live, drains the delta from `local.makeReadableStream({fromOffset:
  // remoteLength})`, and pushes via `session.pushCommit`. Follow-up per
  // migration step 3 / wire-mirror-split step 2.
}
