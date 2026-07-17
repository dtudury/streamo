/**
 * @file Draft — an ephemeral author-work object attached to a Mirror.
 *
 * Part of the Mirror-and-Draft north-star design captured in
 * `EXPLORATION-sync-model.md`. This is the FIRST MILE: a facade over
 * `WritableStreamoRecord.update()` that exposes the Draft vocabulary
 * (pending / landed / superseded status; no auto-retry) as an alternative
 * API. Later arcs move the actual byte-storage separation.
 *
 * **What a Draft is:** ephemeral, per-commit-attempt. Constructed from
 * a Mirror + signer. Holds a pending value the author is composing.
 * `.commit()` seals the pending value (encodes + signs + pushes to
 * wire). Status transitions:
 *   - `draft`      — mutable; author is composing
 *   - `pending`    — commit signed, waiting for wire confirmation
 *   - `landed`     — mirror advanced past this commit's chainHash
 *   - `superseded` — mirror advanced to a different chainHash at same
 *                    parent-position; someone else's commit won
 *   - `cancelled`  — author explicitly discarded before commit
 *   - `failed`     — commit threw for a reason other than supersession
 *                    (network error, etc.); .error carries the detail
 *
 * **Why no auto-retry:** conflict resolution is UX. The substrate
 * surfaces the superseded state; the author decides — discard, notify
 * the user, construct a new Draft from the updated mirror and re-apply
 * intent, etc. `WritableStreamoRecord.update()`'s retry loop can still
 * be used by callers who want the old behavior; Draft is the new
 * lower-opinion primitive.
 *
 * **First-mile status:** internally delegates to
 * `WritableStreamoRecord.update({retries: 0, onConflict})` for the
 * actual signing + push. Not yet a real class-separation. See
 * EXPLORATION-sync-model.md for the full design.
 */
import { Recaller } from './utils/Recaller.js'

function arraysEqual (a, b) {
  if (!a || !b) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export class Draft {
  /** @type {import('./WritableStreamoRecord.js').WritableStreamoRecord} */
  #mirror
  #signer
  #signerName
  #parentChainHash
  #pendingValue
  #status = 'draft'
  #error = null
  #recaller
  /** @type {Uint8Array | null} — the chainHash of our signed commit, once .commit() has signed */
  #targetChainHash = null

  /**
   * @param {import('./WritableStreamoRecord.js').WritableStreamoRecord} mirror
   *   The Mirror (currently a WritableStreamoRecord since the classes aren't
   *   yet separated; in the full design this becomes a read-only Mirror).
   *   Must be attached to a session so commit can push to wire.
   * @param {import('./Signer.js').Signer} [signer]  Signer for the mirror's key.
   *   If mirror already has a signer attached, this is optional.
   * @param {string} [signerName]  keysFor input for the signer. If mirror
   *   already has a signer attached, this is optional.
   */
  constructor (mirror, signer = null, signerName = null) {
    if (!mirror) throw new Error('Draft requires a mirror')
    if (typeof mirror.commit !== 'function' ||
        typeof mirror.checkout !== 'function' ||
        typeof mirror.update !== 'function') {
      throw new Error('Draft: mirror must be a WritableStreamoRecord for the first-mile facade (real Mirror class comes later)')
    }
    this.#mirror = mirror
    this.#signer = signer
    this.#signerName = signerName
    this.#recaller = mirror.recaller ?? new Recaller('draft-fallback')

    // Snapshot mirror's parent chainHash at construction. Author's
    // commit will chain from this point.
    this.#parentChainHash = mirror.committedChainHash

    // Initial pending value is a shallow copy of mirror's current value.
    const current = mirror.get()
    this.#pendingValue = current == null ? {} : (typeof current === 'object' && !ArrayBuffer.isView(current) ? { ...current } : current)
  }

  /** Reactive: the current status of the draft. */
  get status () {
    this.#recaller.reportKeyAccess(this, 'status')
    return this.#status
  }

  /** The value the author is proposing to commit. */
  get pendingValue () {
    this.#recaller.reportKeyAccess(this, 'pendingValue')
    return this.#pendingValue
  }

  /** The mirror's chainHash at the moment this Draft was constructed. */
  get parentChainHash () { return this.#parentChainHash }

  /** Populated on 'failed' status. */
  get error () {
    this.#recaller.reportKeyAccess(this, 'error')
    return this.#error
  }

  /**
   * Mutate the pending value. Accepts either a new value directly or an
   * updater function that receives the current pendingValue.
   * @param {any | ((current: any) => any)} valueOrUpdater
   */
  set (valueOrUpdater) {
    if (this.#status !== 'draft') {
      throw new Error(`Draft.set: status is '${this.#status}'; only 'draft' is editable`)
    }
    this.#pendingValue = typeof valueOrUpdater === 'function'
      ? valueOrUpdater(this.#pendingValue)
      : valueOrUpdater
    this.#recaller.reportKeyMutation(this, 'pendingValue')
  }

  /**
   * Explicitly abandon this draft without committing. Terminal.
   */
  cancel () {
    if (this.#status === 'draft' || this.#status === 'pending') {
      this.#setStatus('cancelled')
    }
  }

  /**
   * Seal the pending value: sign a commit chained from the draft's
   * parent, push to wire, await confirmation. On success: status →
   * 'landed'. On mirror advancing to a different chainHash at the same
   * parent-position: status → 'superseded'. On other error: status →
   * 'failed' with .error populated.
   *
   * Throws on non-successful outcomes so async/await callers can catch.
   * The status is set BEFORE the throw so watchers reactively update.
   *
   * @param {object} [options]
   * @param {string} [options.message]
   * @param {Date} [options.date]
   */
  async commit (options = {}) {
    if (this.#status !== 'draft') {
      throw new Error(`Draft.commit: status is '${this.#status}'; only 'draft' is commit-able`)
    }
    const { message, date } = options

    // Precheck: mirror still at our expected parent? If not, we're
    // superseded before we even try — someone else committed since we
    // constructed this Draft.
    if (!arraysEqual(this.#mirror.committedChainHash, this.#parentChainHash)) {
      this.#setStatus('superseded')
      throw Object.assign(
        new Error('Draft superseded before commit — mirror advanced past parent'),
        { draftStatus: 'superseded' }
      )
    }

    // Attach signer if mirror doesn't have one yet AND we brought one.
    if (this.#signer && typeof this.#mirror.attachSigner === 'function') {
      // Attach is idempotent-if-same-signer; safe to always call.
      // (attachSigner guards internally against re-attach with different creds.)
      try {
        this.#mirror.attachSigner(this.#signer, this.#signerName)
      } catch (err) {
        // If already attached with different signer, throw with clarity.
        this.#error = err
        this.#setStatus('failed')
        throw err
      }
    }

    this.#setStatus('pending')

    // Delegate to WritableStreamoRecord.update with retries:0 and an
    // onConflict callback that flips us to 'superseded'. update() signs +
    // pushes + awaits round-trip.
    let succeeded = false
    try {
      const result = await this.#mirror.update(
        () => this.#pendingValue,
        {
          retries: 0,
          message,
          date,
          onConflict: (finalState) => {
            // update()'s retry loop reached exhaustion. In our case with
            // retries:0, this fires after the FIRST failure. Interpret as
            // supersession — someone else committed at our parent.
            this.#setStatus('superseded')
            return { superseded: true, finalState }
          }
        }
      )
      if (result && result.superseded) {
        // Already set to 'superseded' inside onConflict.
        throw Object.assign(
          new Error('Draft superseded — mirror accepted a different commit at parent'),
          { draftStatus: 'superseded' }
        )
      }
      // update() resolved without conflict; the commit's chainHash is now
      // mirror.committedChainHash.
      this.#targetChainHash = this.#mirror.committedChainHash
      succeeded = true
      this.#setStatus('landed')
    } catch (err) {
      if (this.#status === 'superseded') throw err  // already set; propagate
      // Other error path (network, signing, etc.). Preserve the error.
      this.#error = err
      this.#setStatus('failed')
      throw err
    }

    return { chainHash: this.#targetChainHash }
  }

  #setStatus (s) {
    this.#status = s
    this.#recaller.reportKeyMutation(this, 'status')
  }
}

/**
 * Retry-wrapping helper for callers who want the old auto-retry-on-conflict
 * shape of `WritableStreamoRecord.update()` while using the Draft API.
 * On each attempt, constructs a fresh Draft (against mirror's current tip),
 * applies the updater, commits. On 'superseded', retries. On other errors,
 * throws.
 *
 * Use this for contexts where a conflict "should" auto-retry — server
 * startup seeds, background reconciliation, etc. For contexts where a
 * conflict is user-facing signal, use Draft directly.
 *
 * @template T
 * @param {import('./WritableStreamoRecord.js').WritableStreamoRecord} mirror
 * @param {(current: any) => T} updater  called with mirror's current value on each attempt
 * @param {object} [options]
 * @param {number} [options.retries=3]  max total attempts is retries + 1
 * @param {string} [options.message]
 * @param {Date} [options.date]
 * @param {import('./Signer.js').Signer} [options.signer]
 * @param {string} [options.signerName]
 * @returns {Promise<{chainHash: Uint8Array, attempts: number}>}
 */
export async function commitWithRetry (mirror, updater, options = {}) {
  const { retries = 3, message, date, signer = null, signerName = null } = options
  let lastError = null
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const draft = mirror.newDraft(signer, signerName)
    draft.set(updater(mirror.get()))
    try {
      const result = await draft.commit({ message, date })
      return { chainHash: result.chainHash, attempts: attempt }
    } catch (err) {
      lastError = err
      if (err.draftStatus !== 'superseded') throw err
      // Superseded — loop retries with a fresh draft against updated mirror.
    }
  }
  throw Object.assign(
    new Error(`commitWithRetry: exhausted ${retries + 1} attempts; last error: ${lastError?.message}`),
    { draftStatus: 'superseded', lastError, attempts: retries + 1 }
  )
}
