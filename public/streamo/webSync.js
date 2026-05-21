import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { attachStreamSync } from './outletSync.js'
import { serveFromRepo, serveFromRegistry } from './repoFileServer.js'

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Start an HTTP + WebSocket server that exposes a RepoRegistry to browsers
 * and other peers.
 *
 * HTTP endpoints:
 *   GET /                         → 200 JSON: current value of the primary streamo
 *   GET /streams/:key             → 200 JSON: current value of streamo `key`
 *   GET /streams/:key/raw         → 200 application/octet-stream: full wire-format archive
 *
 * WebSocket (same port, upgraded from HTTP):
 *   Uses the same handshake + full-duplex wire protocol as outletSync, so any
 *   originSync client can connect here directly.
 *
 * @param {import('./RepoRegistry.js').RepoRegistry} registry
 * @param {string} primaryKeyHex   public key of the "main" streamo for GET /
 * @param {number} port
 * @param {object} [peerOptions.serveRepoFiles]  optional config to serve a
 *   homepage Repo's files via serveFromRepo: `{ repo, ...serveOpts }`. When
 *   set, the middleware mounts ahead of express.static so any path present
 *   in the Repo wins; misses fall through to disk.
 * @returns {Promise<import('http').Server>}
 */
export async function webSync (registry, primaryKeyHex, port, name, keyIterations = 100000, peerOptions = {}) {
  const app = express()

  const { serveRepoFiles, ...peerOpts } = peerOptions

  if (serveRepoFiles && serveRepoFiles.repo) {
    const { repo, ...serveOpts } = serveRepoFiles
    app.use(serveFromRepo(repo, serveOpts))
  }

  // Multi-home file serving: any repo the registry holds is addressable at
  // /streams/<keyhex>/<path>. Mounted as a prefix so Express strips it from
  // req.url before serveFromRegistry / serveFromRepo run. The middleware
  // skips the bare `/streams/<keyhex>` (→ JSON view) and `/streams/<keyhex>/raw`
  // (→ raw-bytes endpoint) so the legacy routes below keep working.
  app.use('/streams/:keyhex', serveFromRegistry(registry, { filesKey: 'files' }))

  app.use(express.static(publicDir))

  app.use(express.json())

  // Expose primary key so the browser app knows which streamo to open
  app.get('/api/info', (req, res) => {
    res.json({ primaryKeyHex, name, keyIterations })
  })

  // Write a single file to the primary streamo's latest commit
  app.post('/api/file', async (req, res) => {
    try {
      const { path, content, message } = req.body
      if (typeof path !== 'string' || typeof content !== 'string') {
        return res.status(400).json({ error: 'path and content must be strings' })
      }
      const repo = await registry.open(primaryKeyHex)
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

  // Current value of the primary streamo as JSON
  app.get('/', async (req, res) => {
    try {
      const streamo = await registry.open(primaryKeyHex)
      res.json(streamo.byteLength > 0 ? streamo.get() : null)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Current value of any streamo as JSON
  app.get('/streams/:key', async (req, res) => {
    try {
      const streamo = await registry.open(req.params.key)
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
      const streamo = await registry.open(req.params.key)
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
        // wire frame: [4-byte LE length][chunk bytes] — read length to track progress
        contentSent += (value[0]) | (value[1] << 8) | (value[2] << 16) | (value[3] << 24)
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
