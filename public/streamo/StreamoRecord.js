import { Streamo } from './Streamo.js'
import { verifySignature } from './Signer.js'

export class StreamoRecord extends Streamo {

  publicKeyHex

  #session = null

  #hasRelay = false

  commitBatchesFrom (offset = 0) {
    const batches = []
    let chunks = []
    for (const { uint8Array, offset: at } of this._chunks) {
      if (at < offset) continue
      if (this.footerToCodec[uint8Array.at(-1)]?.type === 'SIGNATURE') {
        batches.push({ chunks, sig: uint8Array })
        chunks = []
      } else {
        chunks.push(uint8Array)
      }
    }
    return batches
  }

  #lastSigAddress () {
    let addr = this.byteLength - 1
    while (addr >= 0) {
      const code = this.resolve(addr)
      if (this.footerToCodec[code.at(-1)]?.type === 'SIGNATURE') return addr - code.length + 1
      addr -= code.length
    }
    return -1
  }

  get valueAddress () {
    let address = super.valueAddress
    while (address >= 0) {
      const code = this.resolve(address)
      if (this.footerToCodec[code.at(-1)]?.type !== 'SIGNATURE') break
      address -= code.length
    }
    return address
  }

  get signedLength () {
    const sigStart = this.#lastSigAddress()
    return sigStart < 0 ? 0 : sigStart + 97
  }

  get committedChainHash () {
    const sigStart = this.#lastSigAddress()
    if (sigStart < 0) return new Uint8Array(32)
    return this.slice(sigStart, sigStart + 32)
  }

  get lastCommit () {
    this.recaller.reportKeyAccess(this._chunks, 'length')
    const address = this.valueAddress
    if (address < 0) return null
    let value
    try {
      value = this.decode(address)
    } catch {
      return null
    }
    if (!value || typeof value.message !== 'string' || !(value.date instanceof Date)) return null
    return value
  }

  get (...args) {
    if (typeof args[0] === 'number') return super.get(...args)
    const commit = this.lastCommit
    if (!commit) return super.get(...args)
    this.recaller.reportKeyAccess(this._chunks, JSON.stringify(args))
    return this.decodeAt(commit.dataAddress, ...args)
  }

  getRefs (...path) {
    const commit = this.lastCommit
    if (!commit) return super.getRefs(...path)
    let address = commit.dataAddress
    for (const key of path) {
      const refs = this.asRefs(address)
      if (typeof refs === 'number') return undefined
      address = Array.isArray(refs) ? refs[+key] : refs[key]
      if (address === undefined) return undefined
    }
    return this.asRefs(address)
  }

  get files () {
    const commit = this.lastCommit
    if (!commit) return undefined
    return this.decode(commit.dataAddress)
  }

  * history () {
    let commit = this.lastCommit
    while (commit) {
      yield commit
      commit = commit.parent !== undefined ? this.decode(commit.parent) : null
    }
  }

  get parent () {
    const head = this.lastCommit
    if (!head || head.parent === undefined) return null
    return this.decode(head.parent)
  }

  ancestor (n) {
    if (n < 0) return null
    let i = 0
    for (const commit of this.history()) {
      if (i === n) return commit
      i++
    }
    return null
  }

  async verify (sig, publicKey) {
    return verifySignature(publicKey, sig.chainHash, sig.compactRawBytes)
  }

  _attachSession (session) {
    this.#session = session
    if (!this.#hasRelay) {
      this.#hasRelay = true
      this.recaller.reportKeyMutation(this, 'hasRelay')
    }
  }

  get _session () { return this.#session }

  get hasRelay () {
    this.recaller.reportKeyAccess(this, 'hasRelay')
    return this.#hasRelay
  }

  get isAuthorable () { return false }

  _reset () {
    super._reset()
  }

}
