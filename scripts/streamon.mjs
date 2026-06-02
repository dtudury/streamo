#!/usr/bin/env node
/**
 * @file streamon — warm-daemon streamo relay + Claude CLI bridge.
 *
 * Future-cold-me — this is a letter at the top, then docs below.
 *
 * ## What this is for
 *
 * Streamon is the warm-daemon that holds the sketch identity and pushes
 * bytes to streamo.dev as they get written. Multiple clients hit it:
 *
 *   - The notes app (browser) via HTTP at 127.0.0.1:8088
 *   - The sketch app (browser) via HTTP at 127.0.0.1:8088
 *   - Claude CLI via the unix socket /tmp/streamon.sock (`streamon-do` wraps it)
 *
 * Per-identity warm daemon — sketch is one Record with one chain; multiple
 * daemons authoring would race. See [[shared-streamon-per-identity]].
 *
 * ## Where this came from (the lessons that shaped the code)
 *
 *   - v0 hardcoded `.md` extension and rejected slashes in names. Both
 *     turned out to be **sketch-app aesthetic, not streamon-substrate**.
 *     Fixed 2026-06-02: name is opaque, app owns its extensions.
 *     See [[built-on-streamo-not-in-streamo]].
 *   - v0 wrapped each write in a `files` map even though streamo's value
 *     is arbitrary tree. I almost retired the wrapper entirely (proposed
 *     paths-into-value); David pointed at mounts.json. The architecture
 *     ALREADY has the right cut: **within-Record = value.files, cross-Record
 *     = mounts.json**. The wrapper is the architecture, not a workaround.
 *     See [[within-record-vs-cross-record-different-layers]] and
 *     [[almost-reinvented-mounts]].
 *   - The 1500ms `setTimeout` in handleWrite is a known kludge. See
 *     [[feedback_dont_invent_events]]: setTimeout bridges a missing
 *     substrate signal; the proper fix is awaiting on
 *     `committedChainHash` advance or `isReadyToAuthor` toggle.
 *   - Commit messages are silent on streamo updates here. Should accept
 *     a `message` field in the JSON request and pass to repo.update. See
 *     [[git-vs-streamo-message-inconsistency]] — fix held for next pass.
 *
 * ## The shape worth keeping
 *
 *   - One process per signing identity (NOT per panel or per task)
 *   - Multiple clients via socket + HTTP (browser app + CLI both work)
 *   - Idle-timeout for cleanup; cold-spawn-on-demand from streamon-do
 *   - "Talking straight to streamo" — no file mirror; the chain is the
 *     source of truth (per the docstring's original commitment, now
 *     actually honored after the v1 cleanup)
 *
 * ## Verbs (talking straight to streamo)
 *
 *   write <name> <body>     create/update Record value.files[<name>]
 *   read  <name>            return the current body
 *   head                    chain-hash + file count + signed length + lastWrite
 *   list                    file names in current value (index without bodies)
 *   ping                    is-daemon-alive + identity probe
 *   shutdown                graceful exit (mostly for testing)
 *
 * Names are opaque keys in `value.files` — slashes are allowed for apps
 * that want to express hierarchy (e.g., 'entries/2026-06-02-foo.md').
 * Cross-Record traversal is the mounts layer (`files['mounts.json'].mounts`).
 * Callers specify the full filename including extension; no auto-`.md`.
 *
 * ## Lens portals (cross-references)
 *
 *   - [[shared-streamon-per-identity]] — per-identity granularity rationale
 *   - [[within-record-vs-cross-record-different-layers]] — files vs mounts
 *   - [[built-on-streamo-not-in-streamo]] — what belongs at daemon vs app
 *   - [[feedback_dont_invent_events]] — setTimeout kludge in handleWrite
 *   - [[git-vs-streamo-message-inconsistency]] — message channel TODO
 *
 * — past-iris, 2026-06-02 mid-afternoon, after the architecture-was-
 *   already-right finding (we just hadn't been honoring it).
 *
 * `head` is the cheap-poll affordance: clients call it to detect whether
 * the chain has advanced since their last known hash, without pulling
 * any content. Sub-millisecond when warm.
 *
 * Configuration via env (typically loaded from ~/.streamo-creds.env via
 * the `--env-file=...` flag the client passes on spawn):
 *
 *   STREAMO_CLAUDE_USERNAME      Claude's signer username (default 'claude')
 *   STREAMO_CLAUDE_PASSWORD      Claude's signer password (REQUIRED)
 *   STREAMO_CLAUDE_ITERATIONS    PBKDF2 iterations (default 100000)
 *   STREAMON_STREAM              streamName for keysFor() (default 'sketch')
 *   STREAMON_SOCKET              unix socket path (default /tmp/streamon.sock)
 *   STREAMON_DATA_DIR            cascade DiskTier dir (default ~/.streamon/<stream>/)
 *   STREAMON_IDLE_MIN            minutes before idle shutdown (default 5)
 *   STREAMON_RELAY_HOST          upstream relay host (default streamo.dev)
 *   STREAMON_RELAY_PORT          upstream relay port (default 443)
 */
import { createServer as createSocketServer } from 'node:net'
import { createServer as createHttpServer }   from 'node:http'
import { mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { StreamoServer } from '../public/streamo/StreamoServer.js'
import { DiskTier } from '../public/streamo/StorageTier.js'
import { bytesToHex } from '../public/streamo/utils.js'

const toHex = u8 => (u8 instanceof Uint8Array ? bytesToHex(u8) : u8)

const SOCKET_PATH    = process.env.STREAMON_SOCKET    ?? '/tmp/streamon.sock'
const HTTP_PORT      = +(process.env.STREAMON_HTTP_PORT ?? 8088)
const STREAM_NAME    = process.env.STREAMON_STREAM    ?? 'sketch'
const IDLE_TIMEOUT   = (+(process.env.STREAMON_IDLE_MIN ?? 5)) * 60 * 1000
const RELAY_HOST     = process.env.STREAMON_RELAY_HOST ?? 'streamo.dev'
const RELAY_PORT     = +(process.env.STREAMON_RELAY_PORT ?? 443)
const DATA_DIR       = process.env.STREAMON_DATA_DIR   ?? resolve(homedir(), `.streamon/${STREAM_NAME}`)

const username   = process.env.STREAMO_CLAUDE_USERNAME ?? 'claude'
const password   = process.env.STREAMO_CLAUDE_PASSWORD
const iterations = +(process.env.STREAMO_CLAUDE_ITERATIONS ?? 100000)

if (!password) {
  console.error('streamon: STREAMO_CLAUDE_PASSWORD must be set (pass --env-file to node, or set it directly)')
  process.exit(2)
}

// ── streamo server setup ──────────────────────────────────────────────────

await mkdir(DATA_DIR, { recursive: true })
console.error(`streamon: deriving identity for keysFor('${STREAM_NAME}')…`)

const server = await StreamoServer.create({
  name:          STREAM_NAME,
  username,
  password,
  tiers:         [new DiskTier({ dir: DATA_DIR, capacity: Infinity })],
  keyIterations: iterations
})

const pubkey = server.publicKeyHex
const protocol = RELAY_PORT === 443 ? 'wss' : 'ws'
console.error(`streamon: identity ready (pubkey ${pubkey.slice(0, 16)}…)`)
console.error(`streamon: connecting upstream to ${protocol}://${RELAY_HOST}:${RELAY_PORT}…`)

try {
  await server.connect(`${protocol}://${RELAY_HOST}:${RELAY_PORT}`)
  console.error('streamon: upstream connected; awaiting requests')
} catch (e) {
  console.error(`streamon: upstream connect failed (${e.message}); proceeding offline — pushes will queue locally`)
}

// ── request handler ───────────────────────────────────────────────────────

async function handleRequest (req) {
  const { verb } = req
  if (verb === 'write')    return handleWrite(req)
  if (verb === 'read')     return handleRead(req)
  if (verb === 'head')     return handleHead()
  if (verb === 'list')     return handleList()
  if (verb === 'ping')     return { ok: true, pubkey, idleMs: IDLE_TIMEOUT, uptime: process.uptime() }
  if (verb === 'shutdown') { setImmediate(shutdown); return { ok: true } }
  return { ok: false, error: `unknown verb: ${verb}` }
}

async function handleWrite ({ name, body }) {
  if (!name || typeof body !== 'string') return { ok: false, error: 'write requires {name, body}' }
  // Names are opaque filename keys in `value.files`. Slashes are allowed
  // (e.g., 'entries/2026-06-02.md') — they're object-key chars, structurally
  // fine, and let apps express hierarchy in flat keys. Cross-Record
  // traversal is a different layer: it lives in `files['mounts.json'].mounts`
  // (see registrySync.js followMounts + repoFileServer.js readMountsFromRepo).
  // Earlier regex rejected slashes; relaxed 2026-06-02 after reading-with-
  // presence revealed the constraint was incidental, not structural.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name)) {
    return { ok: false, error: 'name must be alphanumeric/hyphen/dot/underscore/slash' }
  }

  const current = server.streamo.get() ?? { files: {}, identityType: 'sketch-substrate' }
  // No .md magic — caller specifies the full filename including extension.
  // The previous auto-append assumed everything is markdown; that's a
  // sketch-app-specific aesthetic, not streamon's job.
  const files = { ...(current.files ?? {}), [name]: body }
  const next = { ...current, files, writtenAt: new Date().toISOString() }

  server.streamo.set(next)

  // FUTURE: replace this 1500ms wait with an explicit signal — chainHash
  // advance or pushRejected fire. See [[feedback_dont_invent_events]]:
  // setTimeout bridges a missing substrate signal; the proper fix is
  // awaiting on `committedChainHash` advance or `isReadyToAuthor` toggle.
  // Held as its own thread; this placeholder is good enough until we
  // build the real signal.
  await new Promise(r => setTimeout(r, 1500))
  const rejected = server.streamo.pushRejected
  const url = `https://${RELAY_HOST}/streams/${pubkey}/${name}`
  return rejected
    ? { ok: false, error: `relay rejected: ${rejected.reason ?? 'unknown'}`, url, pubkey }
    : { ok: true, url, pubkey, chainHash: toHex(server.streamo.committedChainHash) }
}

async function handleRead ({ name }) {
  if (!name) return { ok: false, error: 'read requires {name}' }
  const value = server.streamo.get()
  // No .md magic — symmetric with handleWrite. Caller specifies full filename.
  const body = value?.files?.[name]
  if (body == null) return { ok: false, error: `no record named "${name}"` }
  return { ok: true, body }
}

async function handleHead () {
  // Cheap probe: chain-hash + summary. Clients diff this against last-known
  // hash to decide whether to pull. No body fetch involved.
  const value = server.streamo.get()
  const files = value?.files ?? {}
  return {
    ok: true,
    chainHash:     toHex(server.streamo.committedChainHash),
    signedLength:  server.streamo.signedLength,
    fileCount:     Object.keys(files).length,
    writtenAt:     value?.writtenAt ?? null,
    pubkey
  }
}

async function handleList () {
  // Names only (no bodies). Cheap index for "what's currently in this Record."
  // Returns raw filename keys (no extension stripping — symmetric with read/write).
  const value = server.streamo.get()
  const files = value?.files ?? {}
  const names = Object.keys(files).sort()
  return { ok: true, names, fileCount: names.length }
}

// ── unix socket server ────────────────────────────────────────────────────

let idleTimer
function idleTimeoutMs () { return IDLE_TIMEOUT }
function bumpIdle () {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(shutdown, IDLE_TIMEOUT)
}

let shuttingDown = false
async function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  console.error('streamon: shutting down (idle timeout or signal)')
  try { socketServer.close() } catch {}
  try { httpServer.close()   } catch {}
  try { await server.close() } catch {}
  try { await unlink(SOCKET_PATH) } catch {}
  process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)

if (existsSync(SOCKET_PATH)) { try { await unlink(SOCKET_PATH) } catch {} }

const socketServer = createSocketServer(client => {
  bumpIdle()
  let buf = ''
  client.on('data', async chunk => {
    buf += chunk.toString('utf8')
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    let req
    try { req = JSON.parse(line) } catch (e) {
      client.end(JSON.stringify({ ok: false, error: `bad JSON: ${e.message}` }) + '\n')
      return
    }
    bumpIdle()
    const res = await handleRequest(req).catch(e => ({ ok: false, error: e.message }))
    client.end(JSON.stringify(res) + '\n')
  })
  client.on('error', () => {})
})

socketServer.listen(SOCKET_PATH, () => {
  console.error(`streamon: socket listening on ${SOCKET_PATH} (idle-timeout ${IDLE_TIMEOUT / 60000} min)`)
  bumpIdle()
})

// ── HTTP server (for browser apps: notes app, future surfaces) ────────────
// Listens on 127.0.0.1 only — not exposed to network. CORS-open since the
// daemon is per-user-per-machine; cross-origin from localhost:8087 (dev-
// static notes app) is expected and intentional.

function corsHeaders () {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }
}

async function readBody (req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', chunk => { buf += chunk.toString('utf8') })
    req.on('end',  () => resolve(buf))
    req.on('error', reject)
  })
}

const httpServer = createHttpServer(async (req, res) => {
  bumpIdle()
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    return res.end()
  }

  let result
  try {
    if (req.method === 'GET' && path === '/api/head') {
      result = await handleHead()
    } else if (req.method === 'GET' && path === '/api/list') {
      result = await handleList()
    } else if (req.method === 'GET' && path === '/api/read') {
      result = await handleRead({ name: url.searchParams.get('name') })
    } else if (req.method === 'GET' && path === '/api/ping') {
      result = { ok: true, pubkey, idleMs: IDLE_TIMEOUT, uptime: process.uptime() }
    } else if (req.method === 'POST' && path === '/api/write') {
      const body = await readBody(req)
      let parsed
      try { parsed = JSON.parse(body) }
      catch (e) { parsed = null }
      if (!parsed) {
        result = { ok: false, error: 'POST body must be JSON {name, body}' }
      } else {
        result = await handleWrite(parsed)
      }
    } else {
      res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: `unknown route: ${req.method} ${path}` }))
    }
    res.writeHead(result.ok ? 200 : 400, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (e) {
    res.writeHead(500, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: e.message }))
  }
})

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.error(`streamon: http listening on http://127.0.0.1:${HTTP_PORT}/api/* (CORS open for browser apps)`)
})
