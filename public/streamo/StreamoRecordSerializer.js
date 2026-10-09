import { Signature } from './Signature.js'
import { verifySignature } from './Signer.js'

import { arraysEqual, chainHashOf } from './utils.js'

export class StreamoRecordSerializer {
  constructor (repo, publicKey) {
    this.repo = repo
    this.publicKey = publicKey
    /** @type {Promise<any>} */
    this._lock = Promise.resolve()
  }

  submit (batch) {
    const next = this._lock.then(() => this._tryApply(batch))
    this._lock = next.catch(() => {})
    return next
  }

  async _tryApply (batch) {
    const { chunks, sig } = batch
    const codec = this.repo.footerToCodec[sig.at(-1)]
    if (codec?.type !== 'SIGNATURE') {
      return { accepted: false, reason: 'malformed' }
    }
    let sigDecoded
    try {
      sigDecoded = this.repo.decode(sig)
    } catch {
      return { accepted: false, reason: 'malformed' }
    }
    if (!(sigDecoded instanceof Signature)) {
      return { accepted: false, reason: 'malformed' }
    }

    const newBytesLen = chunks.reduce((sum, c) => sum + c.length, 0)
    const newBytes = new Uint8Array(newBytesLen)
    let pos = 0
    for (const c of chunks) { newBytes.set(c, pos); pos += c.length }

    const expected = await chainHashOf(this.repo.committedChainHash, newBytes)
    if (!arraysEqual(sigDecoded.chainHash, expected)) {
      return { accepted: false, reason: 'chain-mismatch' }
    }
    const valid = await verifySignature(this.publicKey, sigDecoded.chainHash, sigDecoded.compactRawBytes)
    if (!valid) {
      return { accepted: false, reason: 'verification-failed' }
    }

    for (const c of chunks) {
      if (this.repo.addressOf(c) === undefined) this.repo.append(c)
    }
    if (this.repo.addressOf(sig) === undefined) this.repo.append(sig)
    return { accepted: true }
  }
}

export class ConnectionAccumulator {
  /** @param {any} serializer @param {(result: { accepted: boolean, reason?: string }) => void} [onBatchResult] */
  constructor (serializer, onBatchResult = () => {}) {
    this.serializer = serializer
    this.onBatchResult = onBatchResult
    this.repo = serializer.repo
    this.buf = new Uint8Array(0)
    this.bufOffset = 0
    this.chunks = []
    this.maxFrameSize = 64 * 1024 * 1024
  }

  async write (incoming) {
    const leftover = this.buf.length - this.bufOffset
    if (leftover === 0) this.buf = incoming
    else {
      const next = new Uint8Array(leftover + incoming.length)
      next.set(this.buf.subarray(this.bufOffset), 0)
      next.set(incoming, leftover)
      this.buf = next
    }
    this.bufOffset = 0
    while (this.buf.length - this.bufOffset >= 4) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.bufOffset, 4)
      const len = view.getUint32(0, true)
      if (len === 0) throw new Error('malformed frame: zero-length chunk')
      if (len > this.maxFrameSize) throw new Error(`malformed frame: length ${len} exceeds ${this.maxFrameSize}`)
      if (this.buf.length - this.bufOffset < 4 + len) break
      const code = this.buf.subarray(this.bufOffset + 4, this.bufOffset + 4 + len)
      this.bufOffset += 4 + len

      const codec = this.repo.footerToCodec[code.at(-1)]
      if (codec?.type === 'SIGNATURE') {
        if (this.repo.addressOf(code) !== undefined) {
          this.chunks = []
          continue
        }
        const batch = { chunks: this.chunks, sig: code }
        this.chunks = []
        const result = await this.serializer.submit(batch)
        this.onBatchResult(result)
      } else {
        this.chunks.push(code)
      }
    }
  }
}
