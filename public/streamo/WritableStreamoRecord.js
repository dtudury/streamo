/**
 * @file WritableStreamoRecord — a StreamoRecord you can author into.
 *
 * **Subclass for author capability.** A plain `StreamoRecord` is the
 * read-only definitional minimum: a Streamo whose bytes interpret as a
 * signed chain — readable, traversable, verifiable, but not writable.
 * WritableStreamoRecord adds the author surface: attachSigner, set,
 * setRefs, checkout, commit, merge, update, sign.
 *
 * **Why subclass for author, not compose:** authorability is type-level
 * (knowable at construction). The explorer holds StreamoRecord (peer
 * Records it subscribed to and can't sign for); the chat app holds
 * WritableStreamoRecord for the user's own identity Record. Different
 * intents, different types — the API refuses misuse loudly instead of
 * surfacing it as a runtime `attachSigner-was-never-called` surprise.
 *
 * **`locallyAuthoredOffset` lives here.** The low-water mark of bytes
 * this process authored. Streamo itself doesn't know about authorship —
 * it's a codec. StreamoRecord knows about *chains* but not specifically
 * about *which bytes I authored*. That concept is purely a property of
 * the writer, so it lives on the writer's class. Apps that hold a
 * Writable can read `repo.locallyAuthoredOffset` to know "have I signed
 * for anything this session" — a substrate primitive for future
 * reconnect-bandwidth optimization, and the architectural word for
 * "received vs. authored" that the corruption-fight footgun was missing.
 */
import { Streamo, changedPaths } from './Streamo.js'
import { StreamoRecord } from './StreamoRecord.js'
import { Signature } from './Signature.js'

// Chain-hash helpers (sign-side mirrors StreamoRecord's verify-side
// helpers; both fold sha256 over `prev || sha256(newBytes)` so the
// chain identity costs two sha256 calls per signature regardless of
// how many chunks newBytes contains).
const cryptoSubtle = typeof crypto !== 'undefined' ? crypto.subtle : (await import('crypto')).webcrypto.subtle
async function sha256 (bytes) {
  return new Uint8Array(await cryptoSubtle.digest('SHA-256', bytes))
}
function arraysEqual (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
async function chainHashOf (prev, newBytes) {
  const newBytesHash = await sha256(newBytes)
  const combined = new Uint8Array(64)
  combined.set(prev, 0)
  combined.set(newBytesHash, 32)
  return await sha256(combined)
}

/**
 * Fetch a StreamoRecord snapshot from an HTTP source URL or host shorthand.
 * Returns `{ repo, host, keyHex }` — the loaded slim StreamoRecord plus
 * enough context to construct a `remoteParent` citation automatically.
 *
 * The fetched Record is read-only (it's the source we're merging FROM,
 * not a target we author into), so it's instantiated as the slim
 * StreamoRecord.
 *
 * Accepted inputs:
 *   - `http://host:port/streams/<keyHex>` — full URL with explicit key
 *   - `https://host/streams/<keyHex>`     — TLS, default port
 *   - `https://host`                       — TLS, no path; falls through
 *                                            to /api/info for primaryKeyHex
 *   - `host:port`                          — shorthand; assumes http
 *   - `host`                               — shorthand; assumes https
 */
async function fetchSnapshot (input) {
  let urlString = input
  if (!input.includes('://')) {
    urlString = (input.includes(':') ? 'http://' : 'https://') + input
  }
  const url = new URL(urlString)

  const isDefaultPort =
    (url.protocol === 'http:' && (url.port === '' || url.port === '80')) ||
    (url.protocol === 'https:' && (url.port === '' || url.port === '443'))
  const host = isDefaultPort ? url.hostname : url.host

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

  const repo = new StreamoRecord()
  const writer = repo.makeWritableStream().getWriter()
  await writer.write(new Uint8Array(buf))

  return { repo, host, keyHex }
}

export class WritableStreamoRecord extends StreamoRecord {
  #signer      = null
  #signerName  = null
  #signing     = false
  #signPending = false

  // Low-water mark of bytes this process authored locally — "the smallest
  // offset at which I appended a byte I signed for." Apps can read
  // `repo.locallyAuthoredOffset` to know "have I authored anything this
  // session" (Infinity means no). Initial value Infinity = nothing
  // authored yet. Archive replay, wire-inbound, and any other "received
  // not authored" path leave it at Infinity. Only the author methods
  // here call `_markAuthoredAtOffset` to lower the mark — they capture
  // byteLength BEFORE the append and pass that, so the mark settles at
  // the first authored byte.
  //
  // The corruption-fight motivator (2026-05-26): a watch.js process
  // loaded its user's Record over the wire and, on every Stop-hook
  // respawn, re-pushed those bytes to the relay. The substrate had no
  // word for "I authored this" vs "I received this." The observer-
  // doesn't-push guard in registrySync.subscribe handles the coarse
  // case (slim StreamoRecord never pushes); this offset is the fine-
  // grained "which bytes specifically did I sign for" word, available
  // to apps + reserved for future bandwidth optimizations.
  #locallyAuthoredOffset = Infinity

  /**
   * Default commit message attached to every commit made via set() / setRefs().
   * Empty by default — clients opt in to set this for attribution. The chat web
   * client sets 'web' so commits are visibly distinguishable from a CLI
   * client's. Not enforced; explicit commit(working, msg) wins.
   */
  defaultMessage = ''

  /**
   * Reactive: the low-water mark of bytes this process authored locally.
   * `Infinity` means "nothing authored yet" (the default; what archive
   * replay and wire-inbound leave it at). Otherwise, the smallest byte
   * offset at which an author method appended.
   */
  get locallyAuthoredOffset () {
    this.recaller.reportKeyAccess(this, 'locallyAuthoredOffset')
    return this.#locallyAuthoredOffset
  }

  /**
   * Lower the mark to `offset` if it's currently higher. Idempotent and
   * monotonic-downward. Called by the author methods with the
   * byteLength captured BEFORE the author append. Internal —
   * leading underscore by convention.
   */
  _markAuthoredAtOffset (offset) {
    if (offset >= this.#locallyAuthoredOffset) return
    this.#locallyAuthoredOffset = offset
    this.recaller.reportKeyMutation(this, 'locallyAuthoredOffset')
  }

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
    // Once the underlying Addressifier is closed, any append (including
    // SIG appends from sign()) will throw "cannot append to a closed
    // Addressifier" — and the catch below would reschedule us forever.
    // Bail out: closed streams stop trying to sign. The remaining
    // unsigned tail stays unsigned; that's the caller's call when they
    // chose to close.
    if (this.isClosed) return
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
   * Write a value by creating a new commit: checkout → set → commit.
   *
   * Signature: set([address,] ...path, value)  — same as Streamo.set().
   * Path-level reactive mutations are fired after commit so watchers only
   * watching specific paths get precise notifications.
   */
  set (...args) {
    if (typeof args[0] === 'number') return Streamo.prototype.set.apply(this, args)
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
   * Like Streamo.setRefs() but auto-commits via checkout → setRefs → commit.
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
   * Copy the current value of workingStreamo into the repository and append
   * a commit record referencing it by address.
   *
   * When `options.remoteParent` is set, the commit cites another author's
   * value: `{ host, repo, dataAddress }`. The local commit is still signed
   * by us and append-only on our chain — `remoteParent` is a footnote, not
   * a merge. Anyone holding the cited stream can verify the citation by
   * decoding the value at `remoteParent.dataAddress` in that stream.
   *
   * `options.date` overrides the default "now" — useful when replaying
   * pre-existing history (e.g. seeding a streamo from git log).
   */
  commit (workingStreamo, message = '', options = {}) {
    if (workingStreamo.byteLength === 0) throw new Error('nothing to commit')
    const { remoteParent, date = new Date() } = options
    // super.valueAddress (StreamoRecord's walk-past-trailing-SIGs override)
    // is the right citation for the parent commit. Raw byteLength-1
    // would land on a SIG chunk when auto-signing has just fired.
    const parentAddr = super.valueAddress
    const parent = parentAddr >= 0 ? parentAddr : undefined
    // Capture byteLength BEFORE any author append so
    // locallyAuthoredOffset settles at the first byte THIS commit
    // contributed. The mark is monotonic-downward; later commits don't
    // move it back up.
    const authoredFrom = this.byteLength
    const dataAddress = this.copyFrom(workingStreamo, workingStreamo.valueAddress)
    const record = { message, date, dataAddress, parent }
    if (remoteParent !== undefined) record.remoteParent = remoteParent
    const code = this.encode(record)
    const result = this.append(code)
    this._markAuthoredAtOffset(authoredFrom)
    this.#scheduleSign()
    return result
  }

  /**
   * Incorporate a slice of `source`'s value into this repo as a single
   * signed commit, with `remoteParent` set to cite the source.
   *
   * **Mode**: this version supports only `policy: 'replace'` — source's
   * value at `from` REPLACES our value at `into`. Sibling keys at
   * `into`'s parent are preserved.
   *
   * **Two shapes fall out naturally:**
   *   - *Fork*  — merge into an empty repo → no local parent + remoteParent
   *   - *Pull-overwrite* — merge into an existing chain → both set
   */
  async merge (source, options = {}) {
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
      throw new Error(`WritableStreamoRecord.merge: policy '${policy}' is reserved but not yet implemented; only 'replace' is supported in this version`)
    }
    if (!remoteParent || typeof remoteParent !== 'object' || !remoteParent.host || !remoteParent.repo) {
      throw new Error('WritableStreamoRecord.merge: options.remoteParent is required as { host, repo, dataAddress? }')
    }

    const sourceLast = source.lastCommit
    if (!sourceLast && remoteParent.dataAddress === undefined) {
      throw new Error('WritableStreamoRecord.merge: source has no commits and no explicit remoteParent.dataAddress given')
    }
    const citationAddress = remoteParent.dataAddress ?? sourceLast.dataAddress
    const citation = { host: remoteParent.host, repo: remoteParent.repo, dataAddress: citationAddress }

    let sourceValue = source.decode(citationAddress)
    for (const key of from) {
      if (sourceValue == null || typeof sourceValue !== 'object') {
        throw new Error(`WritableStreamoRecord.merge: source has no value at path [${from.join('.')}]`)
      }
      sourceValue = sourceValue[key]
    }
    if (sourceValue === undefined) {
      throw new Error(`WritableStreamoRecord.merge: source has no value at path [${from.join('.')}]`)
    }

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

  /**
   * Sign every byte appended since the last SIG (or from the start).
   * Computes `chainHash = sha256(committedChainHash || sha256(newBytes))`,
   * signs it, and appends a SIGNATURE chunk carrying the chainHash + the
   * signature bytes.
   */
  async sign (signer, streamoName) {
    const before = this.byteLength
    const newBytes = this.slice(this.signedLength, this.byteLength)
    const chainHash = await chainHashOf(this.committedChainHash, newBytes)
    const compactRawBytes = await signer.sign(streamoName, chainHash)
    if (this.byteLength !== before) throw new Error('repo was modified while signing')
    const sig = new Signature(chainHash, compactRawBytes)
    // Sign is an author act: lower the locallyAuthoredOffset to the
    // first byte the SIG covers. If a commit just bumped the mark to
    // this same `before` offset, this call is a no-op (idempotent).
    this._markAuthoredAtOffset(before)
    this.append(this.encode(sig))
    return sig
  }

  /**
   * Wait for `committedChainHash` of the upstream relay to reach
   * `target` — i.e., the relay confirmed the bytes that produced that
   * chainHash. Resolves on match. Rejects if `pushRejected` fires
   * (the relay said no) or `conflictDetected` fires (local alignment
   * caught divergence on incoming bytes).
   *
   * Internal helper; used by `update()` to await push acceptance.
   *
   * @param {Uint8Array} target  the 32-byte chainHash to wait for
   */
  _awaitChainHash (target) {
    return new Promise((resolve, reject) => {
      const fn = () => {
        const rejected = this.pushRejected
        const conflict = this.conflictDetected
        const relayHash = this.relayChainHash
        if (rejected) {
          this.recaller.unwatch(fn)
          const err = new Error(`push rejected: ${rejected.reason ?? 'unknown reason'}`)
          err.pushRejected = rejected
          reject(err)
          return
        }
        if (conflict) {
          this.recaller.unwatch(fn)
          const err = new Error('local store diverged from incoming chain')
          err.conflictDetected = conflict
          reject(err)
          return
        }
        if (relayHash && arraysEqual(relayHash, target)) {
          this.recaller.unwatch(fn)
          resolve()
        }
      }
      this.recaller.watch('repo:_awaitChainHash', fn)
    })
  }

  /**
   * Apply `updateFn` to the Record's current value, set the result,
   * await the relay's ack. On conflict (`pushRejected`), reset local
   * state via the attached session's resync, await re-anchor from the
   * relay's authoritative stream, re-apply against the new current,
   * retry. Up to `retries` times.
   *
   * The conflict-safe write primitive. Replaces the
   * `const c = repo.get(); repo.set({...c, x})` pattern that races
   * against concurrent writers.
   *
   * Requires a session attached via `_attachSession` (set by
   * `session.subscribe`). Without one, throws on the first conflict
   * since there's no path to retry.
   */
  async update (updateFn, options = {}) {
    const { retries = 3, onConflict = null } = options
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const current = this.get()
      const next = updateFn(current)
      this.set(next)
      const target = this.committedChainHash
      try {
        await this._awaitChainHash(target)
        return  // ack received; we're in sync with the relay
      } catch (err) {
        lastError = err
        if (attempt === retries) break
        const session = this._session
        if (!session) break  // no path to retry without a session
        this._reset()
        await session._resyncRepo(this.publicKeyHex)
      }
    }
    const finalState = { pushRejected: this.pushRejected, attempts: retries + 1 }
    if (onConflict) return onConflict(finalState)
    const err = new Error(
      `repo.update: exhausted ${retries + 1} attempts; ${lastError?.message ?? 'unknown'}` +
      (this._session ? '' : ' (no session attached — update requires session.subscribe for retry path)')
    )
    err.pushRejected = this.pushRejected
    throw err
  }

  /** @override Also resets locallyAuthoredOffset to Infinity. */
  _reset () {
    super._reset()
    this.#locallyAuthoredOffset = Infinity
    this.recaller.reportKeyMutation(this, 'locallyAuthoredOffset')
  }
}
