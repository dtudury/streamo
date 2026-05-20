/**
 * @file registrySync — bidirectional multi-repo WebSocket sync.
 *
 * After a "registry" handshake, the server sends a `hello { home }`
 * pointer and the client auto-subscribes; then both sides exchange
 * `subscribe`/`interest`/`announce`/`ping` JSON messages and binary
 * [33-byte-key-prefix][chunk] frames. Discovery cascades content-driven
 * via the `follow` callback (typically walking `home.value.members`).
 * Private repos sync only when explicitly subscribed — they are never
 * enumerated. 20-second keep-alive ping for PaaS hosts that idle-close.
 *
 * See design.md §10.
 */
// Use native WebSocket in the browser; fall back to the `ws` package in Node.
const WS = globalThis.WebSocket ?? (await import('ws')).default

import { hexToBytes, bytesToHex } from './utils.js'
import { RepoSerializer, ConnectionAccumulator } from './RepoSerializer.js'

/**
 * Normalize a browser-native WebSocket to the Node `ws` EventEmitter interface.
 * If the socket already has `.on()` (Node ws package) it is returned unchanged.
 * @param {WebSocket} ws
 * @returns {WebSocket}
 */
function adaptWebSocket (ws) {
  if (typeof ws.on === 'function') return ws
  ws.binaryType = 'arraybuffer'
  const h = { open: [], close: [], error: [], message: [] }
  ws.addEventListener('open', () => h.open.forEach(fn => fn()))
  ws.addEventListener('close', e => h.close.forEach(fn => fn(e.code, e.reason)))
  ws.addEventListener('error', e => h.error.forEach(fn => fn(e)))
  ws.addEventListener('message', e => {
    const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data
    h.message.forEach(fn => fn(data))
  })
  ws.on = (ev, fn) => { h[ev]?.push(fn); return ws }
  ws.off = (ev, fn) => { if (h[ev]) h[ev] = h[ev].filter(f => f !== fn); return ws }
  return ws
}

// Compressed secp256k1 public keys are always 33 bytes (0x02 or 0x03 prefix).
// Binary frames are prefixed with the raw key bytes so each chunk can be routed
// to the correct repository without any per-connection state table.
const KEY_BYTES = 33

// Keep-alive: send a {type:'ping'} JSON frame periodically so PaaS hosts that
// idle-close WebSockets don't drop us. Browsers don't expose WS ping/pong
// frames, so we use a JSON message — the receiver silently ignores unknown
// types, but the frame itself counts as activity.
const KEEPALIVE_INTERVAL_MS = 20000

/**
 * @typedef {Object} RegistrySyncOptions
 *
 * @property {(keyHex: string, repo: import('./Repo.js').Repo, subscribe: (keyHex: string) => void) => void} [follow]
 *   Called reactively whenever a synced repository's value changes.  Use this
 *   to extract repository keys embedded in the data and call `subscribe(key)`
 *   on each one.  The registry will then sync that repo too, and `follow` will
 *   be called on it in turn — so discovery propagates through the graph.
 *
 *   Example — chat app where the chat repo lists participant keys:
 *
 *     follow: (keyHex, repo, subscribe) => {
 *       for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
 *     }
 *
 *   `subscribe` is idempotent and safe to call for already-synced repos.
 *
 * @property {(key: string, topic: string) => void} [onAnnounce]
 *   Called when a remote peer announces a repository as related to a topic.
 *   `key` is the announced repository's hex public key; `topic` is the hex key
 *   of the repository it was announced under.  Only fires for topics you have
 *   previously declared interest in via `session.interest(topicKey)`.
 *
 * @property {string} [home]
 *   Server-side only.  The hex public key of the repository this peer offers
 *   as its public face — its "home."  When set, the peer sends a `hello`
 *   message announcing this key immediately after the handshake.  The remote
 *   side will auto-subscribe to this key; from there, the home's `members`
 *   array (walked by the `follow` callback) is the curated set of publicly
 *   endorsed repos that get synced in turn.  Private repos the relay stores
 *   are not enumerated — they sync on demand by key.
 *
 * @property {(msg: { home?: string }) => void} [onHello]
 *   Called once when the remote peer's `hello` message arrives, AFTER the
 *   auto-subscribe to `home` has been kicked off.  The message may carry a
 *   `home` key (the peer's public face) and is extensible to future fields
 *   like protocol version.
 */

/**
 * Attach bidirectional multi-repository sync to an already-open WebSocket.
 *
 * ## Protocol (after the "registry" text handshake)
 *
 * ### Control messages — JSON text frames
 *
 *   { "type": "hello", "home": "hex" }
 *     Server-side identity announcement, sent once immediately after the
 *     handshake when the peer was configured with `home`.  The receiver
 *     learns the relay's public-face repository AND auto-subscribes to it,
 *     so discovery cascades from there: home arrives, the `follow` callback
 *     walks its `members`, those subscribe in turn.  Private repos are not
 *     enumerated anywhere — they sync only when explicitly requested by key.
 *
 *   { "type": "subscribe", "key": "hex1" }
 *     Request to sync a repository bidirectionally.  The sender will stream
 *     its copy of the repo to the peer AND expects the peer to stream back.
 *     Both sides set up a makeVerifiedWritableStream for the key so only
 *     correctly-signed chunks are accepted.
 *
 * ### Data frames — binary
 *
 *   [33 bytes: compressed secp256k1 public key][N bytes: stream chunk]
 *
 *     The 33-byte prefix identifies which repository the chunk belongs to
 *     (secp256k1 keys always start with 0x02 or 0x03; JSON control messages
 *     always start with 0x7B '{', so the two are unambiguous).
 *     The chunk bytes are taken directly from makeReadableStream() and fed
 *     directly into makeVerifiedWritableStream() on the other side.
 *
 * ## Discovery via `follow`
 *
 * When a `follow` function is provided, it is called via recaller.watch()
 * whenever a synced repository's value changes.  Calling `subscribe(key)` inside
 * `follow` causes that key to be synced too, and `follow` will be called on it
 * in turn.  This lets a graph of related repositories be discovered organically
 * from content — no out-of-band catalog is needed.
 *
 * @param {WebSocket} ws
 * @param {import('./RepoRegistry.js').RepoRegistry} registry
 * @param {RegistrySyncOptions} [options]
 * @param {string} [label]  prefix for log messages
 */
export function handleRegistryPeer (ws, registry, options = {}, label = 'registry', routing = null) {
  const { follow = null, onAnnounce = null, onHello = null, home = null, isAuthority = false } = options

  const readers = new Map()        // keyHex → ReadableStreamDefaultReader (we → peer)
  const writers = new Map()        // keyHex → WritableStreamDefaultWriter (peer → us)
  const pendingChunks = new Map()  // keyHex → Uint8Array[] (buffered while writer opens)
  const followFns = new Map()      // keyHex → fn registered with recaller.watch

  function sendJson (msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  function handleWriteError (keyHex, e) {
    console.error(`[${label}] rejected chunk for ${keyHex.slice(0, 8)}...: ${e.message}`)
    ws.close()
  }

  /**
   * Ensure full bidirectional sync is active for keyHex.
   * Idempotent — safe to call multiple times for the same key.
   */
  async function syncKey (keyHex) {
    const repo = await registry.open(keyHex)

    // We → peer: replay all existing chunks then stream new ones
    if (!readers.has(keyHex)) {
      const keyBytes = hexToBytes(keyHex)
      const reader = repo.makeReadableStream().getReader()
      readers.set(keyHex, reader)
      ;(async () => {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (ws.readyState === ws.OPEN) {
              const frame = new Uint8Array(KEY_BYTES + value.length)
              frame.set(keyBytes, 0)
              frame.set(value, KEY_BYTES)
              ws.send(frame)
            } else break
          }
        } catch {}
      })()
    }

    // Peer → us: accept incoming chunks; drain anything buffered during setup.
    //
    // Two modes:
    //   - isAuthority (relay-side): incoming chunks are *pushes* from a
    //     client. Route through the per-repo RepoSerializer via a
    //     per-connection ConnectionAccumulator. On reject, send a
    //     `{type: 'reject', key, reason}` control message back to the
    //     submitting peer instead of just closing.
    //   - default (client-side): incoming chunks are *from the relay* —
    //     authoritative by invariant. Use the existing verified writer
    //     as defense-in-depth (Phase 1B-lite keeps this; Phase 1C will
    //     remove it in favor of trust+append).
    if (!writers.has(keyHex)) {
      let writer
      if (isAuthority) {
        const publicKey = hexToBytes(keyHex)
        let serializer = routing?.serializers?.get(keyHex)
        if (!serializer) {
          serializer = new RepoSerializer(repo, publicKey)
          routing?.serializers?.set(keyHex, serializer)
        }
        writer = new ConnectionAccumulator(serializer, (result) => {
          if (!result.accepted) {
            sendJson({ type: 'reject', key: keyHex, reason: result.reason })
          }
        })
      } else {
        const publicKey = hexToBytes(keyHex)
        writer = repo.makeVerifiedWritableStream(publicKey).getWriter()
      }
      writers.set(keyHex, writer)
      const pending = pendingChunks.get(keyHex) ?? []
      pendingChunks.delete(keyHex)
      for (const chunk of pending) {
        writer.write(chunk).catch(e => handleWriteError(keyHex, e))
      }
    }

    // Content-driven discovery: watch this repo's value and subscribe to any
    // keys the `follow` callback extracts from it.  Runs immediately (to catch
    // existing data) and re-runs whenever the repo's value changes.
    if (follow && !followFns.has(keyHex)) {
      const fn = () => follow(keyHex, repo, key => subscribeToKey(key))
      followFns.set(keyHex, fn)
      repo.recaller.watch(`registry-follow:${keyHex}`, fn)
    }
  }

  /**
   * Subscribe to keyHex from the peer: set up local sync then announce intent.
   * Sending "subscribe" before streaming ensures the peer has its writer ready
   * before our chunks arrive.
   */
  async function subscribeToKey (keyHex) {
    if (writers.has(keyHex)) return  // already subscribed
    sendJson({ type: 'subscribe', key: keyHex })
    await syncKey(keyHex)
  }

  // Identity announcement. The remote side auto-subscribes to `home` when
  // this arrives — that's the bootstrap pointer, and from there the `follow`
  // callback walks the home's members. No catalog enumeration anywhere.
  if (home) sendJson({ type: 'hello', home })

  // Keep-alive heartbeat — both sides ping; receivers ignore unknown types.
  const keepalive = setInterval(() => {
    if (ws.readyState === ws.OPEN) sendJson({ type: 'ping' })
  }, KEEPALIVE_INTERVAL_MS)

  ws.on('message', async data => {
    // Normalize to Uint8Array — works for Node Buffer, ArrayBuffer, Uint8Array, string
    const buf = typeof data === 'string' ? new TextEncoder().encode(data)
      : data instanceof Uint8Array ? data
      : new Uint8Array(data)
    if (!buf.length) return

    if (buf[0] === 0x7B) {
      // JSON control message ('{' = 0x7B; secp256k1 keys start with 0x02 or 0x03)
      try {
        const msg = JSON.parse(new TextDecoder().decode(buf))
        if (msg.type === 'hello') {
          // Auto-subscribe to the remote's home. From here, the `follow`
          // callback will cascade through home.value.members.
          if (msg.home) await subscribeToKey(msg.home)
          onHello?.(msg)
        } else if (msg.type === 'subscribe') {
          await syncKey(msg.key)
        } else if (msg.type === 'interest') {
          if (routing) {
            const { interestMap, announcementMap } = routing
            if (!interestMap.has(msg.key)) interestMap.set(msg.key, new Set())
            interestMap.get(msg.key).add(ws)
            // Replay current announces on this topic so the newcomer learns
            // about peers who announced before they arrived.  Skip the
            // newcomer's own announces (in case interest follows announce on
            // the same socket).
            for (const [announcer, keys] of announcementMap.get(msg.key) ?? []) {
              if (announcer === ws) continue
              for (const key of keys) {
                if (ws.readyState === ws.OPEN)
                  ws.send(JSON.stringify({ type: 'announce', key, topic: msg.key }))
              }
            }
          }
        } else if (msg.type === 'reject') {
          // The peer (authority) refused our push for this repo. Surface
          // it via the repo's reactive pushRejected flag so the app UI
          // can react. The bytes we tried to push are still in our local
          // store; recovery is the app's concern.
          const repo = registry.get(msg.key)
          if (repo) repo._setPushRejected({ reason: msg.reason })
        } else if (msg.type === 'announce') {
          // Fan out to all subscribers of this topic (server-side routing)
          if (routing) {
            for (const sub of routing.interestMap.get(msg.topic) ?? []) {
              if (sub !== ws && sub.readyState === sub.OPEN)
                sub.send(JSON.stringify({ type: 'announce', key: msg.key, topic: msg.topic }))
            }
            // Remember this announce so future interest from new peers
            // gets it replayed.  Lifetime: until this socket disconnects.
            const { announcementMap } = routing
            if (!announcementMap.has(msg.topic)) announcementMap.set(msg.topic, new Map())
            const perTopic = announcementMap.get(msg.topic)
            if (!perTopic.has(ws)) perTopic.set(ws, new Set())
            perTopic.get(ws).add(msg.key)
          }
          // Deliver to local callback (client-side)
          onAnnounce?.(msg.key, msg.topic)
        }
      } catch (e) {
        console.error(`[${label}] bad control message: ${e.message}`)
      }
    } else {
      // Binary frame: [33-byte key prefix][chunk]
      if (buf.length <= KEY_BYTES) return
      const keyHex = bytesToHex(buf.subarray(0, KEY_BYTES))
      const chunk = new Uint8Array(buf.slice(KEY_BYTES))
      const writer = writers.get(keyHex)
      if (writer) {
        writer.write(chunk).catch(e => handleWriteError(keyHex, e))
      } else {
        // Writer is being set up asynchronously — buffer until ready
        if (!pendingChunks.has(keyHex)) pendingChunks.set(keyHex, [])
        pendingChunks.get(keyHex).push(chunk)
      }
    }
  })

  function cleanup () {
    clearInterval(keepalive)
    for (const reader of readers.values()) reader.cancel().catch(() => {})
    for (const [keyHex, fn] of followFns) {
      registry.get(keyHex)?.recaller.unwatch(fn)
    }
    if (routing) {
      for (const subs of routing.interestMap.values()) subs.delete(ws)
      for (const perTopic of routing.announcementMap.values()) perTopic.delete(ws)
    }
  }

  ws.on('close', cleanup)
  ws.on('error', err => {
    console.error(`[${label}] connection error: ${err.message}`)
    cleanup()
  })

  return {
    /** Declare interest in a topic — receive future `announce` messages for it. */
    interest (key) { sendJson({ type: 'interest', key }) },
    /** Announce `key` as related to `topic` — routed to all peers interested in that topic. */
    announce (key, topic) { sendJson({ type: 'announce', key, topic }) },
    /** Subscribe to a specific repo key explicitly. */
    subscribe (key) { return subscribeToKey(key) }
  }
}

/**
 * @typedef {Object} RegistrySession
 * @property {WebSocket} ws  The underlying WebSocket connection.
 * @property {() => void} close  Close the connection.
 * @property {(key: string) => void} interest
 *   Declare interest in a topic.  The server will route `announce` messages
 *   for this topic to you via the `onAnnounce` callback in options.
 * @property {(key: string, topic: string) => void} announce
 *   Announce a repository as related to `topic`.  The server fans this out to
 *   all other connected peers that have called `interest(topic)`.  Ephemeral —
 *   no persistence, only routes to currently-connected interested peers.
 */

/**
 * Connect a local RepoRegistry to a remote one and sync repositories.
 *
 * Sends `"registry"` as the WebSocket handshake.  The server responds with
 * a `hello` message carrying its `home` key; we auto-subscribe to that, and
 * the `follow` callback walks members from there.  Returns a session object
 * with `interest`/`announce`/`subscribe` for ephemeral and explicit work.
 *
 * ### Basic usage — sync the relay's public face
 *
 *   const { ws } = await registrySync(myRegistry, 'localhost', 8080)
 *
 * ### Ephemeral messaging — express interest and announce related repos
 *
 *   const session = await registrySync(myRegistry, 'localhost', 8080, {
 *     onAnnounce: (key, topic) => { console.log(key, 'is related to', topic) }
 *   })
 *   session.interest(rootKey)          // start receiving announcements for rootKey
 *   session.announce(myKey, rootKey)   // tell interested peers about myKey
 *
 * ### Content-driven discovery via `follow`
 *
 *   const session = await registrySync(myRegistry, 'localhost', 8080, {
 *     follow: (keyHex, repo, subscribe) => {
 *       for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
 *     }
 *   })
 *
 * ### Subscribing to a specific key not reachable from the relay's home
 *
 *   const session = await registrySync(myRegistry, 'localhost', 8080)
 *   session.subscribe(privateKeySharedOutOfBand)
 *
 * @param {import('./RepoRegistry.js').RepoRegistry} registry
 * @param {string} host
 * @param {number} port
 * @param {RegistrySyncOptions} [options]
 * @returns {Promise<RegistrySession>}
 */
export function registrySync (registry, host, port, options = {}) {
  return new Promise((resolve, reject) => {
    // In a browser served over https://, plain ws:// is blocked as mixed
    // content. Derive the protocol from location when available; Node has no
    // location and falls through to ws://.
    const protocol = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'
    const ws = adaptWebSocket(new WS(`${protocol}://${host}:${port}`))

    ws.on('open', () => {
      ws.send('registry')
      const peer = handleRegistryPeer(ws, registry, options, 'origin-registry')
      resolve({ ws, close: () => ws.close(), ...peer })
    })

    ws.on('error', reject)
  })
}
