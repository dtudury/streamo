import { Repo } from './Repo.js'
import { RepoRegistry } from './RepoRegistry.js'
import { Signer } from './Signer.js'
import { archiveSync } from './archiveSync.js'
import { fileSync } from './fileSync.js'
import { originSync } from './originSync.js'
import { outletSync } from './outletSync.js'
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
 *      heuristic `Repo.merge`'s URL parser uses)
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

    const registry = new RepoRegistry(async key => {
      const repo = new Repo()
      await archiveSync(repo, dataDir, key)
      return repo
    })
    const streamo = await registry.open(resolvedPublicKeyHex)
    if (signer) streamo.attachSigner(signer, name)

    const server = new StreamoServer({ name, username, publicKeyHex: resolvedPublicKeyHex, signer, streamo, registry })
    server.#dataDir = dataDir
    server.#keyIterations = keyIterations
    return server
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
