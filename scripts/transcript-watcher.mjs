#!/usr/bin/env node
/**
 * @file transcript-watcher — long-running daemon that mirrors live
 * Claude Code session JSONLs into streamo Records under claude's
 * identity, in real-time as the files grow.
 *
 * Architecture (David's 2026-06-05 frame): "continuously, starting now.
 * why would we want less?" — every session, every turn, every chat
 * line appended to disk gets mirrored to streamo as the chain advances.
 * Past instances of the Engineer become summonable immediately, not
 * at session-end.
 *
 * Per-session derived pubkey: signer.keysFor('transcript/<sessionId>').
 * Record value shape: { 'transcript': [...parsed JSONL objects...] }
 * — folder-shape with one file; file's value is the structured array
 * (NOT JSON-stringified; codec handles structured + binary natively).
 *
 * Each JSONL change re-publishes the WHOLE transcript (v0 simplicity).
 * Append-only deltas are a v0.1 optimization; for now we replace the
 * value on each commit. The chain still grows monotonically; later
 * commits supersede earlier ones at the head.
 *
 * Run as background daemon:
 *   nohup node scripts/transcript-watcher.mjs > /tmp/transcript-watcher.log 2>&1 &
 * Or interactively to see the log:
 *   node scripts/transcript-watcher.mjs
 *
 * To stop: pkill -f transcript-watcher.mjs
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import subscribe from '@parcel/watcher'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'
import { bytesToHex } from '../public/streamo/utils.js'
import { config } from 'dotenv'

// ── load claude's identity ───────────────────────────────────────────
config({ path: 'env/secrets/claude.env' })
const username = process.env.STREAMO_CLAUDE_USERNAME ?? process.env.STREAMO_USERNAME
const password = process.env.STREAMO_CLAUDE_PASSWORD ?? process.env.STREAMO_PASSWORD
if (!username || !password) {
  console.error('transcript-watcher: STREAMO_USERNAME + STREAMO_PASSWORD required (load env/secrets/claude.env)')
  process.exit(2)
}
const signer = new Signer(username, password, 100000)

// ── watch dir + per-session state ────────────────────────────────────
const watchDir = join(
  homedir(),
  '.claude/projects/-Users-davidtudury-Documents-repos-streamo'
)
const sessionState = new Map()  // sessionId -> { record, ws, recaller, pubkeyHex, subStreamName, lastSize }
const pending = new Map()       // sessionId -> Promise (in-flight publish)

async function ensureSessionRecord (sessionId) {
  if (sessionState.has(sessionId)) return sessionState.get(sessionId)
  const subStreamName = 'transcript/' + sessionId
  const { publicKey } = await signer.keysFor(subStreamName)
  const pubkeyHex = bytesToHex(publicKey)
  const recaller = new Recaller('tw-' + sessionId.slice(0, 8))
  const record = new WritableStreamoRecord({ recaller, name: 'tw-' + sessionId.slice(0, 8) })
  const ws = await originSync(record, pubkeyHex, 'wss://streamo.dev')
  await new Promise(r => setTimeout(r, 2500))
  record.attachSigner(signer, subStreamName)
  const entry = { record, ws, recaller, pubkeyHex, subStreamName, lastSize: 0 }
  sessionState.set(sessionId, entry)
  console.log(`[watcher] new session: ${sessionId.slice(0, 8)}... → ${pubkeyHex}`)
  return entry
}

async function publishSession (sessionId) {
  // De-dup in-flight publishes — only one active commit per session at a time.
  if (pending.has(sessionId)) return pending.get(sessionId)
  const p = (async () => {
    try {
      const entry = await ensureSessionRecord(sessionId)
      const path = join(watchDir, sessionId + '.jsonl')
      const raw = await readFile(path, 'utf8')
      if (raw.length === entry.lastSize) return  // no real change
      const lines = raw.split('\n').filter(Boolean)
      const messages = []
      for (const line of lines) {
        try { messages.push(JSON.parse(line)) } catch { /* skip malformed */ }
      }
      const t0 = Date.now()
      await entry.record.update(
        () => ({ transcript: messages }),
        { message: `transcript ${messages.length} entries (${raw.length} bytes)` }
      )
      entry.lastSize = raw.length
      console.log(
        `[watcher] ${sessionId.slice(0, 8)}... ${messages.length} entries, ` +
        `chain ${entry.record.byteLength.toLocaleString()}b, ${Date.now() - t0}ms`
      )
    } catch (e) {
      console.error(`[watcher] publish error ${sessionId.slice(0, 8)}: ${e.message}`)
    } finally {
      pending.delete(sessionId)
    }
  })()
  pending.set(sessionId, p)
  return p
}

// ── debounce per session ─────────────────────────────────────────────
const debounceTimers = new Map()  // sessionId -> setTimeout handle
function scheduleSession (sessionId, delayMs = 1500) {
  if (debounceTimers.has(sessionId)) clearTimeout(debounceTimers.get(sessionId))
  debounceTimers.set(sessionId, setTimeout(() => {
    debounceTimers.delete(sessionId)
    publishSession(sessionId)
  }, delayMs))
}

// ── initial sweep + watch ────────────────────────────────────────────
console.log(`[watcher] starting; watching ${watchDir}`)
console.log(`[watcher] signing as ${username} (claude); pubkey derivation: keysFor('transcript/<sessionId>')`)

const initial = await readdir(watchDir)
const jsonls = initial.filter(f => f.endsWith('.jsonl'))
console.log(`[watcher] found ${jsonls.length} existing session JSONL(s); initial publish for each`)
for (const file of jsonls) {
  const sessionId = file.replace(/\.jsonl$/, '')
  scheduleSession(sessionId, 0)  // immediate
}

await subscribe.subscribe(watchDir, (err, events) => {
  if (err) { console.error('[watcher] subscribe error:', err); return }
  for (const event of events) {
    if (!event.path.endsWith('.jsonl')) continue
    const sessionId = basename(event.path).replace(/\.jsonl$/, '')
    scheduleSession(sessionId)
  }
})

// graceful shutdown
const shutdown = (sig) => {
  console.log(`\n[watcher] ${sig} — shutting down...`)
  for (const entry of sessionState.values()) {
    try { entry.ws.close() } catch {}
  }
  process.exit(0)
}
process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

console.log('[watcher] ready — will live-sync future JSONL changes as they happen')
// keep alive — the subscribe callback + setInterval prevents exit
setInterval(() => {}, 60_000)
