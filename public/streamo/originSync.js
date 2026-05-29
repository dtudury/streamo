import WebSocket from 'ws'

const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 15000

/**
 * Connect to a remote outlet and begin full-duplex sync for `stream`.
 *
 * Sends a handshake (the hex public key), then:
 *   local → remote: replay all chunks, then stream new ones
 *   remote → local: trust+append (the upstream relay is the chain
 *                   authority for this repo's canonical chain)
 *
 * ## First-connect retry
 *
 * By default, a failed first-connect (host not up yet, transient error)
 * triggers an exponential-backoff retry loop until the connection
 * succeeds. The substrate's purpose is "be connected to canonical" —
 * waiting for the upstream to come up matches that purpose, and makes
 * startup order between relays free (a spoke can be launched before
 * its hub; it'll wait patiently). Set `retryFirstConnect: false` for
 * fail-fast behavior (tests, ping-style verbs, programmatic callers
 * needing a definitive "is this reachable?" answer).
 *
 * Note: this only covers FIRST-connect. After-drop reconnect is not
 * implemented here yet — a connection that drops mid-session ends the
 * sync. (See registrySync for the higher-level primitive with both
 * first-connect and after-drop retry.)
 *
 * @param {import('./StreamoRecord.js').StreamoRecord} stream
 * @param {string} publicKeyHex  hex-encoded public key identifying this stream
 * @param {string} host
 * @param {number} port
 * @param {Object} [options]
 * @param {'ws'|'wss'} [options.protocol='ws']
 *   WebSocket protocol. Use `'wss'` when the relay is behind a TLS terminator
 *   (Caddy / nginx / fly.io) and you're connecting cross-host. Local dev
 *   stays `'ws'`.
 * @param {boolean} [options.retryFirstConnect=true]
 *   Retry the first-connect attempt with exponential backoff if it fails.
 * @param {number} [options.retryBaseMs=500]
 *   Base delay for the first-connect retry backoff. Lower it for tests.
 * @returns {Promise<WebSocket>}  resolves when the connection is open and sync has started
 */
export async function originSync (stream, publicKeyHex, host, port, { protocol = 'ws', retryFirstConnect = true, retryBaseMs = RETRY_BASE_MS } = {}) {
  const url = `${protocol}://${host}:${port}`

  async function tryConnect () {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      let opened = false

      ws.on('open', () => {
        opened = true
        attachSync(ws)
        resolve(ws)
      })
      // Error before open fails this attempt (the retry loop will try
      // again if retryFirstConnect is on). Error after open is logged
      // inside attachSync and ends the session.
      ws.on('error', err => { if (!opened) reject(err) })
    })
  }

  if (!retryFirstConnect) return tryConnect()

  let attempt = 0
  while (true) {
    try {
      return await tryConnect()
    } catch (e) {
      const ceiling = Math.min(retryBaseMs * 2 ** attempt, RETRY_MAX_MS)
      const delay = ceiling * (0.5 + Math.random() * 0.5)
      attempt++
      console.error(`[origin] connect to ${url} failed (${e.message}), retrying in ${Math.round(delay)}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  /**
   * Wire up the bidirectional sync on an already-opened WebSocket.
   * Extracted so the retry loop above can recreate the handshake on
   * each fresh attempt without duplicating sync code.
   */
  function attachSync (ws) {
    // Handshake: identify which stream we want to sync
    ws.send(publicKeyHex)

    // Local → remote: replay all chunks, then stream new ones. originSync
    // is the lower-level "keep this Record in sync" primitive — used by
    // author processes (claudeSync, StreamoServer.connect) AND by dumb-
    // pipe relays that intentionally forward bytes they didn't author.
    // No outbound filter here: the relay's accumulator dedups echoes
    // via `alreadyHave`. The "don't re-push received bytes" footgun is
    // addressed at the higher-level `registrySync.subscribe` verb,
    // which gates push on `repo instanceof WritableStreamoRecord`.
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
  }
}
