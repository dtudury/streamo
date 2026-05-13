import WebSocket from 'ws'
import { hexToBytes } from './utils.js'

/**
 * Connect to a remote outlet and begin full-duplex sync for `stream`.
 *
 * Sends a handshake (the hex public key), then:
 *   local → remote: all existing chunks, then new ones as they arrive
 *   remote → local: chunks verified against the stream's public key
 *
 * @param {import('./Stream.js').Stream} stream
 * @param {string} publicKeyHex  hex-encoded public key identifying this stream
 * @param {string} host
 * @param {number} port
 * @param {Object} [options]
 * @param {'ws'|'wss'} [options.protocol='ws']
 *   WebSocket protocol. Use `'wss'` when the relay is behind a TLS terminator
 *   (Caddy / nginx / fly.io) and you're connecting cross-host. Local dev
 *   stays `'ws'`.
 * @returns {Promise<WebSocket>}  resolves when the connection is open and sync has started
 */
export function originSync (stream, publicKeyHex, host, port, { protocol = 'ws' } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${protocol}://${host}:${port}`)

    ws.on('open', () => {
      // Handshake: identify which stream we want to sync
      ws.send(publicKeyHex)

      // Local → remote: replay all chunks, then stream new ones
      const reader = stream.makeReadableStream().getReader()
      ;(async () => {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (ws.readyState === WebSocket.OPEN) ws.send(value)
            else break
          }
        } catch {}
      })()

      // Remote → local: verify signature chunks before accepting
      const publicKey = hexToBytes(publicKeyHex)
      const writer = stream.makeVerifiedWritableStream(publicKey).getWriter()

      ws.on('message', data => {
        writer.write(new Uint8Array(data)).catch(e => {
          console.error(`[origin] rejected chunk: ${e.message}`)
          ws.close()
        })
      })

      ws.on('close', () => reader.cancel().catch(() => {}))
      ws.on('error', err => {
        console.error('[origin] connection error:', err.message)
        reader.cancel().catch(() => {})
      })

      resolve(ws)
    })

    ws.on('error', reject)
  })
}
