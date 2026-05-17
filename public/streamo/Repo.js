/**
 * @file Repo — a Streamo whose every set() becomes a signed commit.
 *
 * Each commit is a record { message, date, dataAddress, parent,
 * remoteParent? }. The commit log is what flows over the wire during
 * sync. attachSigner makes commits sign automatically, with concurrent
 * commits batched into one signature.
 *
 * The optional `remoteParent` field cites another author's value at a
 * specific content address — `{ host, repo, dataAddress }`. It's a
 * cryptographic footnote: anyone with the cited stream can verify the
 * value really was at that address. The chain stays single-author-
 * signed; remote citations don't break the invariant.
 *
 * Two natural shapes emerge:
 *   - pure-copy commit  (no local parent, remoteParent set) — the
 *     start of a fork: "I'm beginning my chain from their value"
 *   - mixed commit      (both parent and remoteParent set) — "I'm
 *     continuing my chain while pulling this in from over there"
 *
 * See design.md §8.
 */
import { Streamo, changedPaths } from './Streamo.js'

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
    // Use super.valueAddress (Streamo impl) to bypass our get() override and
    // avoid a circular dependency: our get() calls lastCommit, lastCommit
    // must not call our get().
    const address = super.valueAddress
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
    const dataAddress = this.copyFrom(workingStreamo, workingStreamo.byteLength - 1)
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
   * @param {Repo} source — the repo to read from (in-memory; URL-source
   *   support is a later nibble)
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
  merge (source, options = {}) {
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
}
