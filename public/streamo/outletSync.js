import { WebSocketServer } from 'ws'
import { hexToBytes } from './utils.js'
import { handleRegistryPeer } from './registrySync.js'
import { RepoSerializer, ConnectionAccumulator } from './RepoSerializer.js'

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
  // serializers: keyHex → RepoSerializer, one per repo across all connections
  // to this WSS. The relay is the chain authority; all incoming pushes for
  // a given repo queue against the same serializer regardless of which
  // client sent them.
  const routing = { interestMap: new Map(), announcementMap: new Map(), serializers: new Map() }
  // The relay is the authority — pass through to handleRegistryPeer so its
  // incoming-chunk path routes through the serializer instead of doing
  // per-connection chain verification.
  const authorityOptions = { ...peerOptions, isAuthority: true }

  wss.on('connection', ws => {
    let reader = null

    ws.once('message', async rawHandshake => {
      const handshake = rawHandshake.toString().trim()

      if (handshake === 'registry') {
        handleRegistryPeer(ws, registry, authorityOptions, label, routing)
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
        streamo = await registry._materialize(publicKeyHex)
      } catch (e) {
        console.error(`[${label}] failed to materialize streamo ${publicKeyHex.slice(0, 8)}...: ${e.message}`)
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

      // Peer → streamo: route through the per-repo serializer (the relay is
      // the chain authority). Share serializers across all connections (incl.
      // the registry-mode path) via the WSS-level routing.serializers map.
      const publicKey = hexToBytes(publicKeyHex)
      let serializer = routing.serializers.get(publicKeyHex)
      if (!serializer) {
        serializer = new RepoSerializer(streamo, publicKey)
        routing.serializers.set(publicKeyHex, serializer)
      }
      const accumulator = new ConnectionAccumulator(serializer, (result) => {
        if (!result.accepted) {
          // Legacy path has no JSON channel back to the peer; on reject we
          // just log and let the next bad batch close the connection.
          console.error(`[${label}] rejected batch from ${publicKeyHex.slice(0, 8)}...: ${result.reason}`)
        }
      })

      const writeChunk = data => {
        accumulator.write(new Uint8Array(data)).catch(e => {
          console.error(`[${label}] malformed frame from ${publicKeyHex.slice(0, 8)}...: ${e.message}`)
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
