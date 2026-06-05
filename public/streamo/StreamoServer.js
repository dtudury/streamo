import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { StreamoRecordRegistry } from './StreamoRecordRegistry.js'
import { Recaller } from './utils/Recaller.js'
import { Signer } from './Signer.js'
import { DiskTier } from './StorageTier.js'
import { Cascade } from './Cascade.js'
import { tieredArchiveSync } from './tieredArchiveSync.js'
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
 *
 * Archive storage is configured via a `tiers: StorageTier[]` list since
 * 13.0.0 (replaces the 12.x dataDir/archiveMode/preserved trio). The
 * Cascade orchestrates write/read/evict across tiers; see Cascade.js
 * for the model. The legacy archiveSync's single-directory contract is
 * a single-tier Cascade with one DiskTier — no behavior change for the
 * common case; capacity/eviction/spill come for free when more tiers
 * are configured.
 *
 * Note: `parseOrigin` (hostPort → {host, port, protocol}) moved to
 * `./utils.js` in 11.0.0 so registrySync and originSync can share the
 * one canonical normalizer.
 */

export class StreamoServer {
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

  static async create ({ name, username, password, publicKeyHex, tiers, keyIterations = 100000 }) {
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

    // Default tiers: a single .streamo DiskTier — flat-equivalent to the
    // pre-13.0 default. Callers wanting tiered/ephemeral/preserved-style
    // routing construct their own tier list and pass it explicitly.
    const cascade = new Cascade({
      tiers: tiers ?? [new DiskTier({ dir: '.streamo', capacity: Infinity })]
    })
    // DiskTiers populate their size cache by walking the dir on first
    // use. We init them all up-front so the factory's tieredArchiveSync
    // call sees a fully-primed cascade.
    for (const tier of cascade.tiers) {
      if (typeof tier.init === 'function') await tier.init()
    }

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
        const { close } = await tieredArchiveSync(record, cascade, key)
        archiveClosers.set(key, close)
        return record
      }
    })
    const streamo = await registry._materialize(resolvedPublicKeyHex)
    // Type cast: factory above produced Writable iff signer !== null.
    if (signer) /** @type {WritableStreamoRecord} */ (streamo).attachSigner(signer, name)

    const server = new StreamoServer({ name, username, publicKeyHex: resolvedPublicKeyHex, signer, streamo, registry })
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
    return originSync(this.streamo, this.publicKeyHex, hostPort)
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
    return registrySync(this.registry, hostPort, { followMounts: true, ...options })
  }

  async files (folder = '.', options = {}) {
    if (!this.signer) {
      throw new Error('files() requires a signer — open this server with {name, username, password} instead of publicKeyHex')
    }
    // `dataDir` in options is the path-to-exclude hint for fileSync's
    // gitignore-style filter (so the on-disk archive directory doesn't
    // get sucked back into the Record's value.files). No longer a
    // server-held field in 13.0; explicit per call. Default undefined =
    // no exclusion beyond .gitignore.
    //
    // Defaults from this server: registry + pubkeyHex (for mount-walking),
    // signer + signerName (for the auto-sharding path in fileSync —
    // when both are present, writes route through FolderRecord.writeMany
    // and files under ours:true mounts go to derived child Records via
    // signer.keysFor(signerName + '/' + mountPrefix)). Callers can
    // override by passing them explicitly.
    const opts = {
      registry:   options.registry   ?? this.registry,
      pubkeyHex:  options.pubkeyHex  ?? this.publicKeyHex,
      signer:     options.signer     ?? this.signer,
      signerName: options.signerName ?? this.name,
      ...options
    }
    return fileSync(this.streamo, folder, options.dataDir, opts)
  }

  async s3 ({ bucket, endpoint, region, accessKeyId, secretAccessKey }) {
    return s3Sync(this.streamo, this.publicKeyHex, { bucket, endpoint, region, accessKeyId, secretAccessKey })
  }

  stateFile (path) {
    return stateFileSync(this.streamo, path)
  }
}
