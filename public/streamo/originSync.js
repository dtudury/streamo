import WebSocket from 'ws'

/**
 * Connect to a remote outlet and begin full-duplex sync for `stream`.
 *
 * Sends a handshake (the hex public key), then:
 *   local → remote: replay all chunks, then stream new ones
 *   remote → local: trust+append (the upstream relay is the chain
 *                   authority for this repo's canonical chain)
 *
 * @param {import('./Repo.js').Repo} stream
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

      // Remote → local: the upstream is the chain authority — trust+append
      // via makeRelayInboundStream. Alignment check still catches push-in-
      // flight races (we wrote locally and the upstream hasn't accepted yet
      // when it sends down other content).
      const writer = stream.makeRelayInboundStream().getWriter()

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
