/**
 * @file Addressifier — append-only content-addressable byte store.
 *
 * The byte-level foundation. Knows nothing about types or values; just
 * appends Uint8Array chunks and indexes them by content. Higher layers
 * (CodecRegistry, Streamo, Repo, registrySync) build on this.
 *
 * See design.md §1.
 */
import { ContentMap } from './ContentMap.js'

/**
 * Append-only, content-addressable byte store.
 *
 * Each appended Uint8Array gets an address equal to the index of its last byte.
 * Duplicate content is rejected: the same bytes always live at the same address.
 *
 * The store exposes ReadableStream / WritableStream for network sync — the wire
 * format is a sequence of length-prefixed chunks (4-byte little-endian length
 * followed by the chunk bytes).
 */
export class Addressifier {
  /** @type {Array.<{uint8Array: Uint8Array, offset: number}>} */
  #chunks = []
  #contentMap = new ContentMap()

  #resolveNext
  #nextChunk = new Promise(resolve => { this.#resolveNext = resolve })

  get byteLength () {
    if (!this.#chunks.length) return 0
    const last = this.#chunks[this.#chunks.length - 1]
    return last.offset + last.uint8Array.length
  }

  /**
   * Returns the Uint8Array whose last byte is at `address`.
   * For negative addresses, the caller (CodecRegistry) must override.
   * @param {number} address
   * @returns {Uint8Array}
   */
  resolve (address) {
    return this.#chunkAt(address).uint8Array
  }

  /**
   * Look up the address of a previously appended chunk.
   * @param {Uint8Array} code
   * @returns {number|undefined}
   */
  addressOf (code) {
    return this.#contentMap.get(code)
  }

  /**
   * Append a new chunk to the store. Returns its address.
   * Throws if the chunk is empty or already present.
   * @param {Uint8Array} code
   * @returns {number}
   */
  append (code) {
    if (!code.length) throw new Error('chunk must not be empty')
    if (this.#contentMap.get(code) !== undefined) throw new Error('chunk already exists')
    this.#chunks.push({ uint8Array: code, offset: this.byteLength })
    const address = this.byteLength - 1
    this.#contentMap.set(code, address)
    const prev = this.#resolveNext
    this.#nextChunk = new Promise(resolve => { this.#resolveNext = resolve })
    prev(code)
    return address
  }

  /**
   * Clear all stored chunks and reset the store to empty.
   * Any readers waiting on future chunks will never resolve after this call;
   * use only when no live readers exist (e.g. before an archiveSync write loop).
   */
  _reset () {
    this.#chunks = []
    this.#contentMap = new ContentMap()
    this.#nextChunk = new Promise(resolve => { this.#resolveNext = resolve })
  }

  /**
   * Clone this store up to (and including) `address`.
   * @param {number} address
   * @returns {Addressifier}
   */
  clone (address) {
    return this._applyClone(new Addressifier(), address)
  }

  /**
   * Copy internal store state (chunks + content map) into `target` up to
   * `address`. Called by subclass clone() methods so they can pass a
   * subclass instance as `target`.
   * @param {Addressifier} target
   * @param {number} address
   * @returns {Addressifier}
   */
  _applyClone (target, address) {
    const idx = this.#indexAt(address, false)
    target.#chunks = this.#chunks.slice(0, idx + 1)
    target.#contentMap = this.#contentMap.clone(address)
    return target
  }

  /**
   * Extract a byte range as a single Uint8Array.
   * @param {number} [start=0]
   * @param {number} [end=this.byteLength]
   * @returns {Uint8Array}
   */
  slice (start = 0, end = this.byteLength) {
    const parts = []
    for (const { uint8Array, offset } of this.#chunks) {
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

  /**
   * Return a byte at a specific index (not address — just a raw byte position).
   * @param {number} byteIndex
   * @returns {number|undefined}
   */
  byteAt (byteIndex) {
    const chunk = this.#chunkAt(byteIndex, false)
    if (!chunk) return undefined
    return chunk.uint8Array[byteIndex - chunk.offset]
  }

  /**
   * ReadableStream that emits chunks at or after `fromOffset`, then waits
   * for new ones. Wire format: 4-byte LE length prefix followed by chunk
   * bytes.
   *
   * `fromOffset` lets the wire skip bytes the receiver already has — e.g.
   * a client reconnecting carries its `repo.signedLength` in the subscribe
   * message, the server validates the handshake, then starts emitting
   * from there. If `fromOffset` is past the end, the stream waits for new
   * chunks past that position (rare; valid only if the receiver claims
   * to be ahead, which the subscribe handshake usually rejects).
   *
   * @param {{ fromOffset?: number }} [options]
   * @returns {ReadableStream}
   */
  makeReadableStream ({ fromOffset = 0 } = {}) {
    const self = this
    // Linear scan to find the first chunk at or past fromOffset. SIGs are
    // fixed-format 97-byte chunks and signedLength always lands on a chunk
    // boundary, so this is exact when called with `fromOffset = signedLength`.
    let index = 0
    while (index < self.#chunks.length && self.#chunks[index].offset < fromOffset) index++
    return new ReadableStream({
      async start (controller) {
        while (true) {
          while (index < self.#chunks.length) {
            const { uint8Array } = self.#chunks[index++]
            const len = new Uint8Array(new Uint32Array([uint8Array.length]).buffer)
            const frame = new Uint8Array(len.length + uint8Array.length)
            frame.set(len)
            frame.set(uint8Array, len.length)
            controller.enqueue(frame)
          }
          await self.#nextChunk
        }
      }
    })
  }

  /**
   * WritableStream that accepts the wire format and calls append() for each chunk.
   *
   * Resilient by design: duplicate chunks are silently skipped (they are already
   * stored at the same address). Frames with implausible lengths are rejected so
   * a single corrupt byte cannot stall the stream indefinitely.
   *
   * @param {number} [maxFrameSize=64*1024*1024]  reject frames larger than this
   * @returns {WritableStream}
   */
  makeWritableStream (maxFrameSize = 64 * 1024 * 1024) {
    const self = this
    let buf = new Uint8Array(0)
    return new WritableStream({
      write (incoming) {
        const next = new Uint8Array(buf.length + incoming.length)
        next.set(buf); next.set(incoming, buf.length)
        buf = next
        while (buf.length >= 4) {
          const len = new Uint32Array(buf.slice(0, 4).buffer)[0]
          if (len === 0) throw new Error('malformed frame: zero-length chunk')
          if (len > maxFrameSize) throw new Error(`malformed frame: length ${len} exceeds ${maxFrameSize}`)
          if (buf.length < 4 + len) break
          const code = buf.slice(4, 4 + len)
          if (self.addressOf(code) === undefined) self.append(code)
          buf = buf.slice(4 + len)
        }
      }
    })
  }

  #indexAt (byteIndex, strict = true) {
    const chunks = this.#chunks
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
    return idx >= 0 ? this.#chunks[idx] : undefined
  }
}
