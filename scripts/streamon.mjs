#!/usr/bin/env node
/**
 * @file streamon — warm-daemon streamo relay + Claude CLI bridge (v0).
 *
 * One long-lived process that holds the sketch identity, opens originSync
 * to streamo.dev, and exposes a unix socket for Claude CLI clients
 * (`streamon-do` is the client wrapper). Idle-timeout shuts the daemon
 * down after no requests for STREAMON_IDLE_MIN minutes (default 5);
 * subsequent client calls re-spawn it from cold.
 *
 * Verbs (talking straight to streamo, no file mirror — the chain IS the
 * source of truth; verbs expose precisely-what-you-asked-for queries):
 *
 *   write <name> <body>     create/update Record value.files[<name>.md]
 *   read  <name>            return the current body
 *   head                    chain-hash + file count + signed length + lastWrite
 *   list                    file names in current value (index without bodies)
 *   ping                    is-daemon-alive + identity probe
 *   shutdown                graceful exit (mostly for testing)
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
import { mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { StreamoServer } from '../public/streamo/StreamoServer.js'
import { DiskTier } from '../public/streamo/StorageTier.js'

const SOCKET_PATH    = process.env.STREAMON_SOCKET    ?? '/tmp/streamon.sock'
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
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return { ok: false, error: 'name must be alphanumeric/hyphen' }

  const current = server.streamo.get() ?? { files: {}, identityType: 'sketch-substrate' }
  const files = { ...(current.files ?? {}), [`${name}.md`]: body }
  const next = { ...current, files, writtenAt: new Date().toISOString() }

  server.streamo.set(next)

  // Brief wait for push; check rejection if connected. The chain IS the
  // source of truth — no file mirror. Clients read via the `read` verb.
  await new Promise(r => setTimeout(r, 1500))
  const rejected = server.streamo.pushRejected
  const url = `https://${RELAY_HOST}/streams/${pubkey}/${name}.md`
  return rejected
    ? { ok: false, error: `relay rejected: ${rejected.reason ?? 'unknown'}`, url, pubkey }
    : { ok: true, url, pubkey, chainHash: server.streamo.committedChainHash?.slice(0, 16) }
}

async function handleRead ({ name }) {
  if (!name) return { ok: false, error: 'read requires {name}' }
  const value = server.streamo.get()
  const body = value?.files?.[`${name}.md`]
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
    chainHash:     server.streamo.committedChainHash,
    signedLength:  server.streamo.signedLength,
    fileCount:     Object.keys(files).length,
    writtenAt:     value?.writtenAt ?? null,
    pubkey
  }
}

async function handleList () {
  // Names only (no bodies). Cheap index for "what's currently in this Record."
  const value = server.streamo.get()
  const files = value?.files ?? {}
  const names = Object.keys(files).map(k => k.replace(/\.md$/, '')).sort()
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
  console.error(`streamon: listening on ${SOCKET_PATH} (idle-timeout ${IDLE_TIMEOUT / 60000} min)`)
  bumpIdle()
})
