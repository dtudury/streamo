import { ContentMap } from './ContentMap.js'

export class Addressifier {
  _chunks = []
  #contentMap = new ContentMap()

  #resolveNext
  #nextChunk = new Promise(resolve => { this.#resolveNext = resolve })
  #closed = false

  get byteLength () {
    if (!this._chunks.length) return 0
    const last = this._chunks[this._chunks.length - 1]
    return last.offset + last.uint8Array.length
  }

  get wireByteLength () {
    return this.byteLength + 4 * this._chunks.length
  }

  resolve (address) {
    return this.#chunkAt(address).uint8Array
  }

  _index (code, address) {
    this.#contentMap.set(code, address)
  }

  addressOf (code) {
    return this.#contentMap.get(code)
  }

  append (code) {
    if (this.#closed) throw new Error('cannot append to a closed Addressifier')
    if (!code.length) throw new Error('chunk must not be empty')
    this._chunks.push({ uint8Array: code, offset: this.byteLength })
    const address = this.byteLength - 1
    const prev = this.#resolveNext
    this.#nextChunk = new Promise(resolve => { this.#resolveNext = resolve })
    prev(code)
    return address
  }

  close () {
    if (this.#closed) return
    this.#closed = true
    const prev = this.#resolveNext
    this.#nextChunk = new Promise(resolve => { this.#resolveNext = resolve })
    prev()
  }

  get isClosed () {
    return this.#closed
  }

  clone (address) {
    return this._applyClone(new Addressifier(), address)
  }

  _applyView (target) {
    if (typeof (/** @type {any} */ (target)).attachSigner === 'function') {
      throw new TypeError('_applyView: a view is a reader — two writers on one store is what checkout refuses')
    }
    target._chunks = this._chunks
    target.#contentMap = new ContentMap()
    return target
  }

  _applyClone (target, address) {
    const idx = this.#indexAt(address, false)
    target._chunks = this._chunks.slice(0, idx + 1)
    target.#contentMap = this.#contentMap.clone(address)
    return target
  }

  slice (start = 0, end = this.byteLength) {
    const parts = []
    for (const { uint8Array, offset } of this._chunks) {
      const chunkEnd = offset + uint8Array.length
      if (chunkEnd <= start || offset >= end) continue
      parts.push(uint8Array.slice(Math.max(0, start - offset), Math.min(uint8Array.length, end - offset)))
    }
    if (parts.length === 1) return parts[0]
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let pos = 0
    for (const p of parts) { out.set(p, pos); pos += p.length }
    return out
  }

  byteAt (byteIndex) {
    const chunk = this.#chunkAt(byteIndex, false)
    if (!chunk) return undefined
    return chunk.uint8Array[byteIndex - chunk.offset]
  }

  makeReadableStream ({ fromOffset = 0, maxBatch = 256 * 1024 } = {}) {
    const self = this
    let index = 0
    while (index < self._chunks.length && self._chunks[index].offset < fromOffset) index++
    return new ReadableStream({
      async pull (controller) {
        while (index >= self._chunks.length) {
          if (self.#closed) { controller.close(); return }
          await self.#nextChunk
          if (self.#closed && index >= self._chunks.length) { controller.close(); return }
        }
        const start = index
        let total = 0
        while (index < self._chunks.length) {
          const len = self._chunks[index].uint8Array.length
          if (index > start && total + 4 + len > maxBatch) break
          total += 4 + len
          index++
        }
        const frame = new Uint8Array(total)
        const view = new DataView(frame.buffer)
        let pos = 0
        for (let i = start; i < index; i++) {
          const { uint8Array } = self._chunks[i]
          view.setUint32(pos, uint8Array.length, true)
          pos += 4
          frame.set(uint8Array, pos)
          pos += uint8Array.length
        }
        controller.enqueue(frame)
      }
    })
  }

  makeWritableStream (maxFrameSize = 64 * 1024 * 1024) {
    const self = this
    let buf = new Uint8Array(0)
    let bufOffset = 0
    return new WritableStream({
      write (incoming) {
        const leftover = buf.length - bufOffset
        if (leftover === 0) buf = incoming
        else {
          const next = new Uint8Array(leftover + incoming.length)
          next.set(buf.subarray(bufOffset), 0)
          next.set(incoming, leftover)
          buf = next
        }
        bufOffset = 0
        while (buf.length - bufOffset >= 4) {
          const view = new DataView(buf.buffer, buf.byteOffset + bufOffset, 4)
          const len = view.getUint32(0, true)
          if (len === 0) throw new Error('malformed frame: zero-length chunk')
          if (len > maxFrameSize) throw new Error(`malformed frame: length ${len} exceeds ${maxFrameSize}`)
          if (buf.length - bufOffset < 4 + len) break
          const code = new Uint8Array(buf.subarray(bufOffset + 4, bufOffset + 4 + len))
          self.append(code)
          bufOffset += 4 + len
        }
      }
    })
  }

  #indexAt (byteIndex, strict = true) {
    const chunks = this._chunks
    if (!chunks.length) return -1
    let lo = 0
    let hi = chunks.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const { offset, uint8Array } = chunks[mid]
      const end = offset + uint8Array.length - 1
      if (strict) {
        if (byteIndex === end) return mid
        if (byteIndex < offset) hi = mid - 1
        else lo = mid + 1
      } else {
        if (byteIndex >= offset && byteIndex < offset + uint8Array.length) return mid
        if (byteIndex < offset) hi = mid - 1
        else lo = mid + 1
      }
    }
    return -1
  }

  #chunkAt (byteIndex, strict = true) {
    const idx = this.#indexAt(byteIndex, strict)
    return idx >= 0 ? this._chunks[idx] : undefined
  }
}
