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
 * WritableStreamoRecord primitives directly (checkout + set + commit +
 * auto-sign + `_awaitChainHash`). Not yet a real class-separation.
 * See EXPLORATION-sync-model.md for the full design.
 */
import { Recaller } from './utils/Recaller.js'
import { arraysEqual as _arraysEqual } from './utils.js'

// Draft's arraysEqual accepts null/undefined (returns `a === b` for
// that case) — a specialization the base utils.arraysEqual doesn't
// provide. Kept as a local wrapper so future callers of the base
// helper don't inherit the null-tolerance. See utils.js's arraysEqual
// for the consolidation history.
function arraysEqual (a, b) {
  if (!a || !b) return a === b
  return _arraysEqual(a, b)
}

/**
 * Is this a Mirror (carries its byte-store on `.local`) rather than a bare
 * WritableStreamoRecord?
 *
 * Structural rather than `instanceof Mirror` because Mirror imports Draft;
 * importing back would close the cycle. Written as a **type predicate** so
 * the narrowing is real to the typechecker — the alternative was a cast
 * plus a comment asserting the cast is fine, which is precisely the shape
 * that put an invented route-guard in `webSync.js` for three months.
 *
 * @param {any} x
 * @returns {x is import('./Mirror.js').Mirror}
 */
function isMirror (x) {
  return x != null && typeof x === 'object' && 'local' in x
}

/**
 * Can this byte-store be authored to? `checkout` + `commit` are the two
 * verbs signing needs, and a Mirror's `.local` is only *typed* as
 * `StreamoRecord | WritableStreamoRecord` — a read-only Mirror is a real
 * possibility, not a typechecker artifact.
 *
 * The runtime guard and the narrowing are deliberately the same statement:
 * the check that throws is the check that convinces the typechecker, so
 * neither can drift from the other.
 *
 * @param {any} x
 * @returns {x is import('./WritableStreamoRecord.js').WritableStreamoRecord}
 */
function isAuthorable (x) {
  return x != null && typeof x.commit === 'function' && typeof x.checkout === 'function'
}

export class Draft {
  /** @type {import('./WritableStreamoRecord.js').WritableStreamoRecord} the byte-store: checkout/set/commit/sign */
  #mirror
  /** @type {import('./Mirror.js').Mirror | null} the wire cursor, when we were given one */
  #wire
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
   * @param {import('./Mirror.js').Mirror | import('./WritableStreamoRecord.js').WritableStreamoRecord} mirror
   *   A **Mirror** (preferred) or a bare WritableStreamoRecord (legacy).
   *   Given a Mirror, the round-trip await watches `remoteLength`; given a
   *   record, it falls back to `_awaitChainHash`. Both need a session
   *   attached for `commit()` to reach the wire.
   * @param {import('./Signer.js').Signer} [signer]  Signer for the key.
   *   Optional if one is already attached.
   * @param {string} [signerName]  keysFor input for the signer. Optional if
   *   one is already attached.
   */
  constructor (mirror, signer = null, signerName = null) {
    if (!mirror) throw new Error('Draft requires a mirror')
    // A Mirror carries its byte-store on `.local` and deliberately does NOT
    // delegate commit/checkout (writes are absent so callers move). A bare
    // record has them directly. Duck-typed rather than `instanceof Mirror`
    // because Mirror imports Draft — importing back would close the cycle.
    const wire = isMirror(mirror) ? mirror : null
    const record = wire ? wire.local : mirror
    if (!isAuthorable(record)) {
      throw new Error(
        'Draft: needs a WritableStreamoRecord, or a Mirror over one — ' +
        'commit + checkout are required for signing'
      )
    }
    this.#wire = wire
    this.#mirror = record
    this.#signer = signer
    this.#signerName = signerName
    this.#recaller = record.recaller ?? new Recaller('draft-fallback')

    // Snapshot the parent chainHash at construction. Author's commit will
    // chain from this point.
    this.#parentChainHash = record.committedChainHash

    // Initial pending value is a shallow copy of the current value.
    const current = record.get()
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

    // Use WritableStreamoRecord primitives directly (checkout + set +
    // commit + auto-sign + _awaitChainHash) instead of update()'s
    // retry loop. Retries live at the caller layer (commitWithRetry
    // helper); Draft is the no-retry primitive.
    //
    // The inline checkout→set→commit path mirrors update()'s handling
    // of message/date/remoteParent: those options need the checkout
    // path because set() reads defaultMessage at commit time.
    let succeeded = false
    try {
      if (message !== undefined || date !== undefined) {
        const working = this.#mirror.checkout()
        working.set(this.#pendingValue)
        const commitOpts = {}
        if (date !== undefined) commitOpts.date = date
        this.#mirror.commit(working, message, commitOpts)
      } else {
        this.#mirror.set(this.#pendingValue)
      }

      // No signer → mirror never advances signedLength; the primitive
      // collapses to "commit and return" (matches update()'s bail at
      // its own signer-null check). Callers who wanted a signed round-
      // trip should have attached one; this is the "no-signer" author
      // path used by fileSync's archive-only paths + tests.
      if (this.#mirror.hasSigner === false) {
        this.#targetChainHash = this.#mirror.committedChainHash
        succeeded = true
        this.#setStatus('landed')
        return { chainHash: this.#targetChainHash }
      }

      // Wait for auto-sign to append the SIG (advances signedLength to
      // byteLength). With a signer attached, the recaller-based sign
      // scheduler fires and moves signedLength.
      await this.#mirror.recaller.when(() => this.#mirror.signedLength === this.#mirror.byteLength, {
        name: 'draft:await-sign'
      })
      const target = this.#mirror.committedChainHash

      // Await round-trip. Given a Mirror, "landed" is a byte-position:
      // byteLength AFTER auto-sign is exactly where our commit ends, so
      // remoteLength reaching it means the wire confirmed our bytes. The
      // record path is the legacy chain-hash equality and goes when
      // relayInboundStream.js does.
      //
      // Either way this rejects on pushRejected or divergence — a
      // landing-only await would hang rather than fail, which is the
      // trap _awaitChainHash's name hides (see Mirror.awaitLanded).
      if (this.#wire) await this.#wire.awaitLanded(this.#mirror.byteLength)
      else await this.#mirror._awaitChainHash(target)

      this.#targetChainHash = target
      succeeded = true
      this.#setStatus('landed')
      return { chainHash: target }
    } catch (err) {
      // Only "clean" way to reach here is a supersession signal from
      // _awaitChainHash. Any other error (invariant violation, etc.)
      // still needs to surface — preserve the original error via cause.
      if (this.#status === 'pending') {
        this.#error = err
        this.#setStatus('superseded')
      }
      throw Object.assign(
        new Error(`Draft superseded: ${err.message ?? err}`),
        { draftStatus: 'superseded', cause: err }
      )
    }
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
 * @param {import('./Mirror.js').Mirror | import('./WritableStreamoRecord.js').WritableStreamoRecord} mirror
 *   Polymorphic since 2026-08-01: it only needs `newDraft` + `get`, which
 *   both Mirror and StreamoRecord have. A Mirror gets the remoteLength
 *   await; a record gets the legacy `_awaitChainHash`.
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
