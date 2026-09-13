import { makeVerifiedWritableStream } from './StreamoRecordSerializer.js'
import { hexToBytes, bytesToHex } from './utils.js'

const KEY_BYTES = 33

export class Downstream {
  #hub
  #connection
  #serving = new Set()
  #proposals = new Map()

  constructor ({ hub, connection }) {
    if (!hub) throw new TypeError('Downstream: hub is required')
    if (!connection) throw new TypeError('Downstream: connection is required')
    this.#hub = hub
    this.#connection = connection

    connection.on('message', data => {
      if (typeof data === 'string') {
        const message = JSON.parse(data)
        if (message.type === 'want') this.#serve(message.key)
        return
      }
      this.#receiveProposal(data)
    })
  }

  #serve (key) {
    if (this.#serving.has(key)) return
    this.#serving.add(key)
    const keyBytes = hexToBytes(key)
    const reader = this.#hub.getMirror(key).makeReadableStream({ fromOffset: 0 }).getReader()
    ;(async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const frame = new Uint8Array(KEY_BYTES + value.length)
        frame.set(keyBytes, 0)
        frame.set(value, KEY_BYTES)
        try { this.#connection.send(frame) } catch { break }
      }
    })()
  }

  #receiveProposal (data) {
    const key = bytesToHex(data.slice(0, KEY_BYTES))
    const payload = data.slice(KEY_BYTES)
    if (!payload.length) return
    let writer = this.#proposals.get(key)
    if (!writer) {
      writer = makeVerifiedWritableStream(this.#hub.getMirror(key), hexToBytes(key)).getWriter()
      this.#proposals.set(key, writer)
    }
    writer.write(payload).catch(() => {
      this.#proposals.delete(key)
      this.#connection.close()
    })
  }

  close () { this.#connection.close() }
}
