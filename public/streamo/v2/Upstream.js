import { Hub } from './Hub.js'
import { hexToBytes, bytesToHex } from '../utils.js'

const KEY_BYTES = 33

export class Upstream {
  #connection
  #writers = new Map()
  #asked = new Set()

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
  }

  #receive (data) {
    if (typeof data === 'string') return
    const key = bytesToHex(data.slice(0, KEY_BYTES))
    const chunk = data.slice(KEY_BYTES)
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
