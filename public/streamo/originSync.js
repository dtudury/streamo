import WebSocket from 'ws'
import { parseOrigin } from './utils.js'

const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 15000

/**
 * @file originSync — the low-level "keep this one Record in sync"
 * primitive. Dials a remote outlet, sends the pubkey as handshake, and
 * runs bidirectional sync. Used by author processes (claudeSync,
 * StreamoServer.connect) and by dumb-pipe relays that forward bytes
 * they didn't author. registrySync is the higher-level primitive over
 * the same wire when you want multi-Record federation + after-drop
 * reconnect.
 *
 * No outbound filter on the local→remote half — the remote's accumulator
 * dedups echoes via `alreadyHave`. The "don't re-push received bytes"
 * footgun is addressed at registrySync.subscribe, which gates pushes
 * on `record instanceof WritableStreamoRecord`.
 *
 * First-connect retry is on by default: the substrate's job is
 * "be connected to canonical," so waiting for the host to come up
 * matches that job — a spoke can start before its hub and wait. Set
 * `retryFirstConnect: false` for ping-style verbs and tests that want
 * a definitive "is this reachable?" answer.
 *
 * After-drop reconnect is NOT implemented here — see registrySync.
 */
export async function originSync (record, publicKeyHex, hostPort, { retryFirstConnect = true, retryBaseMs = RETRY_BASE_MS } = {}) {
  const { host, port, protocol } = parseOrigin(hostPort)
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
      // Error BEFORE open fails this attempt (the retry loop will try
      // again). Error AFTER open is logged inside attachSync.
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

  // Extracted so the retry loop can rebuild the handshake on each fresh
  // attempt without duplicating sync code.
  function attachSync (ws) {
    ws.send(publicKeyHex)

    // Mark that a relay is attached so `isReadyToAuthor` gates on
    // `caughtUpToRelay` instead of returning true immediately. Passing
    // null (no session object) is intentional — originSync's protocol
    // has no session-level resync verb, so `WritableStreamoRecord.update`
    // won't retry via `session._resyncRepo` for origin-only records.
    // That's fine; conflicts will surface via `pushRejected` /
    // `conflictDetected` and callers can decide. The important thing:
    // fileSync's startup gate now waits for wire's first SIG (proxy
    // for "we've seen wire's state") before allowing local commits —
    // otherwise the disk-wins branch fires against an empty local,
    // authors a SIG on a fresh chain, and wire's real SIGs land as
    // false-positive alignment-check conflicts.
    if (typeof record._attachSession === 'function' && !record.hasRelay) {
      record._attachSession(null)
    }

    const reader = record.makeReadableStream().getReader()
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

    // Trust+append via makeRelayInboundStream — the upstream IS chain
    // authority. The alignment check still catches push-in-flight races
    // (we wrote locally before the upstream acknowledged our push, and
    // it sends down something else in the meantime).
    const writer = record.makeRelayInboundStream().getWriter()

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
