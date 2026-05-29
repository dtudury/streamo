import { join } from 'path'
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
 * @file StreamoServer — composes a Record with sync/serve primitives
 * (archive, file, web, outlet, feed, etc.). One canonical entry point
 * shared by bin/streamo.js, tests, and embedding contexts.
 */

/**
 * Parse a host specifier into { host, port, protocol }. Accepts
 *   `ws://host[:port]`, `wss://host[:port]`, or bare `host[:port]`.
 * For bare specs: port 443 (or no port) → wss; any other port → ws.
 * Same heuristic as StreamoRecord.merge's URL parser; exported so
 * everywhere shares one canonical normalization.
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

  static async create ({ name, username, password, publicKeyHex, dataDir = '.streamo', keyIterations = 100000, preserved = [] }) {
    let signer = null
    let resolvedPublicKeyHex

    if (publicKeyHex) {
      // Relay-only mode: open by pubkey, no signer. Bytes arrive via sync;
      // any author process runs elsewhere. files() / merge() throw here
      // because both write signed commits.
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

    // Ephemeral mode: in-memory cache works identically; nothing hits disk.
    // Restart loses everything (no archive to rehydrate from).
    const isEphemeral = !dataDir

    // Preserved keys go to `<dataDir>/preserved/<key>.bin` instead of
    // `<dataDir>/<key>.bin`. Once eviction lands, the preserved/ dir is
    // excluded — Claude's records and similarly-marked artifacts survive
    // cleanup. Friction-as-feature: each preserved key is named explicitly
    // here; no transitive walk, no auto-inclusion (see
    // feedback_records_designed_for_human_scale memory).
    const preservedSet = new Set(preserved)

    // Writable for the primary only when we have a signer. Subscribed peer
    // keys and the relay-only primary stay slim — set() on a slim Record
    // raises TypeError instead of silently no-op'ing on bytes the relay
    // would reject downstream anyway.
    const registry = new StreamoRecordRegistry({
      recaller,
      factory: async key => {
        const isAuthorPrimary = key === resolvedPublicKeyHex && signer !== null
        const RecordClass = isAuthorPrimary ? WritableStreamoRecord : StreamoRecord
        const record = new RecordClass({ recaller })
        if (!isEphemeral) {
          const archiveDir = preservedSet.has(key) ? join(dataDir, 'preserved') : dataDir
          const { close } = await archiveSync(record, archiveDir, key)
          archiveClosers.set(key, close)
        }
        return record
      }
    })
    const streamo = await registry._materialize(resolvedPublicKeyHex)
    // Type cast: factory above produced Writable iff signer !== null.
    if (signer) /** @type {WritableStreamoRecord} */ (streamo).attachSigner(signer, name)

    const server = new StreamoServer({ name, username, publicKeyHex: resolvedPublicKeyHex, signer, streamo, registry })
    server.#dataDir = dataDir
    server.#keyIterations = keyIterations
    server.#archiveClosers = archiveClosers
    return server
  }

  /**
   * Drain the primary's archive writer before exiting. Lets the tail
   * (usually auto-sign SIGs) land instead of being dropped by the exit.
   * Long-lived servers never call this; the writer runs for the process
   * lifetime. Only the primary's archive is closed.
   */
  async close () {
    const close = this.#archiveClosers.get(this.publicKeyHex)
    if (close) await close()
  }

  async web (port, peerOptions = {}) {
    return webSync(this.registry, this.publicKeyHex, port, this.name, this.#keyIterations, peerOptions)
  }

  outlet (port) {
    // Pass our home pubkey so the registry-handshake `hello` carries
    // something for `--feed` clients to auto-subscribe to — without it,
    // the registry session opens but the cascade has nothing to walk.
    return outletSync(this.registry, port, { home: this.publicKeyHex })
  }

  async connect (hostPort) {
    const { host, port, protocol } = parseOrigin(hostPort)
    return originSync(this.streamo, this.publicKeyHex, host, port, { protocol })
  }

  /**
   * Attach a *feed* — outbound WebSocket dial to a remote outlet. Bytes
   * for the remote's home Record (and its mounted records via the
   * followMounts cascade) flow down; any local commits flow up the same
   * connection. The pair: an outlet listens, a feed dials in.
   *
   * `options` forwarded to registrySync; defaults to `followMounts: true`
   * (the federation pattern — pull everything the host's home mounts).
   * Renaming history: peer() → watch() → feed(). Both prior names retired
   * 2026-05-29.
   */
  async feed (hostPort, options = {}) {
    const { host, port, protocol } = parseOrigin(hostPort)
    return registrySync(this.registry, host, port, {
      protocol,
      followMounts: true,
      ...options
    })
  }

  /** @deprecated 2026-05-29 — renamed to {@link feed}. */
  async watch (hostPort, options = {}) {
    return this.feed(hostPort, options)
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
