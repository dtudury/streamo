import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { StreamoRecordRegistry } from './StreamoRecordRegistry.js'
import { Recaller } from './utils/Recaller.js'
import { Signer } from './Signer.js'
import { archiveSync } from './archiveSync.js'
import { fileSync } from './fileSync.js'
import { originSync } from './originSync.js'
import { outletSync } from './outletSync.js'
import { registrySync } from './registrySync.js'
import { s3Sync } from './s3Sync.js'
import { stateFileSync } from './stateFileSync.js'
import { bytesToHex } from './utils.js'
import { webSync } from './webSync.js'

/**
 * Parse an origin spec into { host, port, protocol } for `originSync`.
 *
 * Accepts:
 *   - `ws://host[:port]` / `wss://host[:port]` — explicit URL shape
 *   - `host:port` shorthand — `:443` → wss, any other port → ws
 *   - `host` shorthand (no port) — wss (production default; same
 *      heuristic `StreamoRecord.merge`'s URL parser uses)
 *
 * Defaults the missing port from the protocol (wss → 443, ws → 80).
 * Exported so `bin/streamo.js`, alternative entry points, and tests
 * can share one canonical parser.
 *
 * @param {string} hostPort
 * @returns {{ host: string, port: number, protocol: 'ws'|'wss' }}
 */
export function parseOrigin (hostPort) {
  let urlString = hostPort
  if (!/^wss?:\/\//.test(hostPort)) {
    const port = hostPort.split(':')[1]
    const useWss = !port || port === '443'
    urlString = (useWss ? 'wss://' : 'ws://') + hostPort
  }
  const url = new URL(urlString)
  const protocol = url.protocol === 'wss:' ? 'wss' : 'ws'
  const port = +(url.port || (protocol === 'wss' ? 443 : 80))
  return { host: url.hostname, port, protocol }
}

export class StreamoServer {
  #dataDir
  #keyIterations
  // Per-repo archive closers, keyed by pubkey. Populated by the
  // registry factory below as each repo is opened. `close()` calls
  // the primary's entry; if richer "close all" semantics are ever
  // needed we have the whole map sitting here ready.
  #archiveClosers

  name
  username
  publicKeyHex
  signer
  streamo
  registry

  constructor (fields) {
    Object.assign(this, fields)
  }

  static async create ({ name, username, password, publicKeyHex, dataDir = '.streamo', keyIterations = 100000 }) {
    let signer = null
    let resolvedPublicKeyHex

    if (publicKeyHex) {
      // Relay-only mode: open a repo by its pubkey, no credential derivation,
      // no signer attached. Bytes arrive via sync (origin or outlet); commits
      // happen elsewhere (an author process with the matching credentials).
      // files() / merge() throw in this mode because both write signed commits.
      if (username || password) {
        throw new Error('StreamoServer.create: cannot combine publicKeyHex with {username, password}')
      }
      if (!/^[0-9a-f]{66}$/.test(publicKeyHex)) {
        throw new Error(`StreamoServer.create: invalid publicKeyHex (expected 66 hex chars), got: ${publicKeyHex}`)
      }
      resolvedPublicKeyHex = publicKeyHex
    } else {
      if (!name || !username || password == null) {
        throw new Error('StreamoServer.create: requires either publicKeyHex (relay-only) or {name, username, password} (author)')
      }
      signer = new Signer(username, password, keyIterations)
      const { publicKey } = await signer.keysFor(name)
      resolvedPublicKeyHex = bytesToHex(publicKey)
    }

    const archiveClosers = new Map()
    const recaller = new Recaller(`server:${name ?? resolvedPublicKeyHex.slice(0, 8)}`)
    // Writable for the primary IFF this server is in author mode (has a
    // signer to attach). Subscribed peer keys, and the primary in relay-
    // only mode (publicKeyHex without credentials), get the slim
    // StreamoRecord — read-only-by-type. Calling set() on a slim Record
    // raises a clear TypeError instead of silently no-op'ing on the
    // unsigned-but-appended bytes the relay would then reject.
    const registry = new StreamoRecordRegistry({
      recaller,
      factory: async key => {
        const isAuthorPrimary = key === resolvedPublicKeyHex && signer !== null
        const RecordClass = isAuthorPrimary ? WritableStreamoRecord : StreamoRecord
        const repo = new RecordClass({ recaller })
        const { close } = await archiveSync(repo, dataDir, key)
        archiveClosers.set(key, close)
        return repo
      }
    })
    const streamo = await registry._materialize(resolvedPublicKeyHex)
    // The factory above produced a WritableStreamoRecord IFF signer is
    // non-null. The cast surfaces the dependent type to the checker.
    if (signer) /** @type {WritableStreamoRecord} */ (streamo).attachSigner(signer, name)

    const server = new StreamoServer({ name, username, publicKeyHex: resolvedPublicKeyHex, signer, streamo, registry })
    server.#dataDir = dataDir
    server.#keyIterations = keyIterations
    server.#archiveClosers = archiveClosers
    return server
  }

  /**
   * Close the primary streamo and wait for its archive writer to drain.
   * Signals end-of-stream to the writer, lets it finish what's in the
   * pipe, closes the file handle. Use before `process.exit()` so the
   * tail (typically SIG chunks appended by auto-sign) lands cleanly
   * instead of being dropped by the exit.
   *
   * After this resolves the streamo is closed — no further appends.
   * Long-lived servers (the relay) never call this; the writer runs
   * for the lifetime of the process.
   *
   * Only closes the primary repo — registry peers opened in this
   * process aren't written to from here.
   */
  async close () {
    const close = this.#archiveClosers.get(this.publicKeyHex)
    if (close) await close()
  }

  async web (port, peerOptions = {}) {
    return webSync(this.registry, this.publicKeyHex, port, this.name, this.#keyIterations, peerOptions)
  }

  outlet (port) {
    return outletSync(this.registry, port)
  }

  async connect (hostPort) {
    const { host, port, protocol } = parseOrigin(hostPort)
    return originSync(this.streamo, this.publicKeyHex, host, port, { protocol })
  }

  /**
   * Subscribe to another relay's home Record (and its mounted records, via
   * the `followMounts` cascade) and watch for changes. The returned session
   * holds the connection open; bytes flow continuously while open.
   *
   * Streamo's per-record authority model makes this fundamentally an
   * *asymmetric subscription* — each Record has one origin (the relay
   * that arbitrates its chain); calling watch() makes THIS relay a
   * subscriber to records the host relay originates. The earlier name
   * `peer()` implied a symmetric federation relationship the design
   * actually prohibits; renamed 2026-05-28 to `watch()` to honestly
   * describe what's happening. `peer()` is preserved as a deprecated
   * alias.
   *
   * Mechanism: `registrySync` opens a WebSocket to the host, receives
   * its `hello { home }`, auto-subscribes to that home, and the
   * `followMounts: true` cascade subscribes to every Record referenced
   * in the home's `mounts` table. Combined with `webSync`'s `hostMap`,
   * this lets one relay serve content authored on another.
   *
   * @param {string} hostPort  ws/wss URL or host[:port] shorthand
   *   (same shape as `connect()`)
   * @param {object} [options]  forwarded to `registrySync` — e.g.
   *   `{ follow, followMounts, onAnnounce, onConnectionChange }`.
   *   Defaults to `followMounts: true` which is the federation-pattern
   *   default (subscribe to everything the host's home mounts).
   * @returns {Promise<ReturnType<typeof registrySync>>}
   */
  async watch (hostPort, options = {}) {
    const { host, port, protocol } = parseOrigin(hostPort)
    return registrySync(this.registry, host, port, {
      protocol,
      followMounts: true,
      ...options
    })
  }

  /** @deprecated 2026-05-28 — renamed to {@link watch}. Streamo's
   *  per-record authority model is fundamentally asymmetric (one origin
   *  per record); "peer" implied a symmetric relationship the substrate
   *  prohibits. Use `watch(hostPort, options)` instead. This alias is
   *  preserved for existing callers; remove after a migration grace
   *  period. */
  async peer (hostPort, options = {}) {
    return this.watch(hostPort, options)
  }

  async files (folder = '.', options = {}) {
    if (!this.signer) {
      throw new Error('files() requires a signer — open this server with {name, username, password} instead of publicKeyHex')
    }
    return fileSync(this.streamo, folder, this.#dataDir, options)
  }

  async s3 ({ bucket, endpoint, region, accessKeyId, secretAccessKey }) {
    return s3Sync(this.streamo, this.publicKeyHex, { bucket, endpoint, region, accessKeyId, secretAccessKey })
  }

  stateFile (path) {
    return stateFileSync(this.streamo, path)
  }
}
