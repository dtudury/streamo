import { Hub } from './Hub.js'
import { hexToBytes, bytesToHex } from '../utils.js'

const KEY_BYTES = 33
const LENGTH_PREFIX = 4

const chunkCount = record => (record.wireByteLength - record.byteLength) / LENGTH_PREFIX

function chunksAfter (record, afterAddress) {
  chunkCount(record)
  const fresh = []
  let address = record.byteLength - 1
  while (address > afterAddress) {
    const chunk = record.resolve(address)
    fresh.unshift({ address, chunk })
    address -= chunk.length
  }
  return fresh
}

function framed (key, chunks) {
  const size = chunks.reduce((total, { chunk }) => total + LENGTH_PREFIX + chunk.length, 0)
  const frame = new Uint8Array(KEY_BYTES + size)
  frame.set(hexToBytes(key), 0)
  const view = new DataView(frame.buffer)
  let at = KEY_BYTES
  for (const { chunk } of chunks) {
    view.setUint32(at, chunk.length, true)
    frame.set(chunk, at + LENGTH_PREFIX)
    at += LENGTH_PREFIX + chunk.length
  }
  return frame
}

export class Upstream {
  #connection
  #writers = new Map()
  #asked = new Set()
  #sentThrough = new Map()

  constructor ({ recaller, connection }) {
    if (!recaller) throw new TypeError('Upstream: recaller is required')
    if (!connection) throw new TypeError('Upstream: connection is required')
    this.hub = new Hub({ recaller })
    this.#connection = connection

    connection.on('message', data => this.#receive(data))

    recaller.watch('upstream:ask-for-what-the-hub-holds', () => {
      for (const key of this.hub.keys()) {
        if (this.#asked.has(key)) continue
        this.#asked.add(key)
        connection.send(JSON.stringify({ type: 'want', key }))
      }
    })

    recaller.watch('upstream:send-what-we-have-drafted', () => {
      for (const key of this.hub.keys()) {
        const draft = this.hub.getDraft(key)
        if (!draft) continue
        const sentThrough = this.#sentThrough.get(key) ?? this.hub.getMirror(key).byteLength - 1
        const fresh = chunksAfter(draft, sentThrough)
        if (!fresh.length) continue
        this.#sentThrough.set(key, fresh[fresh.length - 1].address)
        this.#connection.send(framed(key, fresh))
      }
    })
  }

  #receive (data) {
    if (typeof data === 'string') return
    const key = bytesToHex(data.subarray(0, KEY_BYTES))
    const chunk = data.subarray(KEY_BYTES)
    if (!chunk.length) return
    this.#writerFor(key).write(chunk)
  }

  #writerFor (key) {
    let writer = this.#writers.get(key)
    if (!writer) {
      writer = this.hub.getMirror(key).makeWritableStream().getWriter()
      this.#writers.set(key, writer)
    }
    return writer
  }

  close () { this.#connection.close() }
}
