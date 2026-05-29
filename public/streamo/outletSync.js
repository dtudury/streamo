import { WebSocketServer } from 'ws'
import { hexToBytes } from './utils.js'
import { handleRegistryPeer } from './registrySync.js'
import { StreamoRecordSerializer, ConnectionAccumulator } from './StreamoRecordSerializer.js'

/**
 * @file Attach streamo's WebSocket sync protocol to a `ws` server.
 *
 * Two handshake modes, distinguished by the first text message:
 *   "registry"            → delegate to handleRegistryPeer (multi-Record)
 *   <hex pubkey>          → full-duplex sync of that one Record
 *
 * Duplicate chunks dedup via content-addressing; bad signatures drop the
 * connection. The relay arbitrates each Record's chain via a per-Record
 * StreamoRecordSerializer shared across all connections to this server.
 */

export function attachStreamSync (wss, registry, label = 'ws', peerOptions = {}) {
  // Shared per-server state. interestMap/announcementMap are the ephemeral
  // interest+announce routing tables (live fan-out + replay-on-late-arrival);
  // serializers holds one StreamoRecordSerializer per Record so concurrent
  // pushes from different clients queue against the same chain-head check.
  const routing = { interestMap: new Map(), announcementMap: new Map(), serializers: new Map() }

  // isAuthority tells handleRegistryPeer to route incoming chunks through
  // the serializer (relay-side chain check) instead of doing per-connection
  // crypto verification — this is the "relay is the chain authority" path.
  const peerOptionsAsAuthority = { ...peerOptions, isAuthority: true }

  wss.on('connection', ws => {
    let reader = null

    ws.once('message', async rawHandshake => {
      const handshake = rawHandshake.toString().trim()

      if (handshake === 'registry') {
        handleRegistryPeer(ws, registry, peerOptionsAsAuthority, label, routing)
        return
      }

      const publicKeyHex = handshake

      // Materializing the Record is async; frames that arrive in that gap
      // would otherwise be dropped. Buffer them, then drain after the
      // handshake completes (or close on materialize failure).
      const pendingFrames = []
      const bufferIncoming = data => pendingFrames.push(data)
      ws.on('message', bufferIncoming)

      let record
      try {
        record = await registry._materialize(publicKeyHex)
      } catch (e) {
        console.error(`[${label}] failed to materialize streamo ${publicKeyHex.slice(0, 8)}...: ${e.message}`)
        ws.close()
        return
      }

      ws.off('message', bufferIncoming)

      // Outbound: replay everything, then forward new chunks as the Record
      // grows. The IIFE keeps this loop running without blocking the
      // inbound handler set up below.
      reader = record.makeReadableStream().getReader()
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

      // Inbound: one serializer per Record shared across all connections to
      // this server — concurrent pushes queue against the same chain-head
      // check (the relay-as-authority invariant).
      const publicKey = hexToBytes(publicKeyHex)
      let serializer = routing.serializers.get(publicKeyHex)
      if (!serializer) {
        serializer = new StreamoRecordSerializer(record, publicKey)
        routing.serializers.set(publicKeyHex, serializer)
      }
      const accumulator = new ConnectionAccumulator(serializer, (result) => {
        if (!result.accepted) {
          // Legacy (non-registry) path has no JSON channel back to the
          // peer; log the reason and let a subsequent bad batch close.
          console.error(`[${label}] rejected batch from ${publicKeyHex.slice(0, 8)}...: ${result.reason}`)
        }
      })

      const writeChunk = data => {
        accumulator.write(new Uint8Array(data)).catch(e => {
          console.error(`[${label}] malformed frame from ${publicKeyHex.slice(0, 8)}...: ${e.message}`)
          ws.close()
        })
      }

      for (const data of pendingFrames) writeChunk(data)
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
 * Start a standalone outlet — a WebSocketServer with streamo's sync
 * protocol attached. `peerOptions.home` is the pubkey announced in the
 * registry-handshake hello; without it, `--feed` clients see a session
 * open but the auto-subscribe cascade has nothing to walk.
 */
export function outletSync (registry, port, peerOptions = {}) {
  const wss = new WebSocketServer({ port })
  attachStreamSync(wss, registry, 'outlet', peerOptions)
  return wss
}
