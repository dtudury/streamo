import { StreamoRecord } from './StreamoRecord.js'
import { Recaller } from './utils/Recaller.js'

/**
 * Manages a collection of StreamoRecords keyed by hex-encoded public key. Every
 * registry has a shared Recaller — its reactive coordination point —
 * which **must be provided by the caller**. The default factory creates
 * StreamoRecords that share this Recaller, so reading any repo's state inside a
 * reactive cell auto-subscribes the cell to chunk arrivals.
 *
 * Iteration, `get(keyHex)`, and `size` all report access on
 * `(registry, 'keys')`, so slots iterating the registry auto-subscribe
 * to new-repo opens. `_materialize()` fires the same key when a repo lands.
 *
 * Custom factories that don't pass the registry's Recaller through
 * (e.g. `async key => { const r = new StreamoRecord(); await archiveSync(r); }`)
 * still get a fallback bridge — StreamoRecordRegistry watches their per-repo
 * Recaller and forwards chunk arrivals onto our 'keys' key. Coarser
 * than the shared-Recaller path (every iteration-touching slot wakes
 * on every chunk arrival from any non-shared repo), but it works.
 *
 * **`recaller` is required, not optional.** Pre-10.0.0 the constructor
 * silently created a fresh per-registry Recaller if you omitted it —
 * the silent-stale-slot footgun. Views read repos on recallers
 * different from the one mount was watching, and slots went silently
 * stale (no error, no log, just "huh, why isn't this updating"). Now
 * the constructor throws on missing recaller; callers explicitly state
 * which Recaller their registry shares.
 *
 * Examples:
 *
 *   // plain in-memory, sharing the app's Recaller:
 *   const recaller = new Recaller('app')
 *   const registry = new StreamoRecordRegistry({ recaller, name: 'app' })
 *   mount(h`${() => {
 *     for (const [k, r] of registry) ...   // auto-subscribes
 *   }}`, document.body, recaller)
 *
 *   // archive-backed:
 *   const registry = new StreamoRecordRegistry({
 *     recaller,
 *     factory: async key => {
 *       const repo = new StreamoRecord({ recaller })
 *       await archiveSync(repo, dataDir, key)
 *       return repo
 *     }
 *   })
 */
export class StreamoRecordRegistry {
  /** The Recaller this registry's reactive events fire on. */
  recaller
  #streams = new Map()
  #factory
  #name
  #openCallbacks = new Set()

  /**
   * @param {{
   *   recaller?: Recaller,
   *   factory?: (publicKeyHex: string) => StreamoRecord | Promise<StreamoRecord>,
   *   name?: string
   * }} [options]  `recaller` is required at runtime (pre-10.0.0 a fresh
   *   one was silently created when omitted — the silent-stale-slot
   *   footgun; the constructor now throws if missing). Marked optional
   *   in the type only so the default `= {}` literal type-checks; the
   *   runtime check below catches missing recaller with a clear error.
   *   `factory` defaults to one that creates plain in-memory
   *   StreamoRecords sharing `recaller`. Custom factories should pass
   *   `registry.recaller` into their `new StreamoRecord(...)` call;
   *   otherwise the registry bridges their per-repo recaller onto its
   *   own. `name` defaults to `'registry'` (used in watch names for
   *   debugging).
   */
  constructor (options = {}) {
    if (!options || !options.recaller) {
      throw new TypeError(
        'StreamoRecordRegistry: `recaller` is required. Pass your app\'s Recaller via ' +
        '`new StreamoRecordRegistry({ recaller, factory?, name? })`. Pre-10.0.0 a fresh ' +
        'Recaller was silently created when omitted — the silent-stale-slot ' +
        'footgun. See CLAUDE.md for the rationale.'
      )
    }
    const { recaller, factory, name = 'registry' } = options
    this.#name = name
    this.recaller = recaller
    this.#factory = factory ?? (() => new StreamoRecord({ recaller: this.recaller }))
  }

  /**
   * Return the StreamoRecord for `publicKeyHex`, creating it via the factory if
   * this is the first call for that key.
   *
   * The repository is registered immediately (before the factory resolves)
   * so concurrent calls always return the same instance. Once the
   * factory resolves, the repo's recaller is bridged into ours.
   *
   * Underscore-prefixed because **this is the substrate's local-materialize
   * verb, not what most callers want.** Client code that wants bytes to
   * flow over the wire wants `session.subscribe(publicKeyHex)` (from a
   * `registrySync(...)` return value) or the `follow` cascade. `_materialize`
   * alone makes a *local* StreamoRecord only — it doesn't send a subscribe message
   * to the relay, so the bytes for this key won't be pushed.
   *
   * Legitimate callers of `_materialize`:
   *   - the relay's own startup seed (`StreamoServer.create`)
   *   - mount resolution (repoFileServer, fileSync's collectMountedFiles)
   *   - registrySync's chunk-arrival path (a new key arriving over the
   *     wire needs a local StreamoRecord to write into)
   *   - tests that exercise the registry directly
   *
   * If your call site doesn't match one of those, you almost certainly
   * want `session.subscribe` instead.
   *
   * @param {string} publicKeyHex
   * @returns {Promise<StreamoRecord>}
   */
  async _materialize (publicKeyHex) {
    if (this.#streams.has(publicKeyHex)) return this.#streams.get(publicKeyHex)
    /** @type {(stream: StreamoRecord) => void} */
    let resolve = () => {}
    const placeholder = new Promise(r => { resolve = r })
    this.#streams.set(publicKeyHex, placeholder)
    const stream = await this.#factory(publicKeyHex)
    // The StreamoRecord's own pubkey-hex is the key the registry stored it under.
    // Exposing it lets clients ask the StreamoRecord "what address are you?" without
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
   * Return an already-open StreamoRecord, or undefined if not opened yet.
   * Reports access on `(registry, 'keys')` so the calling reactive
   * cell re-runs when the set of open repos changes.
   * @param {string} publicKeyHex
   * @returns {StreamoRecord|undefined}
   */
  get (publicKeyHex) {
    this.recaller.reportKeyAccess(this, 'keys')
    const entry = this.#streams.get(publicKeyHex)
    // Filters out the pending-Promise placeholder; what remains is the
    // resolved StreamoRecord (or undefined for not-yet-opened keys).
    return entry instanceof StreamoRecord ? entry : undefined
  }

  /** Number of currently open (or opening) repos. Reports access. */
  get size () {
    this.recaller.reportKeyAccess(this, 'keys')
    return this.#streams.size
  }

  /**
   * Iterate over [publicKeyHex, StreamoRecord] pairs (only fully-opened).
   * Reports access — slots iterating the registry auto-subscribe to
   * new-repo opens.
   */
  [Symbol.iterator] () {
    this.recaller.reportKeyAccess(this, 'keys')
    return (function * (map) {
      for (const [k, v] of map) {
        if (v instanceof StreamoRecord) yield [k, v]
      }
    })(this.#streams)
  }
}
