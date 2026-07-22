/**
 * @file StreamoRecord — a Streamo whose bytes interpret as a signed chain.
 *
 * **The read-only definitional minimum.** A Streamo is identity-blind: a
 * codec mapping values to/from bytes. A StreamoRecord wraps a Streamo
 * with the chain-interpretation lens that says "the trailing SIGNATURE
 * chunks anchor the rest as a single signed log." It exposes:
 *
 *   - **Chain reads**: `lastCommit`, `committedChainHash`, `signedLength`,
 *     `valueAddress` (walks past trailing SIGs to land on the commit),
 *     `get` / `getRefs` (lazy descent off the last commit's dataAddress),
 *     `files`, `history`, `verify`.
 *   - **Wire-state cells** (`hasRelay`, `caughtUpToRelay`, `isReadyToAuthor`,
 *     `pushRejected`, `conflictDetected`, `relayChainHash`, …): reactive
 *     properties surfaced for any consumer that subscribes to this Record
 *     over a wire — apps, the explorer, the relay's own bookkeeping.
 *   - **Relay-inbound writer** via `makeRelayInboundStream`: trust+append
 *     for bytes streamed from an authoritative relay, with chain-hash
 *     alignment to catch the push-in-flight race.
 *
 * **What it intentionally does NOT have:** the author surface — no
 * `set`, no `commit`, no `attachSigner`, no `sign`. Those live on
 * [`WritableStreamoRecord`](./WritableStreamoRecord.js), which extends
 * this class. The type-level split is load-bearing: a slim StreamoRecord
 * is an observer by construction, so the `registrySync.subscribe`
 * outbound guard knows it can never push (dissolving the watch.js
 * corruption-fight footgun at the type level — see CHANGELOG 11.0).
 *
 * **`remoteParent`** cites another author's value at a specific content
 * address — `{ host, repo, dataAddress }`. It's informational (a soft
 * cryptographic footnote), not a sync dependency. Two natural shapes:
 *   - *Fork commit*  (no local parent, remoteParent set) — start of a
 *     new StreamoRecord from someone else's value
 *   - *Merge commit* (both parent and remoteParent set) — combine values
 *     from this StreamoRecord and somewhere else; the new commit doesn't
 *     depend on the source from then on
 *
 * **Conflicts** are not states the StreamoRecord carries by design — they
 * are runtime "these bytes can't be appended" failures detected at the
 * relay-inbound writer. The `conflictDetected` flag is the reactive
 * surfacing of that failure for UI; the chain itself stays clean
 * (rejected batches never land).
 *
 * See design.md §8.
 */
import { Streamo } from './Streamo.js'
import { verifySignature } from './Signer.js'
import { makeRelayInboundStream as _makeRelayInboundStream } from './relayInboundStream.js'
import { Draft } from './Draft.js'

/**
 * A Streamo whose values are commit records.
 *
 * Every byte on the chain is either a COMMIT, a child chunk referenced
 * by a commit's dataAddress, or a SIGNATURE anchoring everything before
 * it. `get()` and `getRefs()` are overridden to read from the last
 * commit's dataAddress transparently — callers don't have to know
 * about the commit envelope.
 *
 * To author, use the `WritableStreamoRecord` subclass.
 */
export class StreamoRecord extends Streamo {
  // Reactive divergence flags. Both are `null` when healthy; otherwise an
  // object carrying `dataAddress` (where the rejected commit's value lives
  // in the local store) so apps can decode and offer recovery UX:
  //
  //   conflictDetected — set by makeRelayInboundStream when the local
  //                      alignment check catches a push-in-flight race.
  //                      Shape: { dataAddress }.
  //   pushRejected     — set by the registry-sync layer when the relay
  //                      rejects a push via {type:'reject', ...}.
  //                      Shape: { reason, dataAddress }.
  //
  // Neither is auto-cleared.
  #conflictDetected = null
  #pushRejected     = null

  /**
   * Hex-encoded pubkey this Record was materialized under. Populated by
   * `StreamoRecordRegistry._materialize` immediately after construction.
   * Undefined for Records created without going through a registry.
   * @type {string | undefined}
   */
  publicKeyHex

  // Optional back-reference to the session that subscribed this
  // StreamoRecord over the wire. Set by `session.subscribe`; used by
  // `WritableStreamoRecord.update()` to request a session-level resync
  // when a push is rejected. Exposed to subclasses via `get _session`.
  #session = null

  // Reactive: whether an upstream relay session is currently attached.
  // Flipped true the first time `_attachSession` is called.
  #hasRelay = false

  // The byte offset the relay had reached when it accepted our subscribe.
  // Null until the relay sends back `{type: 'subscribed', atOffset}`.
  #relaySubscribedAtOffset = null

  /**
   * Walk back from the tail to the most recent SIGNATURE chunk. Returns
   * its starting address (the byte at which it begins), or -1 if there
   * is no SIG in the store. SIGs are fixed-format 97-byte chunks; the
   * first 32 bytes are the chainHash and the next 64 are the signature.
   */
  #lastSigAddress () {
    let addr = this.byteLength - 1
    while (addr >= 0) {
      const code = this.resolve(addr)
      if (this.footerToCodec[code.at(-1)]?.type === 'SIGNATURE') return addr - code.length + 1
      addr -= code.length
    }
    return -1
  }

  /**
   * @override After a sign(), byteLength-1 points at the SIGNATURE chunk
   * rather than the user data. Walk back past any trailing SIGs so reads
   * land on the most recent non-SIG chunk (typically a COMMIT).
   */
  get valueAddress () {
    let address = super.valueAddress
    while (address >= 0) {
      const code = this.resolve(address)
      if (this.footerToCodec[code.at(-1)]?.type !== 'SIGNATURE') break
      address -= code.length
    }
    return address
  }

  /**
   * Byte length covered by the most recent SIGNATURE chunk. Derived from
   * the bytes — no cached state. Returns 0 if no SIG has been appended.
   */
  get signedLength () {
    const sigStart = this.#lastSigAddress()
    return sigStart < 0 ? 0 : sigStart + 97
  }

  /**
   * The 32-byte chainHash committed by the most recent SIGNATURE chunk.
   * Derived from the bytes: the first 32 bytes of that 97-byte chunk.
   * Returns 32 zeros (the chain seed) if no SIG has been appended.
   */
  get committedChainHash () {
    const sigStart = this.#lastSigAddress()
    if (sigStart < 0) return new Uint8Array(32)
    return this.slice(sigStart, sigStart + 32)
  }

  /**
   * The latest commit record, or null if nothing has been committed yet.
   * Registers a reactive dependency on the commit log length.
   * @returns {{ message: string, date: Date, dataAddress: number, parent: number|undefined, remoteParent?: { host: string, repo: string, dataAddress: number } }|null}
   */
  get lastCommit () {
    this.recaller.reportKeyAccess(this, 'length')
    const address = this.valueAddress
    if (address < 0) return null
    // Defensive decode: during origin-sync's initial replay, the recaller
    // fires this getter on every chunk arrival. valueAddress can briefly
    // point at a chunk whose referenced inner chunks (the Duple tree of
    // the value, etc.) haven't been appended yet — resolve() throws on
    // the missing address. Treat that as "no commit visible yet"; the
    // watcher re-runs when the next chunk lands and the state stabilises.
    let value
    try {
      value = this.decode(address)
    } catch {
      return null
    }
    if (!value || typeof value.message !== 'string' || !(value.date instanceof Date)) return null
    return value
  }

  /**
   * Decode the value at a path, reading from the last commit's dataAddress.
   * Falls back to Streamo.get() if no commits exist yet.
   *
   * Registers reactive dependencies so watchers re-run when new commits land.
   */
  get (...args) {
    if (typeof args[0] === 'number') return super.get(...args)
    const commit = this.lastCommit  // registers 'length' dependency
    if (!commit) return super.get(...args)
    this.recaller.reportKeyAccess(this, JSON.stringify(args))
    return this.decodeAt(commit.dataAddress, ...args)
  }

  /**
   * Like Streamo.getRefs() but reads from the last commit's dataAddress.
   */
  getRefs (...path) {
    const commit = this.lastCommit
    if (!commit) return super.getRefs(...path)
    let address = commit.dataAddress
    for (const key of path) {
      const refs = this.asRefs(address)
      if (typeof refs === 'number') return undefined
      address = Array.isArray(refs) ? refs[+key] : refs[key]
      if (address === undefined) return undefined
    }
    return this.asRefs(address)
  }

  /**
   * Eager-decoded value at the last commit's dataAddress.
   * Returns undefined if nothing has been committed yet.
   *
   * NB: the name is historical — this returns the WHOLE value; the
   * files map (if there is one) is at `.files` of the return. Reach
   * for `get()` with no path when you want the same thing lazily.
   */
  get files () {
    const commit = this.lastCommit
    if (!commit) return undefined
    return this.decode(commit.dataAddress)
  }

  /**
   * Iterate commits from newest to oldest. Lazy — decodes as it walks.
   */
  * history () {
    let commit = this.lastCommit
    while (commit) {
      yield commit
      commit = commit.parent !== undefined ? this.decode(commit.parent) : null
    }
  }

  /**
   * The commit before the head, or null if the head has no parent (initial
   * commit / no commits at all). Positional accessor for the common case
   * where you want "the previous one" without materializing history().
   */
  get parent () {
    const head = this.lastCommit
    if (!head || head.parent === undefined) return null
    return this.decode(head.parent)
  }

  /**
   * The commit `n` steps back from the head. `n === 0` returns the head
   * (same as `lastCommit`); `n === 1` is `parent`; etc. Returns null if
   * `n` exceeds the chain length. Walks history() lazily — cost is O(n).
   */
  ancestor (n) {
    if (n < 0) return null
    let i = 0
    for (const commit of this.history()) {
      if (i === n) return commit
      i++
    }
    return null
  }

  /**
   * Stateless crypto-check: is `sig` a valid signature over `sig.chainHash`
   * by `publicKey`? Doesn't re-verify chain consistency — that's the
   * StreamoRecordSerializer's job at the relay (chain check happens there
   * before any incoming batch lands).
   */
  async verify (sig, publicKey) {
    return verifySignature(publicKey, sig.chainHash, sig.compactRawBytes)
  }

  // ── Wire-state cells (subscribed Records reactive surface) ────────────

  /**
   * Reactive: true once makeRelayInboundStream has rejected an incoming
   * batch because our local store has content past the last shared sig
   * (a push-in-flight race: we wrote locally, the relay sent down other
   * bytes before knowing about our push, our push will likely be
   * rejected). This is a *conflict*, not a fork.
   */
  get conflictDetected () {
    this.recaller.reportKeyAccess(this, 'conflictDetected')
    return this.#conflictDetected
  }

  /** Internal setter for relayInboundStream / recovery orchestration. */
  _setConflictDetected (value) {
    this.#conflictDetected = value
    this.recaller.reportKeyMutation(this, 'conflictDetected')
  }

  /**
   * Reactive: `null` until a push from this client to the relay is rejected;
   * then `{ reason, dataAddress }` describing why. Set by the registry-sync
   * layer when a `{type: 'reject', key, reason}` control message arrives.
   */
  get pushRejected () {
    this.recaller.reportKeyAccess(this, 'pushRejected')
    return this.#pushRejected
  }

  /** Internal setter for the registry-sync layer / recovery orchestration. */
  _setPushRejected (value) {
    this.#pushRejected = value
    this.recaller.reportKeyMutation(this, 'pushRejected')
  }

  /**
   * Reactive: the 32-byte chainHash the upstream relay has confirmed up
   * to. Null until the first SIG from the relay's inbound stream lands.
   *
   * **Shim.** State lives on the attached session (per Mirror-and-Draft
   * migration item 6 — see `docs/EXPLORATION-mirror-and-draft-migration.md`).
   * Delegates to `_session.getRelayChainHash(this.publicKeyHex)`; returns
   * null when no session is attached. The session's getter registers the
   * reactive dependency, so watchers on this record still fire when the
   * wire advances (via the shared `registry.recaller`).
   */
  get relayChainHash () {
    return this.#session?.getRelayChainHash?.(this.publicKeyHex) ?? null
  }

  /**
   * Back-reference to the session that subscribed this StreamoRecord. Set
   * by `session.subscribe`; `WritableStreamoRecord.update()` reads it
   * (via `_session`) to request a session-level resync after a rejected
   * push. Null on Records that aren't attached to a wire (server-side
   * archive-only, tests, etc.).
   */
  _attachSession (session) {
    this.#session = session
    if (!this.#hasRelay) {
      this.#hasRelay = true
      this.recaller.reportKeyMutation(this, 'hasRelay')
    }
  }

  /**
   * The attached session, or null. Exposed via `_` accessor so subclasses
   * (specifically WritableStreamoRecord.update) can reach it across the
   * private-field boundary.
   */
  get _session () { return this.#session }

  /**
   * Reactive: true once an upstream relay session has been attached.
   * Stays true for the lifetime of this StreamoRecord — auto-reconnect
   * (8.5.0) keeps the session object stable across blips.
   */
  get hasRelay () {
    this.recaller.reportKeyAccess(this, 'hasRelay')
    return this.#hasRelay
  }

  /**
   * The byte offset the relay had reached when it accepted our subscribe.
   * Null until the `{type: 'subscribed', atOffset}` ack lands.
   */
  _setRelaySubscribedAtOffset (offset) {
    // Only the FIRST subscribe ack matters for the initial-replay
    // watermark. Subsequent subscribes (e.g. after `_resyncRepo` between
    // update retries) re-send the message, but the original watermark
    // has already been crossed — overwriting it would re-arm the gate
    // and cause spurious waits.
    if (this.#relaySubscribedAtOffset !== null) return
    this.#relaySubscribedAtOffset = offset
    this.recaller.reportKeyMutation(this, 'relaySubscribedAtOffset')
  }

  get relaySubscribedAtOffset () {
    this.recaller.reportKeyAccess(this, 'relaySubscribedAtOffset')
    return this.#relaySubscribedAtOffset
  }

  /**
   * Reactive: true once this StreamoRecord has caught up to the relay's
   * chain head as of the moment we subscribed. Monotonic — once true,
   * stays true.
   *
   * Two paths to "caught up":
   *   1. The registrySync path: the `{type:'subscribed', atOffset}` ack
   *      lands, `relaySubscribedAtOffset` is set, and we wait for our
   *      byteLength to reach that watermark.
   *   2. The originSync fallback: originSync's handshake doesn't include
   *      `subscribed/atOffset`, so `relaySubscribedAtOffset` stays null
   *      forever. Fall back to "have we received at least one SIG from
   *      the wire?" — proxied by `relayChainHash !== null` (set by
   *      relayInboundStream on each incoming SIG). Not as precise as
   *      the watermark, but keeps `isReadyToAuthor` from returning true
   *      before wire has told us anything.
   */
  get caughtUpToRelay () {
    const watermark = this.relaySubscribedAtOffset
    if (watermark !== null) return this.byteLength >= watermark
    return this.relayChainHash !== null
  }

  /**
   * Reactive: true when it's safe to make disk-vs-repo authority
   * decisions and commit local writes (the fileSync startup gate).
   */
  get isReadyToAuthor () {
    if (!this.hasRelay) return true
    return this.caughtUpToRelay
  }

  /**
   * Create a `Draft` — an ephemeral author-work object attached to this
   * StreamoRecord (acting as the Mirror). See `Draft.js` and
   * `EXPLORATION-sync-model.md` for the design; this is the first-mile
   * facade over `WritableStreamoRecord.update()`.
   *
   * The Draft throws at commit-time if this record isn't Writable
   * (doesn't have `.set()`/`.commit()`). Until the full Mirror-and-Draft
   * separation lands, use this on a `WritableStreamoRecord` instance.
   *
   * @param {import('./Signer.js').Signer} [signer]  optional if mirror
   *   already has a signer attached
   * @param {string} [signerName]  keysFor input; optional if already attached
   * @returns {import('./Draft.js').Draft}
   */
  newDraft (signer = null, signerName = null) {
    return new Draft(this, signer, signerName)
  }

  /**
   * @override Wipes local bytes (via Streamo._reset) AND clears the
   * divergence flags. Used by recovery-UX orchestration AND by
   * WritableStreamoRecord.update() between retry attempts.
   */
  _reset () {
    super._reset()
    this.#conflictDetected = null
    this.#pushRejected = null
    this.recaller.reportKeyMutation(this, 'conflictDetected')
    this.recaller.reportKeyMutation(this, 'pushRejected')
    // relayChainHash state now lives on the session per Mirror-and-Draft
    // migration item 6. Clearing it here would need to reach into the
    // session — but _reset() is typically called on a Record when we
    // want to discard local bytes (recovery UX, update() retry). The
    // session's relayChainHash for this pubkey is a wire fact, not a
    // local fact, so it stays. If we later need to explicitly reset it
    // (e.g., during full-resync), that becomes an explicit session call.
  }

  /**
   * Like Streamo.makeWritableStream(), for the client-side receive path
   * from a trusted relay.
   *
   * "What comes down is always from the top, and always correct" — the
   * relay's StreamoRecordSerializer has already validated the chain and
   * the signatures, so this writer skips those checks. It does perform
   * a chain-hash alignment check at SIG arrival to catch the push-in-
   * flight race; on failure it raises `conflictDetected`.
   *
   * @param {number} [maxFrameSize]
   * @returns {WritableStream}
   */
  makeRelayInboundStream (maxFrameSize = 64 * 1024 * 1024) {
    return _makeRelayInboundStream(this, maxFrameSize)
  }
}
