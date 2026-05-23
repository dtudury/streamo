import { Streamo } from './Streamo.js'
import { Repo } from './Repo.js'
import { Recaller } from './utils/Recaller.js'

/**
 * Manages a collection of Repos keyed by hex-encoded public key. The
 * registry owns a shared Recaller (passed in or freshly created); the
 * default factory creates Repos that *share* this Recaller, so reading
 * any repo's state inside a reactive cell auto-subscribes the cell to
 * chunk arrivals — no bridge needed, no explicit dep/fire calls.
 *
 * Iteration, `get(keyHex)`, and `size` all report access on
 * `(registry, 'keys')`, so slots iterating the registry auto-subscribe
 * to new-repo opens. `open()` fires the same key when a repo lands.
 *
 * Custom factories that don't pass the registry's Recaller through
 * (e.g. `async key => { const r = new Repo(); await archiveSync(r); }`)
 * still get a fallback bridge — RepoRegistry watches their per-repo
 * Recaller and forwards chunk arrivals onto our 'keys' key. Coarser
 * than the shared-Recaller path (every iteration-touching slot wakes
 * on every chunk arrival from any non-shared repo), but it works.
 *
 * Examples:
 *
 *   // plain in-memory, sharing the app's Recaller:
 *   const recaller = new Recaller('app')
 *   const registry = new RepoRegistry(undefined, { recaller, name: 'app' })
 *   mount(h`${() => {
 *     for (const [k, r] of registry) ...   // auto-subscribes
 *   }}`, document.body, recaller)
 *
 *   // archive-backed — to keep reactivity, pass registry.recaller in:
 *   const registry = new RepoRegistry(async key => {
 *     const repo = new Repo(registry.recaller)
 *     await archiveSync(repo, dataDir, key)
 *     return repo
 *   }, { recaller })
 *
 *   // standalone (no app recaller passed — registry creates one):
 *   new RepoRegistry()
 */
export class RepoRegistry {
  /** The Recaller this registry's reactive events fire on. */
  recaller
  #streams = new Map()
  #factory
  #name
  #openCallbacks = new Set()

  /**
   * @param {(publicKeyHex: string) => Repo | Promise<Repo>} [factory]
   *   If omitted, the default factory creates plain in-memory Repos
   *   that share our Recaller — so reading repo state inside a slot
   *   automatically subscribes the slot to chunk arrivals, no bridge
   *   needed. Custom factories that want the same effect should pass
   *   `registry.recaller` into their `new Repo(...)` (or new Streamo)
   *   call; otherwise the registry bridges their per-repo recaller
   *   onto its own.
   * @param {{ name?: string, recaller?: Recaller }} [options]
   *   `name` is used in watch names for debugging; `recaller` is the
   *   shared Recaller (defaults to a fresh one).
   */
  constructor (factory, options = {}) {
    const { name = 'registry', recaller = new Recaller(name) } = options
    this.#name = name
    this.recaller = recaller
    this.#factory = factory ?? (() => new Repo({ recaller: this.recaller }))
  }

  /**
   * Return the Repo for `publicKeyHex`, creating it via the factory if
   * this is the first call for that key.
   *
   * The repository is registered immediately (before the factory resolves)
   * so concurrent open() calls always return the same instance. Once the
   * factory resolves, the repo's recaller is bridged into ours.
   *
   * **For clients that want bytes to flow over the wire, prefer
   * `session.subscribe(publicKeyHex)`** (from a `registrySync(...)` return
   * value) or the `follow` cascade. `open` alone makes a *local* Repo only —
   * it doesn't send a subscribe message to the relay, so the bytes for this
   * key won't be pushed. See CLAUDE.md's footguns section for the full
   * rationale.
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
    // The Repo's own pubkey-hex is the key the registry stored it under.
    // Exposing it lets clients ask the Repo "what address are you?" without
    // a reverse-lookup or a side-channel stash on the instance.
    stream.publicKeyHex = publicKeyHex
    this.#streams.set(publicKeyHex, stream)
    resolve(stream)
    // Fire (this, 'keys') so iteration-based slots — those that called
    // `[...registry]` or `registry.get(keyHex)` — re-run now that a
    // new repo is available.
    this.recaller.reportKeyMutation(this, 'keys')
    // Bridge: for repos whose factory didn't pass our Recaller through,
    // forward their chunk-arrival events onto ours so iteration-based
    // slots re-run. Shared-recaller repos fire on (repo, 'length')
    // directly via Streamo's own reportKeyMutation — no forwarding
    // needed.
    if (stream.recaller !== this.recaller) {
      stream.recaller.watch(`${this.#name}:${publicKeyHex}`, () => {
        stream.byteLength
        this.recaller.reportKeyMutation(this, 'keys')
      })
    }
    for (const cb of this.#openCallbacks) cb(publicKeyHex, stream)
    return stream
  }

  /** Register a callback invoked whenever a new repo is fully opened. */
  onOpen (cb) { this.#openCallbacks.add(cb) }

  /** Remove a previously registered onOpen callback. */
  offOpen (cb) { this.#openCallbacks.delete(cb) }

  /**
   * Return an already-open Repo, or undefined if not opened yet.
   * Reports access on `(registry, 'keys')` so the calling reactive
   * cell re-runs when the set of open repos changes.
   * @param {string} publicKeyHex
   * @returns {Repo|undefined}
   */
  get (publicKeyHex) {
    this.recaller.reportKeyAccess(this, 'keys')
    const entry = this.#streams.get(publicKeyHex)
    return entry instanceof Streamo ? entry : undefined
  }

  /** Number of currently open (or opening) repos. Reports access. */
  get size () {
    this.recaller.reportKeyAccess(this, 'keys')
    return this.#streams.size
  }

  /**
   * Iterate over [publicKeyHex, Repo] pairs (only fully-opened).
   * Reports access — slots iterating the registry auto-subscribe to
   * new-repo opens.
   */
  [Symbol.iterator] () {
    this.recaller.reportKeyAccess(this, 'keys')
    return (function * (map) {
      for (const [k, v] of map) {
        if (v instanceof Streamo) yield [k, v]
      }
    })(this.#streams)
  }
}
