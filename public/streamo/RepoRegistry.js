import { Streamo } from './Streamo.js'
import { Repo } from './Repo.js'
import { Recaller } from './utils/Recaller.js'

/**
 * Manages a collection of Repos keyed by hex-encoded public key, with
 * built-in reactive bridging into a shared Recaller.
 *
 * Each Repo has its own internal Recaller (for fine-grained dep tracking
 * on its own keys). If an app's mount() slots use a *different* Recaller,
 * reading `repo.byteLength` inside a slot registers a dep on the repo's
 * recaller — not the app's — and the slot never re-runs when chunks
 * arrive. RepoRegistry bridges that gap automatically: pass your app's
 * Recaller via `{ recaller }`, and every repo opened (now or later)
 * forwards its byteLength changes onto a single signal on that shared
 * Recaller. Inside a slot, call `registry.dep()` to subscribe.
 *
 * Accepts an optional factory function that is called whenever a new
 * repository is opened. The factory receives the publicKeyHex and
 * returns a (possibly async) Repo with whatever persistence or sync
 * wired up. If no factory is provided, plain in-memory Repos are
 * created.
 *
 * Examples:
 *
 *   // plain in-memory, own Recaller (used by a mount call):
 *   const recaller = new Recaller('app')
 *   const registry = new RepoRegistry(undefined, { recaller, name: 'app' })
 *   mount(h`${() => { registry.dep(); return …  }}`, document.body, recaller)
 *
 *   // archive-backed:
 *   new RepoRegistry(async key => {
 *     const repo = new Repo()
 *     await archiveSync(repo, dataDir, key)
 *     return repo
 *   }, { recaller })
 *
 *   // standalone (no app recaller passed — registry creates one):
 *   new RepoRegistry()
 */
export class RepoRegistry {
  /** Shared Recaller — register reactive cells with `registry.dep()`. */
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
    this.#factory = factory ?? (() => new Repo(this.recaller))
  }

  /**
   * Register the calling reactive cell on `(registry, 'keys')` — the
   * channel that fires on new-repo opens. Arrow-bound so destructuring
   * works. Kept temporarily for subsystems (verify cache, tree state)
   * that haven't moved to LiveSource yet; will retire once they do.
   */
  dep  = () => this.recaller.reportKeyAccess(this, 'keys')

  /** Force a re-render of slots that called `dep()`. Same retirement. */
  fire = () => this.recaller.reportKeyMutation(this, 'keys')

  /**
   * Return the Repo for `publicKeyHex`, creating it via the factory if
   * this is the first call for that key.
   *
   * The repository is registered immediately (before the factory resolves)
   * so concurrent open() calls always return the same instance. Once the
   * factory resolves, the repo's recaller is bridged into ours.
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
