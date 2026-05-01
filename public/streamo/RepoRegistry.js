import { Streamo } from './Streamo.js'
import { Repo } from './Repo.js'

/**
 * Manages a collection of Repos keyed by hex-encoded public key.
 *
 * Accepts an optional factory function that is called whenever a new repository
 * is opened. The factory receives the publicKeyHex and should return a
 * (optionally async) Repo with whatever persistence or sync wired up.
 *
 * If no factory is provided, plain in-memory Repos are created.
 *
 * Examples:
 *
 *   // plain in-memory
 *   new RepoRegistry()
 *
 *   // archive-backed
 *   new RepoRegistry(async key => {
 *     const repo = new Repo()
 *     await archiveSync(repo, dataDir, key)
 *     return repo
 *   })
 *
 *   // S3-backed
 *   new RepoRegistry(async key => {
 *     const repo = new Repo()
 *     await s3Sync(repo, key, s3Config)
 *     return repo
 *   })
 */
export class RepoRegistry {
  #streams = new Map()
  #factory
  #openCallbacks = new Set()

  /** @param {(publicKeyHex: string) => Repo | Promise<Repo>} [factory] */
  constructor (factory = () => new Repo()) {
    this.#factory = factory
  }

  /**
   * Return the Repo for `publicKeyHex`, creating it via the factory if
   * this is the first call for that key.
   *
   * The repository is registered immediately (before the factory resolves) so
   * concurrent open() calls always return the same instance.
   *
   * @param {string} publicKeyHex
   * @returns {Promise<Repo>}
   */
  async open (publicKeyHex) {
    if (this.#streams.has(publicKeyHex)) return this.#streams.get(publicKeyHex)
    let resolve
    const placeholder = new Promise(r => { resolve = r })
    this.#streams.set(publicKeyHex, placeholder)
    const stream = await this.#factory(publicKeyHex)
    this.#streams.set(publicKeyHex, stream)
    resolve(stream)
    for (const cb of this.#openCallbacks) cb(publicKeyHex, stream)
    return stream
  }

  /** Register a callback invoked whenever a new repo is fully opened. */
  onOpen (cb) { this.#openCallbacks.add(cb) }

  /** Remove a previously registered onOpen callback. */
  offOpen (cb) { this.#openCallbacks.delete(cb) }

  /**
   * Return an already-open Repo, or undefined if not opened yet.
   * @param {string} publicKeyHex
   * @returns {Repo|undefined}
   */
  get (publicKeyHex) {
    const entry = this.#streams.get(publicKeyHex)
    return entry instanceof Streamo ? entry : undefined
  }

  /** Number of currently open (or opening) repos. */
  get size () { return this.#streams.size }

  /** Iterate over [publicKeyHex, Repo] pairs (only fully-opened). */
  [Symbol.iterator] () {
    return (function * (map) {
      for (const [k, v] of map) {
        if (v instanceof Streamo) yield [k, v]
      }
    })(this.#streams)
  }
}
