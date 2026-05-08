/**
 * @file Repo — a Streamo whose every set() becomes a signed commit.
 *
 * Each commit is a record { message, date, dataAddress, parent }. The
 * commit log is what flows over the wire during sync. attachSigner
 * makes commits sign automatically, with concurrent commits batched
 * into one signature.
 *
 * See design.md §8.
 */
import { Recaller } from './utils/Recaller.js'
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
   * @returns {{ message: string, date: Date, dataAddress: number, parent: number|undefined }|null}
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
    return this.clone(commit.dataAddress, new Recaller('checkout'))
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
   * @param {Streamo} workingStreamo
   * @param {string} [message='']
   * @returns {number} address of the new commit record
   */
  commit (workingStreamo, message = '') {
    if (workingStreamo.byteLength === 0) throw new Error('nothing to commit')
    const parentAddr = super.valueAddress
    const parent = parentAddr >= 0 ? parentAddr : undefined
    const dataAddress = this.copyFrom(workingStreamo, workingStreamo.byteLength - 1)
    const code = this.encode({ message, date: new Date(), dataAddress, parent })
    const result = this.append(code)
    this.#scheduleSign()
    return result
  }
}
