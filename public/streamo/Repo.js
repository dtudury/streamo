/**
 * @file Repo — Streamo + signed commits + the verified writer.
 *
 * **Repo extends Streamo** with two layers of "smarts" Streamo intentionally
 * doesn't have:
 *
 * 1. **Commit semantics.** Every `set()` becomes a signed commit — a
 *    record `{ message, date, dataAddress, parent, remoteParent? }`. The
 *    commit log is what flows over the wire during sync. `attachSigner`
 *    makes commits sign automatically, with concurrent commits batched
 *    into one signature.
 *
 * 2. **The relay-inbound writer** (`makeRelayInboundStream`) and the
 *    reactive flags it raises (`conflictDetected`, `pushRejected`).
 *    "What comes down is always from the top, always correct" — the
 *    relay's RepoSerializer (see RepoSerializer.js) is the chain
 *    authority; clients receiving wire bytes trust them and append.
 *    The only thing the receiver still has to catch is the push-in-
 *    flight race (local content past last shared sig conflicts with
 *    incoming references); the alignment check inside
 *    makeRelayInboundStream handles it.
 *
 * **`remoteParent`** cites another author's value at a specific content
 * address — `{ host, repo, dataAddress }`. It's informational (a soft
 * cryptographic footnote), not a sync dependency. Two natural shapes:
 *   - *Fork commit*  (no local parent, remoteParent set) — start of a
 *     new Repo from someone else's value
 *   - *Merge commit* (both parent and remoteParent set) — combine values
 *     from this Repo and somewhere else; the new commit doesn't depend
 *     on the source from then on
 *
 * **Conflicts** are not states the Repo carries by design — they're
 * runtime "these bytes can't be appended" failures detected at the
 * verified writer. The `conflictDetected` flag is the reactive surfacing
 * of that failure for UI; the chain itself stays clean (rejected batches
 * never land).
 *
 * See design.md §8.
 */
import { Streamo, changedPaths } from './Streamo.js'
import { Signature } from './Signature.js'
import { verifySignature } from './Signer.js'

// Chain-hash helpers — Repo-internal, since Streamo is identity-blind and
// doesn't know about signatures.
const cryptoSubtle = typeof crypto !== 'undefined' ? crypto.subtle : (await import('crypto')).webcrypto.subtle
async function sha256 (bytes) {
  return new Uint8Array(await cryptoSubtle.digest('SHA-256', bytes))
}
function arraysEqual (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
/**
 * Compute the next chain hash from the previous one + the new bytes
 * appended since:
 *   next = sha256(prev || sha256(newBytes))
 * Two sha256 calls, independent of how many chunks newBytes contains.
 * The chain seed is `new Uint8Array(32)` (32 zeros) for an empty Repo.
 */
async function chainHashOf (prev, newBytes) {
  const newBytesHash = await sha256(newBytes)
  const combined = new Uint8Array(64)
  combined.set(prev, 0)
  combined.set(newBytesHash, 32)
  return await sha256(combined)
}

/**
 * Fetch a Repo snapshot from an HTTP source URL or host shorthand.
 * Returns `{ repo, host, keyHex }` — the loaded Repo plus enough context
 * to construct a `remoteParent` citation automatically.
 *
 * Accepted inputs:
 *   - `http://host:port/streams/<keyHex>` — full URL with explicit key
 *   - `https://host/streams/<keyHex>`     — TLS, default port
 *   - `https://host`                       — TLS, no path; falls through
 *                                            to /api/info for primaryKeyHex
 *   - `host:port`                          — shorthand; assumes http
 *   - `host`                               — shorthand; assumes https
 *
 * `host` in the returned object drops the port when it's the default for
 * the protocol (so `remoteParent.host` is canonically e.g. `streamo.dev`
 * rather than `streamo.dev:443`).
 */
async function fetchSnapshot (input) {
  // Normalize bare host shorthand to a full URL.  The heuristic: if a
  // port is given, assume non-TLS (local dev convention); otherwise
  // assume TLS (production convention).  Callers can always pass a
  // full URL to override.
  let urlString = input
  if (!input.includes('://')) {
    urlString = (input.includes(':') ? 'http://' : 'https://') + input
  }
  const url = new URL(urlString)

  const isDefaultPort =
    (url.protocol === 'http:' && (url.port === '' || url.port === '80')) ||
    (url.protocol === 'https:' && (url.port === '' || url.port === '443'))
  const host = isDefaultPort ? url.hostname : url.host

  // If the URL path matches /streams/<66-hex>, use that; else
  // fetch /api/info for primaryKeyHex.
  const keyMatch = url.pathname.match(/^\/streams\/([0-9a-f]{66})\/?$/)
  let keyHex
  if (keyMatch) {
    keyHex = keyMatch[1]
  } else {
    const infoUrl = new URL('/api/info', url)
    const info = await fetch(infoUrl).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${infoUrl}`)
      return r.json()
    })
    keyHex = info.primaryKeyHex
    if (!keyHex) throw new Error(`${infoUrl} did not return primaryKeyHex`)
  }

  const rawUrl = new URL(`/streams/${keyHex}/raw`, url)
  const buf = await fetch(rawUrl).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${rawUrl}`)
    return r.arrayBuffer()
  })

  const repo = new Repo()
  const writer = repo.makeWritableStream().getWriter()
  await writer.write(new Uint8Array(buf))

  return { repo, host, keyHex }
}

/**
 * A Streamo whose values are commit records.
 *
 * Every write goes through a commit: checkout() → set() → commit(). This makes
 * every connected device an equal author — writes are content-addressed,
 * signed, and append-only. The server is just another peer; the keypair is the
 * identity and the commit log is the source of truth.
 *
 * get() and set() are overridden to be transparent: callers use the same API
 * as Streamo. get() reads from the last commit's dataAddress; set() creates a
 * new commit automatically.
 *
 * The raw streamo (commit log) is what gets synced over WebSocket, S3, and
 * archives. checkout() returns a working Streamo at any commit's dataAddress
 * for read-only inspection or direct use with the explicit commit() API.
 */
export class Repo extends Streamo {
  #signer      = null
  #signerName  = null
  #signing     = false
  #signPending = false
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
  // Both flags surface the value the user tried to write (typically
  // `repo.lastCommit.dataAddress` at the moment of rejection) so the app
  // can quote it back to the user and offer Send-merged / Discard.
  // Neither is auto-cleared.
  #conflictDetected = null
  #pushRejected     = null

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
   * rather than the user data. Walk back past any trailing SIGs so get()
   * and set() operate on the most recent non-SIG chunk (typically a COMMIT).
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
    // The SIG chunk runs from sigStart to sigStart+96 (inclusive). Its first
    // 32 bytes are the chainHash. Slice with end exclusive.
    return this.slice(sigStart, sigStart + 32)
  }

  /**
   * Default commit message attached to every commit made via set() / setRefs().
   * Empty by default — clients opt in to set this for attribution. The chat web
   * client sets 'web' so commits are visibly distinguishable from a CLI
   * client's. Not enforced; explicit commit(working, msg) wins.
   */
  defaultMessage = ''

  /**
   * Attach a signer so every commit is automatically signed.
   * Concurrent commits are batched: if a sign is in flight when another
   * commit lands, one more sign runs after the current one finishes,
   * covering all accumulated commits in a single signature.
   *
   * @param {import('./Signer.js').Signer} signer
   * @param {string} name  stream name passed to signer.keysFor()
   */
  attachSigner (signer, name) {
    this.#signer     = signer
    this.#signerName = name
  }

  #scheduleSign () {
    if (!this.#signer) return
    if (this.#signing) { this.#signPending = true; return }
    this.#signing = true
    this.sign(this.#signer, this.#signerName)
      .then(() => {
        this.#signing = false
        if (this.#signPending) {
          this.#signPending = false
          this.#scheduleSign()
        }
      })
      .catch(() => {
        this.#signing = false
        if (this.byteLength > this.signedLength) this.#scheduleSign()
      })
  }
  /**
   * The latest commit record, or null if nothing has been committed yet.
   * Registers a reactive dependency on the commit log length.
   * @returns {{ message: string, date: Date, dataAddress: number, parent: number|undefined, remoteParent?: { host: string, repo: string, dataAddress: number } }|null}
   */
  get lastCommit () {
    this.recaller.reportKeyAccess(this, 'length')
    // this.valueAddress walks past trailing SIGNATURE chunks (our override),
    // so address lands on the most recent COMMIT (or earlier). We use this
    // rather than this.get() to avoid recursion: get() calls lastCommit.
    const address = this.valueAddress
    if (address < 0) return null
    const value = this.decode(address)
    if (!value || typeof value.message !== 'string' || !(value.date instanceof Date)) return null
    return value
  }

  /**
   * Decode the value at a path, reading from the last commit's dataAddress.
   * Falls back to Streamo.get() if no commits exist yet.
   *
   * Registers reactive dependencies so watchers re-run when new commits land.
   *
   * @param {...(number|string)} args
   * @returns {any}
   */
  get (...args) {
    if (typeof args[0] === 'number') return super.get(...args)
    const commit = this.lastCommit  // registers 'length' dependency
    if (!commit) return super.get(...args)
    this.recaller.reportKeyAccess(this, JSON.stringify(args))
    if (args.length === 0) return this.decode(commit.dataAddress)
    let value = this.decode(commit.dataAddress)
    for (const key of args) {
      if (value == null) return undefined
      value = value[key]
    }
    return value
  }

  /**
   * Write a value by creating a new commit: checkout → set → commit.
   *
   * Signature: set([address,] ...path, value)  — same as Streamo.set().
   * Path-level reactive mutations are fired after commit so watchers only
   * watching specific paths get precise notifications.
   *
   * @param {...(number|string|any)} args
   * @returns {number} address of the new commit record
   */
  set (...args) {
    if (typeof args[0] === 'number') return super.set(...args)
    const prevDataAddress = this.lastCommit?.dataAddress
    const working = this.checkout()
    working.set(...args)
    const result = this.commit(working, this.defaultMessage)
    const newDataAddress = this.lastCommit?.dataAddress
    for (const changed of changedPaths(this, prevDataAddress, newDataAddress)) {
      this.recaller.reportKeyMutation(this, JSON.stringify(changed))
    }
    return result
  }

  /**
   * Like Streamo.getRefs() but reads from the last commit's dataAddress.
   *
   * @param {...string} path
   * @returns {Object|number|undefined}
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
   * Like Streamo.setRefs() but auto-commits via checkout → setRefs → commit.
   *
   * @param {...(string|number)} args  ...path, address
   * @returns {number} address of the new commit record
   */
  setRefs (...args) {
    const prevDataAddress = this.lastCommit?.dataAddress
    const working = this.checkout()
    working.setRefs(...args)
    const result = this.commit(working, this.defaultMessage)
    const newDataAddress = this.lastCommit?.dataAddress
    for (const changed of changedPaths(this, prevDataAddress, newDataAddress)) {
      this.recaller.reportKeyMutation(this, JSON.stringify(changed))
    }
    return result
  }

  /**
   * Clone the repository at the last commit's data address.
   * The returned Streamo's get() immediately returns the last committed value.
   * Returns an empty Streamo if nothing has been committed yet.
   * @returns {Streamo}
   */
  checkout () {
    const commit = this.lastCommit
    if (!commit) return new Streamo()
    return this.clone(commit.dataAddress, { name: 'checkout' })
  }

  /**
   * The committed data from the last commit, decoded.
   * Returns undefined if nothing has been committed yet.
   * @returns {any}
   */
  get files () {
    const commit = this.lastCommit
    if (!commit) return undefined
    return this.decode(commit.dataAddress)
  }

  /**
   * Iterate commits from newest to oldest.
   * @yields {{ message: string, date: Date, dataAddress: number, parent: number|undefined }}
   */
  * history () {
    let commit = this.lastCommit
    while (commit) {
      yield commit
      commit = commit.parent !== undefined ? this.decode(commit.parent) : null
    }
  }

  /**
   * Copy the current value of workingStreamo into the repository and append a
   * commit record referencing it by address.
   *
   * Uses super.valueAddress (skipping any trailing signatures) to find the
   * correct parent commit address rather than byteLength - 1, which could
   * point to a signature chunk when sign-in auto-signs after each commit.
   *
   * When `options.remoteParent` is set, the commit cites another author's
   * value: `{ host, repo, dataAddress }`. The local commit is still signed
   * by us and append-only on our chain — `remoteParent` is a footnote, not
   * a merge. Anyone holding the cited stream can verify the citation by
   * decoding the value at `remoteParent.dataAddress` in that stream.
   *
   * `options.date` overrides the default "now" — useful when replaying
   * pre-existing history (e.g. seeding a streamo from git log).
   *
   * @param {Streamo} workingStreamo
   * @param {string} [message='']
   * @param {{ remoteParent?: { host: string, repo: string, dataAddress: number }, date?: Date }} [options]
   * @returns {number} address of the new commit record
   */
  commit (workingStreamo, message = '', options = {}) {
    if (workingStreamo.byteLength === 0) throw new Error('nothing to commit')
    const { remoteParent, date = new Date() } = options
    const parentAddr = super.valueAddress
    const parent = parentAddr >= 0 ? parentAddr : undefined
    // Use valueAddress (the explicit top-value pointer), not byteLength-1.
    // When working.set encodes a value whose outermost subcode already exists
    // in working's content map (dedup — e.g. toggling back to a state the
    // repo has seen before), byteLength does NOT grow but valueAddress
    // correctly points at the existing address of the just-set value.
    // byteLength-1 would land on an unchanged tail, citing the wrong data.
    const dataAddress = this.copyFrom(workingStreamo, workingStreamo.valueAddress)
    const record = { message, date, dataAddress, parent }
    if (remoteParent !== undefined) record.remoteParent = remoteParent
    const code = this.encode(record)
    const result = this.append(code)
    this.#scheduleSign()
    return result
  }

  /**
   * Incorporate a slice of `source`'s value into this repo as a single
   * signed commit, with `remoteParent` set to cite the source.
   *
   * **Mode**: this version supports only `policy: 'replace'` — source's
   * value at `from` REPLACES our value at `into`.  Sibling keys at `into`'s
   * parent are preserved (because `commit` works on a path-set into the
   * working stream, not a whole-value overwrite).  The descending
   * attribute-walk policies (`'theirs'`, `'ours'`, `'throw'`) are reserved
   * in the API but not yet implemented — they need real workloads to
   * settle their defaults (absent-vs-deleted, Uint8Array semantics, etc).
   *
   * **Two shapes fall out naturally:**
   *   - *Fork*  — merge into an empty repo → no local parent + remoteParent
   *   - *Pull-overwrite* — merge into an existing chain → both set
   *
   * @param {Repo|string} source — the repo to read from.  When a string,
   *   resolves as an HTTP URL (`http(s)://host[:port]/streams/<keyHex>`)
   *   or a host shorthand (`host[:port]`, with `/api/info` discovering
   *   the primary key).  URL form auto-fills `remoteParent.host` and
   *   `remoteParent.repo` from the resolved URL when the caller leaves
   *   them blank.
   * @param {object} options
   * @param {string|Array<string|number>} [options.from=[]] — path on source
   *   to read; `[]` or omitted means the whole value. String shorthand
   *   `'files'` is normalized to `['files']`.
   * @param {string|Array<string|number>} [options.into=options.from] — path
   *   on this repo to write at
   * @param {'replace'} [options.policy='replace'] — only `'replace'` is
   *   implemented in this version
   * @param {{ host: string, repo: string, dataAddress?: number }}
   *   options.remoteParent — REQUIRED.  `host` and `repo` describe the
   *   source's location and identity (the Repo class doesn't store either
   *   itself, so callers provide them).  `dataAddress` defaults to
   *   `source.lastCommit.dataAddress` (the citation points at source's
   *   most recent value).
   * @param {string} [options.message] — commit message; defaults to either
   *   `"fork from <host>"` (empty target) or `"merge from <host>"` (existing)
   * @returns {number} address of the new commit record
   */
  async merge (source, options = {}) {
    // URL-source: resolve to an in-memory Repo, and auto-fill the
    // remoteParent context from the URL itself.  The URL form encodes
    // enough about the source (host + keyHex) that requiring the caller
    // to also pass remoteParent would be redundant — but they can
    // override if they want (e.g. to record a different canonical host).
    if (typeof source === 'string') {
      const { repo: fetched, host, keyHex } = await fetchSnapshot(source)
      source = fetched
      options = {
        ...options,
        remoteParent: options.remoteParent ?? { host, repo: keyHex }
      }
    }

    const normalizePath = p => p == null ? [] : Array.isArray(p) ? p : [p]
    const from = normalizePath(options.from)
    const into = normalizePath(options.into ?? options.from)
    const { policy = 'replace', remoteParent, message } = options

    if (policy !== 'replace') {
      throw new Error(`Repo.merge: policy '${policy}' is reserved but not yet implemented; only 'replace' is supported in this version`)
    }
    if (!remoteParent || typeof remoteParent !== 'object' || !remoteParent.host || !remoteParent.repo) {
      throw new Error('Repo.merge: options.remoteParent is required as { host, repo, dataAddress? }')
    }

    // Citation: the address on source's stream we're incorporating from.
    // Defaults to source's latest commit's data address; callers can cite
    // a specific historical address via remoteParent.dataAddress.
    const sourceLast = source.lastCommit
    if (!sourceLast && remoteParent.dataAddress === undefined) {
      throw new Error('Repo.merge: source has no commits and no explicit remoteParent.dataAddress given')
    }
    const citationAddress = remoteParent.dataAddress ?? sourceLast.dataAddress
    const citation = { host: remoteParent.host, repo: remoteParent.repo, dataAddress: citationAddress }

    // Read source's value at the citation, walk into `from`.
    let sourceValue = source.decode(citationAddress)
    for (const key of from) {
      if (sourceValue == null || typeof sourceValue !== 'object') {
        throw new Error(`Repo.merge: source has no value at path [${from.join('.')}]`)
      }
      sourceValue = sourceValue[key]
    }
    if (sourceValue === undefined) {
      throw new Error(`Repo.merge: source has no value at path [${from.join('.')}]`)
    }

    // Apply 'replace': set our value at `into` to source's slice.  Empty
    // target needs the wrapping object materialized (same pattern as
    // fileSync's setRepoFiles for an empty repo).
    const working = this.checkout()
    if (into.length === 0) {
      working.set(sourceValue)
    } else if (working.get() === undefined) {
      let wrapped = sourceValue
      for (let i = into.length - 1; i >= 0; i--) {
        wrapped = { [into[i]]: wrapped }
      }
      working.set(wrapped)
    } else {
      working.set(...into, sourceValue)
    }

    const wasEmpty = !this.lastCommit
    const defaultMessage = wasEmpty
      ? `fork from ${remoteParent.host}`
      : `merge from ${remoteParent.host}`
    return this.commit(working, message ?? defaultMessage, { remoteParent: citation })
  }

  // ── Signing / verification (identity-aware; lives on Repo, not Streamo) ──
  // Streamo is the codec; it doesn't know about keys, sigs, or who signed.
  // Everything that takes a Signer / Signature / pubkey lives here.

  /**
   * Sign every byte appended since the last SIG (or from the start).
   * Computes `chainHash = sha256(committedChainHash || sha256(newBytes))`,
   * signs it, and appends a SIGNATURE chunk carrying the chainHash + the
   * signature bytes. Two sha256 calls regardless of how many chunks were
   * appended since the last sig.
   *
   * @param {import('./Signer.js').Signer} signer
   * @param {string} streamoName
   * @returns {Promise.<Signature>}
   */
  async sign (signer, streamoName) {
    const before = this.byteLength
    const newBytes = this.slice(this.signedLength, this.byteLength)
    const chainHash = await chainHashOf(this.committedChainHash, newBytes)
    const compactRawBytes = await signer.sign(streamoName, chainHash)
    if (this.byteLength !== before) throw new Error('repo was modified while signing')
    const sig = new Signature(chainHash, compactRawBytes)
    this.append(this.encode(sig))
    return sig
  }

  /**
   * Stateless crypto-check: is `sig` a valid signature over `sig.chainHash`
   * by `publicKey`? Doesn't re-verify chain consistency — that's the
   * RepoSerializer's job at the relay (chain check happens there before
   * any incoming batch lands).
   *
   * @param {Signature} sig
   * @param {Uint8Array} publicKey
   * @returns {Promise.<boolean>}
   */
  async verify (sig, publicKey) {
    return verifySignature(publicKey, sig.chainHash, sig.compactRawBytes)
  }

  // ── The relay-inbound writer ───────────────────────────────────────────
  // Receives wire bytes from a trusted relay. The relay's RepoSerializer
  // has already chain-verified and crypto-verified, so this writer skips
  // those checks. The only thing it catches is the push-in-flight race
  // (local content past last shared sig + incoming bytes whose refs
  // assume otherwise) — handled by the alignment check at SIG arrival.

  /**
   * Reactive: true once makeRelayInboundStream has rejected an incoming
   * batch because our local store has content past the last shared sig
   * (a push-in-flight race: we wrote locally, the relay sent down other
   * bytes before knowing about our push, our push will likely be
   * rejected). This is a *conflict*, not a fork — a fork is a deliberate
   * new Repo with a lineage note; a conflict is the runtime "these bytes
   * can't be appended" failure.
   */
  get conflictDetected () {
    this.recaller.reportKeyAccess(this, 'conflictDetected')
    return this.#conflictDetected
  }

  /**
   * Reactive: `null` until a push from this client to the relay is rejected;
   * then `{ reason }` describing why. Set by the registry-sync layer when a
   * `{type: 'reject', key, reason}` control message arrives from the relay.
   *
   * Separate from `conflictDetected` (which fires when the *local* verifier
   * catches divergence on incoming bytes). `pushRejected` is the
   * authoritative "the relay said no" signal — the most reliable indicator
   * a client's local commits won't make it to the top without intervention.
   */
  get pushRejected () {
    this.recaller.reportKeyAccess(this, 'pushRejected')
    return this.#pushRejected
  }

  /**
   * Setter for the registry-sync layer to call when a reject message lands.
   * Not part of the user-facing Repo API; named with a leading underscore
   * by convention. Pass `null` to clear (e.g. after a successful recovery).
   */
  _setPushRejected (value) {
    this.#pushRejected = value
    this.recaller.reportKeyMutation(this, 'pushRejected')
  }

  /**
   * @override Wipes local bytes (via Streamo._reset) AND clears the
   * divergence flags. Used by recovery-UX orchestration: an app stashes
   * `repo.decode(repo.{push,conflict}.dataAddress)` first, then calls
   * `_reset()` to drop the local-only state, then re-subscribes to take
   * the relay's view, then re-applies the stashed value via `set()`.
   */
  _reset () {
    super._reset()
    this.#conflictDetected = null
    this.#pushRejected = null
    this.recaller.reportKeyMutation(this, 'conflictDetected')
    this.recaller.reportKeyMutation(this, 'pushRejected')
  }

  /**
   * Like Streamo.makeWritableStream(), for the client-side receive path
   * from a trusted relay.
   *
   * "What comes down is always from the top, and always correct" — the
   * relay's RepoSerializer has already validated the chain and the
   * signatures, so we don't repeat that work here. The only thing the
   * client *can't* know without local context is whether the incoming
   * batch will land at the right byte position: if the client has
   * locally-signed content past the last shared sig (e.g. a push in
   * flight), the incoming chunks would land at a position the wire's
   * references don't expect, corrupting decodes.
   *
   * So this stream parses framing, detects SIGs by codec, and at SIG
   * arrival checks alignment: local byteLength must equal the wire's
   * position right before the staged batch. If yes, append batch + sig.
   * If no, raise `conflictDetected` (a push-in-flight race lost) and
   * throw — the connection will be torn down by handleWriteError, and
   * the app can recover via the `pushRejected` flag (typically arriving
   * over the JSON control channel shortly after).
   *
   * @param {number} [maxFrameSize]
   * @returns {WritableStream}
   */
  makeRelayInboundStream (maxFrameSize = 64 * 1024 * 1024) {
    const self = this
    let buf = new Uint8Array(0)
    let bufOffset = 0
    let staged = []                                  // not-already-present chunks awaiting a covering SIG
    // Anchor on local state — the sender (relay) knows our offset/chainHash from
    // the subscribe handshake and is sending bytes from there. So our wire-side
    // pendingChainHash starts equal to our local committedChainHash; each sig
    // arriving from the wire advances both in lockstep. Local writes (e.g. the
    // user signs a commit) advance committedChainHash without touching
    // pendingChainHash, which is exactly when the alignment check should fire.
    let pendingChainHash = self.committedChainHash
    return new WritableStream({
      async write (incoming) {
        // Compact leftover + incoming into a fresh buf, reset offset.
        // Hot loop uses subarray (a view, not a copy) so each chunk
        // extraction is O(1) — the previous `buf = buf.slice(rest)`
        // pattern was O(N) per chunk, O(N²) per batched frame.
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
          if (len > maxFrameSize) throw new Error(`malformed frame: length ${len} exceeds ${maxFrameSize}`)
          if (buf.length - bufOffset < 4 + len) break
          const code = buf.subarray(bufOffset + 4, bufOffset + 4 + len)
          bufOffset += 4 + len

          const alreadyHave = self.addressOf(code) !== undefined
          const codec = self.footerToCodec[code.at(-1)]

          if (codec?.type === 'SIGNATURE') {
            // Alignment check (chain-hash equality): only matters when we'd
            // actually append new chunks. If staged is empty, this sig
            // closes an alreadyHave batch (a resync echo) — safe to skip.
            //
            // When the wire is about to extend the chain past pendingChainHash
            // (its previous sig's chainHash), our local committedChainHash
            // must equal pendingChainHash too — otherwise we have local
            // commits the wire doesn't know about and the staged chunks
            // would land on top of them at wrong addresses.
            if (staged.length > 0) {
              if (!arraysEqual(pendingChainHash, self.committedChainHash)) {
                self.#conflictDetected = { dataAddress: self.lastCommit?.dataAddress }
                self.recaller.reportKeyMutation(self, 'conflictDetected')
                throw new Error(
                  'local store diverged from incoming chain: ' +
                  'our most recent sig\'s chainHash does not equal the wire\'s previous sig\'s chainHash ' +
                  '(local content past the last shared sig — push in flight or push got beaten)'
                )
              }
            }
            for (const c of staged) self.append(c)
            staged = []
            if (!alreadyHave) self.append(code)
            // Advance: the SIG chunk's first 32 bytes are its chainHash.
            // No decode needed — read the bytes directly.
            pendingChainHash = code.slice(0, 32)
          } else if (!alreadyHave) {
            staged.push(code)
          }
        }
      }
    })
  }

}
