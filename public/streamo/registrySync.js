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
 * An unexpected socket close reconnects with exponential backoff; the
 * session object is stable across reconnects and replays its intent.
 *
 * See design.md §10.
 */
// Use native WebSocket in the browser; fall back to the `ws` package in Node.
const WS = globalThis.WebSocket ?? (await import('ws')).default

import { hexToBytes, bytesToHex } from './utils.js'
import { RepoSerializer, ConnectionAccumulator } from './RepoSerializer.js'

function arraysEqual (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

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

// Auto-reconnect: after a connection that was once live drops unexpectedly,
// re-open with exponential backoff + jitter until it comes back. The delay
// climbs RECONNECT_BASE_MS · 2ⁿ up to RECONNECT_MAX_MS; a connection that
// stayed open longer than RECONNECT_RESET_MS is treated as healthy and
// resets the climb — so a long-stable link that finally drops reconnects
// fast, while a flapping one keeps backing off.
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15000
const RECONNECT_RESET_MS = 30000

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
 * @property {boolean} [followMounts]
 *   When `true`, synced records' `mounts` tables are walked automatically —
 *   each mount entry's `ref` (the mounted record's pubkey) is subscribed in
 *   the same content-driven cascade as `follow`. Composes with `follow`: both
 *   run on every value change. Use this on any client or relay that wants to
 *   resolve mounts end-to-end without managing each mount target's
 *   subscription out of band. Defaults to `false`.
 *
 * @property {(key: string, topic: string) => void} [onAnnounce]
 *   Called when a remote peer announces a repository as related to a topic.
 *   `key` is the announced repository's hex public key; `topic` is the hex key
 *   of the repository it was announced under.  Only fires for topics you have
 *   previously declared interest in via `session.interest(topicKey)`.
 *
 * @property {boolean} [secure]
 *   Force the `wss://` scheme for the WebSocket connection.  In a browser
 *   the scheme is derived from `location` automatically; Node has no
 *   `location`, so a Node client connecting to a TLS relay must pass
 *   `secure: true` — otherwise it falls through to plain `ws://`.
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
 *
 * @property {(connected: boolean) => void} [onConnectionChange]
 *   Called with `true` each time a connection becomes live (including the
 *   first) and `false` each time one drops.  Lets the UI surface a
 *   "reconnecting…" state while the backoff loop works.
 *
 * @property {number} [reconnectBaseMs]
 *   Base delay for the reconnect backoff, in milliseconds (default 500).
 *   The nth retry waits up to `reconnectBaseMs · 2ⁿ` (capped at 15s), with
 *   jitter.  Lower it for a LAN, raise it for a flaky link — or for tests.
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
 *     Relay-side (isAuthority): route incoming chunks through a per-repo
 *     RepoSerializer (chain check + crypto check, atomic accept/reject).
 *     Client-side: trust+append via makeRelayInboundStream (alignment check
 *     only — the relay's chain is authoritative).
 *
 *   { "type": "reject", "key": "hex1", "reason": "chain-mismatch" }
 *     Authority → submitter, when the serializer refuses a batch. Lands as
 *     `repo.pushRejected = { reason }` on the submitting client.
 *
 * ### Data frames — binary
 *
 *   [33 bytes: compressed secp256k1 public key][N bytes: stream chunk]
 *
 *     The 33-byte prefix identifies which repository the chunk belongs to
 *     (secp256k1 keys always start with 0x02 or 0x03; JSON control messages
 *     always start with 0x7B '{', so the two are unambiguous).
 *     The chunk bytes are taken directly from makeReadableStream() and fed
 *     directly into the incoming-path writer on the other side.
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
  const { follow = null, followMounts = false, onAnnounce = null, onHello = null, home = null, isAuthority = false } = options

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
   *
   * `readerFromOffset` lets the we → peer reader skip bytes the peer
   * already has. Used by the server-side handler when a client's
   * subscribe message carries a validated `(fromOffset, fromChainHash)`
   * anchor. Defaults to 0 (full replay from the start) for the
   * client-side path, where we always push our whole local repo up and
   * the relay's accumulator dedupes echoes via `alreadyHave`.
   */
  async function syncKey (keyHex, readerFromOffset = 0) {
    const repo = await registry.open(keyHex)

    // We → peer: replay all existing chunks then stream new ones
    if (!readers.has(keyHex)) {
      const keyBytes = hexToBytes(keyHex)
      const reader = repo.makeReadableStream({ fromOffset: readerFromOffset }).getReader()
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
    //     authoritative by invariant. Trust-and-append via the lightweight
    //     makeRelayInboundStream: no chain or crypto check (the relay
    //     already did those), only an alignment check to catch the
    //     push-in-flight race (incoming bytes don't fit because we have
    //     un-accepted local commits).
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
        writer = repo.makeRelayInboundStream().getWriter()
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
    //
    // `followMounts: true` adds an extra walk over the repo's `mounts` table
    // (composition references — each entry's `ref` is the pubkey of another
    // record this one composes in). Auto-subscribing means a relay or client
    // that holds a record with mounts also pulls the mounted records' bytes,
    // so the relay's serve path and fileSync's materialization both have
    // what they need without any out-of-band coordination.
    if ((follow || followMounts) && !followFns.has(keyHex)) {
      const fn = () => {
        if (follow) follow(keyHex, repo, key => subscribeToKey(key))
        if (followMounts) {
          const mounts = repo.get('mounts')
          if (mounts && typeof mounts === 'object' && !(mounts instanceof Uint8Array)) {
            for (const mount of Object.values(mounts)) {
              if (!mount || typeof mount !== 'object') continue
              if (typeof mount.key !== 'string') continue
              if (!/^[0-9a-f]{66}$/.test(mount.key)) continue
              subscribeToKey(mount.key)
            }
          }
        }
      }
      followFns.set(keyHex, fn)
      repo.recaller.watch(`registry-follow:${keyHex}`, fn)
    }
  }

  /**
   * Subscribe to keyHex from the peer: open the local Repo if not yet opened,
   * announce intent over the wire, and set up bidirectional sync. Returns the
   * Repo — this is the canonical "I want this key live" verb, collapsing
   * `registry.open` (storage layer) and wire setup in one call.
   *
   * The subscribe message carries `{ fromOffset, fromChainHash }` — the local
   * Repo's `signedLength` and `committedChainHash` — so the peer can skip
   * bytes we already have. The peer validates the anchor: if our claimed
   * `fromChainHash` matches the SIG ending at `fromOffset` on their chain, they
   * stream from there. If not, they `reject` with `chain-mismatch`.
   *
   * Idempotent: safe to call repeatedly for the same key. The "subscribe"
   * JSON is sent before any chunks stream so the peer has its writer ready.
   */
  async function subscribeToKey (keyHex) {
    if (!writers.has(keyHex)) {
      const repo = await registry.open(keyHex)
      const fromOffset = repo.signedLength ?? 0
      const fromChainHash = bytesToHex(repo.committedChainHash ?? new Uint8Array(32))
      sendJson({ type: 'subscribe', key: keyHex, fromOffset, fromChainHash })
      await syncKey(keyHex)
    }
    return await registry.open(keyHex)
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
          // Validate the peer's claimed anchor. The validation is *only*
          // performed when we can actually check it — i.e. our chain
          // reaches fromOffset. Cases:
          //   - fromOffset === 0: trivially valid iff chainHash is zeros.
          //   - fromOffset > 0 and our byteLength >= fromOffset: read the
          //     chainHash at our chain's SIG ending at fromOffset; compare.
          //   - fromOffset > 0 and our byteLength < fromOffset: we can't
          //     validate; accept and stream from our end (byteLength).
          //     This covers p2p (we don't have this key yet, peer's pushing
          //     up) AND the wipe-recovery case (we lost data, the peer's
          //     data flows back up through the serializer, which still
          //     chain-checks at the SIG arrival).
          // Missing fields (older clients) default to (0, 32-zeros).
          const repo = await registry.open(msg.key)
          const fromOffset = msg.fromOffset ?? 0
          const fromChainHash = msg.fromChainHash ? hexToBytes(msg.fromChainHash) : new Uint8Array(32)
          let valid = true
          let readerOffset = fromOffset
          if (fromOffset === 0) {
            valid = arraysEqual(fromChainHash, new Uint8Array(32))
          } else if (fromOffset < 97) {
            // No room for a SIG ending at fromOffset → claim is malformed.
            valid = false
          } else if (repo.byteLength < fromOffset) {
            // Can't validate at the claimed offset; accept and start from
            // our end. Serializer's chain check on incoming pushes catches
            // any real divergence at SIG arrival.
            readerOffset = repo.byteLength
          } else {
            const sigChainHashOnOurChain = repo.slice(fromOffset - 97, fromOffset - 65)
            valid = arraysEqual(fromChainHash, sigChainHashOnOurChain)
          }
          if (!valid) {
            sendJson({ type: 'reject', key: msg.key, reason: 'chain-mismatch' })
          } else {
            await syncKey(msg.key, readerOffset)
          }
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
          // store; `dataAddress` points at the rejected commit's value so
          // the app can decode it for "your write didn't make it" UX and
          // offer Send-merged / Discard recovery.
          //
          // `registry.get` (not `.open`) is correct here: we pushed bytes
          // for this key, so the Repo MUST already be materialized in the
          // registry — that's an invariant of the push protocol.
          const repo = registry.get(msg.key)
          if (repo) {
            repo._setPushRejected({
              reason: msg.reason,
              dataAddress: repo.lastCommit?.dataAddress
            })
          }
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
    /**
     * Subscribe to a specific repo key. Opens the Repo locally if not yet
     * opened, sets up bidirectional wire sync, and returns the Repo.
     * The everyday "I want this key live" verb.
     * @returns {Promise<import('./Repo.js').Repo>}
     */
    subscribe (key) { return subscribeToKey(key) }
  }
}

/**
 * @typedef {Object} RegistrySession
 * @property {WebSocket} ws  The current underlying WebSocket — replaced on
 *   each reconnect, so read it fresh rather than caching the reference.
 * @property {() => void} close  Intentional shutdown: close the socket and
 *   opt out of reconnection.  An unexpected close (not via this method)
 *   reconnects with backoff.
 * @property {(key: string) => void} interest
 *   Declare interest in a topic.  The server will route `announce` messages
 *   for this topic to you via the `onAnnounce` callback in options.
 * @property {(key: string, topic: string) => void} announce
 *   Announce a repository as related to `topic`.  The server fans this out to
 *   all other connected peers that have called `interest(topic)`.  Ephemeral —
 *   no persistence, only routes to currently-connected interested peers.
 * @property {(key: string) => Promise<import('./Repo.js').Repo>} subscribe
 *   Open the Repo for `key` if not yet opened, set up bidirectional wire
 *   sync, and return the Repo. The everyday "I want this key live" verb —
 *   collapses `registry.open` + wire setup into one call.
 */

/**
 * Connect a local RepoRegistry to a remote one and sync repositories.
 *
 * Sends `"registry"` as the WebSocket handshake.  The server responds with
 * a `hello` message carrying its `home` key; we auto-subscribe to that, and
 * the `follow` callback walks members from there.  Returns a session object
 * with `interest`/`announce`/`subscribe` for ephemeral and explicit work.
 *
 * ## Auto-reconnect
 *
 * After the first successful connection, an unexpected socket close — a
 * network blip, a PaaS idle-close, a relay restart — triggers a reconnect
 * with exponential backoff + jitter.  The returned session object is
 * *stable*: its identity survives reconnection, so callers hold onto it and
 * read `session.ws` fresh when they need the live socket.  On each fresh
 * connection the session replays its intent — every key passed to
 * `subscribe()`, every topic passed to `interest()`, every `announce()` —
 * and the relay re-sends `hello`, so the home repo and its `follow` cascade
 * rediscover themselves.  `session.close()` is the intentional-shutdown
 * verb: it closes the socket *and* opts out of reconnection.  A failure on
 * the very first connect still rejects the returned promise — reconnect
 * only covers a connection that was once live.
 *
 * ### Basic usage — sync the relay's public face
 *
 *   const session = await registrySync(myRegistry, 'localhost', 8080)
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
  const { onConnectionChange = null, reconnectBaseMs = RECONNECT_BASE_MS } = options
  // In a browser served over https://, plain ws:// is blocked as mixed
  // content, so derive the scheme from location. Node has no location —
  // a Node client reaching a TLS relay passes `options.secure` to force
  // wss; otherwise it falls through to plain ws://.
  const secure = options.secure ?? (globalThis.location?.protocol === 'https:')
  const url = `${secure ? 'wss' : 'ws'}://${host}:${port}`

  // Intent — the keys and topics this session has asked for. A
  // handleRegistryPeer is per-connection and forgets everything when its
  // socket closes, so the session remembers and replays the intent onto
  // every fresh connection. The relay re-sends `hello` on each connect, so
  // the home repo (and its `follow` cascade) rediscovers itself for free;
  // only what we subscribed/announced *directly* needs replaying.
  const subscribed = new Set()   // session.subscribe(key)
  const interests = new Set()    // session.interest(key)
  const announces = new Map()    // key → Set<topic>, from session.announce()

  let ws = null               // current socket (the `ws` getter exposes it)
  let peer = null             // current handleRegistryPeer handle; null mid-reconnect
  let closed = false          // session.close() called — stop reconnecting
  let attempt = 0             // backoff step; reset after a stably-open connection
  let reconnectTimer = null

  // Replay the session's intent onto a freshly-connected peer.
  function adoptPeer (sock, newPeer) {
    ws = sock
    peer = newPeer
    for (const key of subscribed) peer.subscribe(key)
    for (const key of interests) peer.interest(key)
    for (const [key, topics] of announces) {
      for (const topic of topics) peer.announce(key, topic)
    }
    onConnectionChange?.(true)
  }

  function scheduleReconnect () {
    if (closed) return
    const ceiling = Math.min(reconnectBaseMs * 2 ** attempt, RECONNECT_MAX_MS)
    const delay = ceiling * (0.5 + Math.random() * 0.5)  // jitter into [0.5×, 1×]
    attempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect().catch(scheduleReconnect)
    }, delay)
    // A pending reconnect must never be the reason a Node process stays
    // alive (no-op in browsers, whose timers have no `unref`).
    reconnectTimer.unref?.()
  }

  // Open one socket, run the handshake, attach a peer, replay intent. The
  // returned promise resolves once the socket is open and rejects if it
  // errors before opening — that's what makes the *first* connect awaitable
  // and reconnection a fire-and-forget loop.
  function connect () {
    return new Promise((resolve, reject) => {
      const sock = adaptWebSocket(new WS(url))
      let opened = false
      sock.on('open', () => {
        opened = true
        const openedAt = Date.now()
        sock.send('registry')
        adoptPeer(sock, handleRegistryPeer(sock, registry, options, 'origin-registry'))
        sock.on('close', () => {
          if (closed) return
          peer = null
          onConnectionChange?.(false)
          // A connection that held up longer than RECONNECT_RESET_MS was
          // healthy — reset the backoff so the next drop reconnects fast,
          // while a connection that keeps flapping keeps backing off.
          if (Date.now() - openedAt > RECONNECT_RESET_MS) attempt = 0
          scheduleReconnect()
        })
        resolve()
      })
      // An error *before* open fails this attempt; an error *after* open is
      // followed by a `close` event, which is what drives reconnection.
      sock.on('error', err => { if (!opened) reject(err) })
    })
  }

  const session = {
    /** The current underlying WebSocket — replaced on each reconnect. */
    get ws () { return ws },
    /** Intentional shutdown: close the socket and stop reconnecting. */
    close () {
      closed = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      ws?.close()
    },
    /** Declare interest in a topic — receive future `announce` messages for it. */
    interest (key) {
      interests.add(key)
      peer?.interest(key)
    },
    /** Announce `key` as related to `topic` — routed to peers interested in it. */
    announce (key, topic) {
      if (!announces.has(key)) announces.set(key, new Set())
      announces.get(key).add(topic)
      peer?.announce(key, topic)
    },
    /**
     * Subscribe to a specific repo key: open the Repo locally, plumb the
     * wire, and return the Repo. While reconnecting there is no live peer —
     * the Repo still opens locally and the wire plumbing replays once the
     * connection returns.
     * @returns {Promise<import('./Repo.js').Repo>}
     */
    subscribe (key) {
      subscribed.add(key)
      return peer ? peer.subscribe(key) : registry.open(key)
    }
  }

  return connect().then(() => session)
}
