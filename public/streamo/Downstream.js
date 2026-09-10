import { hexToBytes } from './utils.js'

const KEY_BYTES = 33

export class Downstream {
  #hub
  #connection
  #serving = new Set()

  constructor ({ hub, connection }) {
    if (!hub) throw new TypeError('Downstream: hub is required')
    if (!connection) throw new TypeError('Downstream: connection is required')
    this.#hub = hub
    this.#connection = connection

    connection.on('message', data => {
      if (typeof data !== 'string') return
      const message = JSON.parse(data)
      if (message.type === 'want') this.#serve(message.key)
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

  close () { this.#connection.close() }
}
