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
  #signal = {}
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
   * Register the calling reactive cell on the bridge signal. Re-runs
   * when any repo's chunks arrive or when a new repo opens. Arrow-
   * bound so `const { dep } = registry` works.
   */
  dep = () => this.recaller.reportKeyAccess(this.#signal, 'data')

  /**
   * Fire the bridge — forces slots that called `dep()` to re-run at
   * next tick. Called automatically on chunk arrivals and new repo
   * opens; also useful for app-state changes that aren't repo
   * mutations but want the same re-render channel (a verify cache
   * resolving, a tree expanding, etc.).
   */
  fire = () => this.recaller.reportKeyMutation(this.#signal, 'data')

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
    // Bridge: re-fire on every chunk arrival. Touching stream.byteLength
    // registers the watcher on the repo's 'length' key. watch() runs
    // its body immediately to register deps — and that immediate run
    // calls this.fire(), so there's no need to fire again here.
    //
    // Skipped when stream.recaller === this.recaller — the default
    // factory makes Repos share our recaller, so chunk arrivals already
    // fire on it directly and the bridge watcher would only forward
    // events to themselves.
    if (stream.recaller !== this.recaller) {
      stream.recaller.watch(`${this.#name}:${publicKeyHex}`, () => {
        stream.byteLength
        this.fire()
      })
    } else {
      // Shared recaller — chunk arrivals fire directly. We still want
      // to fire once now so iteration-based slots re-run on new-repo
      // opens (Symbol.iterator doesn't auto-report yet).
      this.fire()
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
