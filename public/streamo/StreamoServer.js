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

  static async create ({ name, username, password, dataDir = '.streamo', keyIterations = 100000 }) {
    const signer = new Signer(username, password, keyIterations)
    const { publicKey } = await signer.keysFor(name)
    const publicKeyHex = bytesToHex(publicKey)

    const registry = new RepoRegistry(async key => {
      const repo = new Repo()
      await archiveSync(repo, dataDir, key)
      return repo
    })
    const streamo = await registry.open(publicKeyHex)
    streamo.attachSigner(signer, name)

    const server = new StreamoServer({ name, username, publicKeyHex, signer, streamo, registry })
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
    const [host, port] = hostPort.split(':')
    return originSync(this.streamo, this.publicKeyHex, host, +port)
  }

  async files (folder = '.', options = {}) {
    return fileSync(this.streamo, folder, this.#dataDir, options)
  }

  async s3 ({ bucket, endpoint, region, accessKeyId, secretAccessKey }) {
    return s3Sync(this.streamo, this.publicKeyHex, { bucket, endpoint, region, accessKeyId, secretAccessKey })
  }

  stateFile (path) {
    return stateFileSync(this.streamo, path)
  }
}
