import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import express from 'express'
import { attachStreamSync } from './outletSync.js'
import { serveFromRepo, serveFromRegistry } from './repoFileServer.js'

/**
 * Start an HTTP + WebSocket server that exposes a StreamoRecordRegistry to browsers
 * and other peers.
 *
 * HTTP endpoints:
 *   GET /                         → 200 JSON: current value of the home streamo for this host
 *   GET /streams/:key             → 200 JSON: current value of streamo `key`
 *   GET /streams/:key/raw         → 200 application/octet-stream: full wire-format archive
 *
 * WebSocket (same port, upgraded from HTTP):
 *   Uses the same handshake + full-duplex wire protocol as outletSync, so any
 *   originSync client can connect here directly.
 *
 * **Host-aware routing** (federation arc step 2): when `hostMap` is set,
 * HTTP read routes resolve their "home" Record per-request by checking the
 * Host header against the map. So one server can serve foo.example.com from
 * Record A and bar.example.com from Record B. Unmapped hosts fall through to
 * `primaryKeyHex`. Writable routes (`POST /api/file`) stay primary-keyed —
 * those are *"write to MY repo,"* not *"write to whoever's domain is in
 * Host."* WS handshake is also primary-keyed for now (per-connection
 * host-awareness needs an upgrade-event hook — follow-up).
 *
 * @param {import('./StreamoRecordRegistry.js').StreamoRecordRegistry} registry
 * @param {string} primaryKeyHex   public key of the "main" streamo — the
 *   server's own primary, used as fallback when no host in hostMap matches
 * @param {number} port
 * @param {string} [name]
 * @param {number} [keyIterations]
 * @param {{
 *   serveRepoFiles?: { repo: any, [opt: string]: any },
 *   routes?: (app: import('express').Express) => void,
 *   hostMap?: Record<string, string>,
 *   home?: string,
 *   isAuthority?: boolean,
 *   [other: string]: any
 * }} [peerOptions]
 *   `serveRepoFiles`: optional config to serve a homepage StreamoRecord's
 *   files via serveFromRepo: `{ repo, ...serveOpts }`. When set, the
 *   middleware serves any path present in the StreamoRecord (via files
 *   + mounts); misses fall through to the legacy /streams/<key>/<path>
 *   routes and then 404. There is no static-file fallback — every URL
 *   on a webSync server resolves through Record + mount chain.
 *   `routes`: optional hook to register extra HTTP routes — called
 *   after the JSON body parser is in place. Lets an embedding server
 *   (e.g. the chat relay's Web Push endpoints) add routes without
 *   webSync knowing about them; webSync stays a generic relay server.
 *   `hostMap`: `{ 'foo.example.com': 'aabbcc...', ... }` — maps Host
 *   header (hostname only; port stripped) to the home Record's keyhex.
 *   When set, HTTP read routes resolve per-host; unmapped hosts use
 *   `primaryKeyHex`. Records in the map must be present in the
 *   registry (we materialize them eagerly at server start so the
 *   per-host serveFromRepo middlewares can be built).
 * @returns {Promise<import('http').Server>}
 */
export async function webSync (registry, primaryKeyHex, port, name, keyIterations = 100000, peerOptions = {}) {
  const app = express()

  const { serveRepoFiles, routes, hostMap = {}, ...peerOpts } = peerOptions

  // Strip port from Host header; "streamo.dev:8443" → "streamo.dev".
  // Empty/missing host falls through to primary via `??`.
  function hostnameOf (req) {
    return req.get('host')?.split(':')[0]
  }

  // Resolve the home Record's keyhex for THIS request. Falls back to the
  // server's primary when no hostMap entry matches.
  function resolveHomeKey (req) {
    return hostMap[hostnameOf(req)] ?? primaryKeyHex
  }

  if (serveRepoFiles && serveRepoFiles.repo) {
    const { repo: primaryRepo, ...serveOpts } = serveRepoFiles

    // Build a serveFromRepo middleware per mapped host, plus one for the
    // primary fallback. Materialize each host's Record eagerly so the
    // middleware is ready before requests start landing — the alternative
    // (lazy materialize on first request) adds latency to the first hit
    // and complicates the dispatcher.
    const hostMiddlewares = {}
    for (const [host, keyHex] of Object.entries(hostMap)) {
      const hostRepo = await registry._materialize(keyHex)
      hostMiddlewares[host] = serveFromRepo(hostRepo, {
        registry,
        pubkeyHex: keyHex,
        ...serveOpts
      })
    }
    const primaryMiddleware = serveFromRepo(primaryRepo, {
      registry,
      pubkeyHex: primaryKeyHex,
      ...serveOpts
    })

    // Dispatcher: pick the host-specific middleware if Host matches the
    // map; otherwise serve from the primary. Per-host middlewares are
    // already configured with the right repo + pubkeyHex, so mount
    // resolution and ETag generation stay correct per-host.
    app.use((req, res, next) => {
      const mw = hostMiddlewares[hostnameOf(req)] ?? primaryMiddleware
      mw(req, res, next)
    })
  }

  // Multi-home file serving: any repo the registry holds is addressable at
  // /streams/<keyhex>/<path>. Mounted as a prefix so Express strips it from
  // req.url before serveFromRegistry / serveFromRepo run. The middleware
  // skips the bare `/streams/<keyhex>` (→ JSON view) and `/streams/<keyhex>/raw`
  // (→ raw-bytes endpoint) so the legacy routes below keep working.
  app.use('/streams/:keyhex', serveFromRegistry(registry))

  // No static-file fallback. Every URL is served by a signed Record (via
  // serveRepoFiles above, or /streams/<key>/<path> below) or 404s. This is
  // the 9.x architectural commitment: "no server holds authority" applies
  // at the request path itself — there is no fallback for bytes the Record
  // doesn't declare.

  app.use(express.json())

  // Embedding-server hook: register extra routes (the chat relay uses this
  // for its Web Push endpoints). webSync itself stays push-agnostic.
  routes?.(app)

  // Expose the home key for THIS host so the browser app knows which
  // streamo to open. Host-aware via hostMap; falls back to primaryKeyHex
  // for unmapped hosts. Field name stays `primaryKeyHex` for caller
  // compatibility — the value is "the primary for the host you're on."
  app.get('/api/info', (req, res) => {
    res.json({ primaryKeyHex: resolveHomeKey(req), name, keyIterations })
  })

  // Write a single file to the primary streamo's latest commit
  app.post('/api/file', async (req, res) => {
    try {
      const { path, content, message } = req.body
      if (typeof path !== 'string' || typeof content !== 'string') {
        return res.status(400).json({ error: 'path and content must be strings' })
      }
      // The primary repo is Writable in author-mode servers (see
      // StreamoServer.create's factory). Relay-only servers don't expose
      // this endpoint via a route guard upstream, so the cast is safe.
      const repo = /** @type {import('./WritableStreamoRecord.js').WritableStreamoRecord} */ (await registry._materialize(primaryKeyHex))
      const working = repo.checkout()
      // Store JSON files as parsed objects so they round-trip cleanly with fileSync
      let value = content
      if (path.endsWith('.json')) {
        try { value = JSON.parse(content) } catch {}
      }
      working.set(path, value)
      repo.commit(working, message || `edit ${path}`)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Current value of the home streamo for this host as JSON.
  app.get('/', async (req, res) => {
    try {
      const streamo = await registry._materialize(resolveHomeKey(req))
      res.json(streamo.byteLength > 0 ? streamo.get() : null)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Current value of any streamo as JSON
  app.get('/streams/:key', async (req, res) => {
    try {
      const streamo = await registry._materialize(req.params.key)
      res.json(streamo.byteLength > 0 ? streamo.get() : null)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Full wire-format snapshot of a streamo's current chunks (finite — does not
  // stream future appends). Used by browsers to bootstrap before WebSocket sync
  // so both sides share the same address space.
  app.get('/streams/:key/raw', async (req, res) => {
    try {
      const streamo = await registry._materialize(req.params.key)
      res.set('Content-Type', 'application/octet-stream')
      const target = streamo.byteLength  // snapshot length; stop here
      if (target === 0) { res.end(); return }
      const reader = streamo.makeReadableStream().getReader()
      res.on('close', () => reader.cancel().catch(() => {}))
      let contentSent = 0
      const pump = async () => {
        if (contentSent >= target) { reader.cancel().catch(() => {}); res.end(); return }
        const { value, done } = await reader.read()
        if (done || !res.writable) { res.end(); return }
        // Each frame is a BATCH of [4-byte LE length][chunk] segments —
        // makeReadableStream packs many chunks per frame (8.4). Sum every
        // segment's declared length so contentSent tracks the whole batch,
        // not just its first chunk; otherwise it under-counts, never reaches
        // target, and the pump awaits an append that never comes.
        for (let off = 0; off + 4 <= value.length;) {
          const len = (value[off]) | (value[off + 1] << 8) | (value[off + 2] << 16) | (value[off + 3] << 24)
          contentSent += len
          off += 4 + len
        }
        res.write(Buffer.from(value))
        pump()
      }
      pump()
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  const server = createServer(app)

  // The relay announces its public face — `primaryKeyHex` is the "home" repo
  // any browser/client connecting here can bootstrap from. See registrySync.js
  // protocol docs for the `hello` message shape.
  attachStreamSync(new WebSocketServer({ server }), registry, 'web', { ...peerOpts, home: primaryKeyHex })

  await new Promise((resolve, reject) => {
    server.listen(port, err => err ? reject(err) : resolve())
  })

  return server
}
