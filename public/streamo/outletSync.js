import { WebSocketServer } from 'ws'
import { hexToBytes } from './utils.js'
import { handleRegistryPeer } from './registrySync.js'

/**
 * Attach the streamo sync protocol to an existing WebSocketServer.
 *
 * Protocol:
 *   1. Client sends a text message containing the hex-encoded public key of
 *      the streamo it wants to sync.
 *   2. Server opens (or creates) that streamo and begins full-duplex sync:
 *        server → client: all existing chunks, then new ones as they arrive
 *        client → server: chunks verified against the streamo's public key
 *
 * Duplicate chunks are silently skipped on both sides (content-addressed
 * dedup). Invalid signature chunks close the connection.
 *
 * @param {WebSocketServer} wss
 * @param {import('./RepoRegistry.js').RepoRegistry} registry
 * @param {string} [label]  prefix for log messages
 */
export function attachStreamSync (wss, registry, label = 'ws', peerOptions = {}) {
  // Shared routing state for the ephemeral interest/announce messaging layer.
  // interestMap: topic → Set<ws> currently interested (for live fan-out).
  // announcementMap: topic → Map<ws, Set<key>> of currently-live announcements
  // (replayed to peers who express interest after the fact, so a newcomer
  // discovers existing announcers without anyone heartbeating). Entries are
  // cleaned up on disconnect — "live" = "by a currently-connected peer."
  const routing = { interestMap: new Map(), announcementMap: new Map() }

  wss.on('connection', ws => {
    let reader = null

    ws.once('message', async rawHandshake => {
      const handshake = rawHandshake.toString().trim()

      if (handshake === 'registry') {
        handleRegistryPeer(ws, registry, peerOptions, label, routing)
        return
      }

      const publicKeyHex = handshake

      // Buffer any data frames that arrive while we're opening the streamo,
      // so nothing is dropped during the async gap after the handshake.
      const pending = []
      const buffer = data => pending.push(data)
      ws.on('message', buffer)

      let streamo
      try {
        streamo = await registry.open(publicKeyHex)
      } catch (e) {
        console.error(`[${label}] failed to open streamo ${publicKeyHex.slice(0, 8)}...: ${e.message}`)
        ws.close()
        return
      }

      ws.off('message', buffer)

      // Streamo → peer: replay all chunks, then stream new ones
      reader = streamo.makeReadableStream().getReader()
      ;(async () => {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (ws.readyState === ws.OPEN) ws.send(value)
            else break
          }
        } catch {}
      })()

      // Peer → streamo: verify signature chunks before accepting
      const publicKey = hexToBytes(publicKeyHex)
      const writer = streamo.makeVerifiedWritableStream(publicKey).getWriter()

      const writeChunk = data => {
        writer.write(new Uint8Array(data)).catch(e => {
          console.error(`[${label}] rejected chunk from ${publicKeyHex.slice(0, 8)}...: ${e.message}`)
          ws.close()
        })
      }

      // Drain buffered frames, then handle live ones
      for (const data of pending) writeChunk(data)
      ws.on('message', writeChunk)
    })

    ws.on('close', () => reader?.cancel().catch(() => {}))
    ws.on('error', err => {
      console.error(`[${label}] connection error:`, err.message)
      reader?.cancel().catch(() => {})
    })
  })
}

/**
 * Start a standalone WebSocket server that syncs streamos from a RepoRegistry.
 *
 * @param {import('./RepoRegistry.js').RepoRegistry} registry
 * @param {number} port
 * @returns {WebSocketServer}
 */
export function outletSync (registry, port) {
  const wss = new WebSocketServer({ port })
  attachStreamSync(wss, registry, 'outlet')
  return wss
}
