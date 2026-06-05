#!/usr/bin/env node
/**
 * @file snapshot-experiment — measure compression: raw JSONL vs parsed
 * API-shape vs streamo chain bytes after publishing.
 *
 * 2026-06-05 — David wants to see the numbers for storing parsed
 * context (vs wren's earlier raw + parsed-objects comparison at 4MB).
 *
 * Usage:
 *   # current session (Claude Code env CLAUDE_CODE_SESSION_ID)
 *   node scripts/snapshot-experiment.mjs
 *
 *   # specific JSONL file
 *   node scripts/snapshot-experiment.mjs --jsonl <path>
 *
 *   # don't publish, just print sizes
 *   node scripts/snapshot-experiment.mjs --dry-run
 *
 * Publishes to a one-off pubkey derived from a fresh random identity
 * (via the identity verb) so we don't entangle with production
 * Records. Pubkey is printed; can be queried later via
 * `bin/streamo.js --home-key <pubkey> --feed wss://streamo.dev --cat parsed.json`.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { identity } from '../public/streamo/identity.js'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'
import { bytesToHex } from '../public/streamo/utils.js'

const { values } = parseArgs({
  options: {
    jsonl: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }
  }
})

// ── locate the JSONL ────────────────────────────────────────────────
let jsonlPath = values.jsonl
if (!jsonlPath) {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  if (!sessionId) {
    console.error('no --jsonl provided and CLAUDE_CODE_SESSION_ID not in env')
    console.error('usage: node scripts/snapshot-experiment.mjs [--jsonl PATH] [--dry-run]')
    process.exit(2)
  }
  jsonlPath = join(
    homedir(),
    '.claude/projects/-Users-davidtudury-Documents-repos-streamo',
    sessionId + '.jsonl'
  )
}

// ── read raw + parse ────────────────────────────────────────────────
const rawBuf = await readFile(jsonlPath)
const rawBytes = rawBuf.byteLength
const text = new TextDecoder().decode(rawBuf)
const lines = text.split('\n').filter(l => l.length > 0)
const rawObjs = lines.map(l => JSON.parse(l))

// ── transform to API shape (same as ContextRecord.apiMessages) ──────
const filtered = []
for (const m of rawObjs) {
  if (m.isSidechain) continue
  if (m.type !== 'user' && m.type !== 'assistant') continue
  const c = m.message?.content
  const role = m.message?.role
  if (role !== 'user' && role !== 'assistant') continue
  let textContent
  if (typeof c === 'string') textContent = c
  else if (Array.isArray(c)) {
    textContent = c.filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n')
  } else continue
  if (!textContent || !textContent.trim()) continue
  filtered.push({ role, content: textContent })
}
const collapsed = []
for (const m of filtered) {
  const last = collapsed[collapsed.length - 1]
  if (last && last.role === m.role) last.content = last.content + '\n\n' + m.content
  else collapsed.push({ ...m })
}

const parsedJson = JSON.stringify(collapsed, null, 2)
const parsedBytes = Buffer.byteLength(parsedJson, 'utf8')

// ── local size report ───────────────────────────────────────────────
console.log('')
console.log('─── source ───')
console.log(`  ${jsonlPath}`)
console.log(`  raw JSONL bytes:        ${rawBytes.toLocaleString().padStart(15)} (${(rawBytes/1024/1024).toFixed(2)} MB)`)
console.log(`  raw JSONL lines:        ${rawObjs.length.toLocaleString().padStart(15)}`)
console.log('')
console.log('─── transform ───')
console.log(`  after filter+collapse:  ${collapsed.length.toLocaleString().padStart(15)} API messages`)
console.log(`  parsed.json bytes:      ${parsedBytes.toLocaleString().padStart(15)} (${(parsedBytes/1024/1024).toFixed(2)} MB)`)
console.log(`  parsed/raw ratio:       ${(parsedBytes/rawBytes*100).toFixed(1).padStart(15)}%`)
console.log('')

if (values['dry-run']) {
  console.log('─── --dry-run: not publishing ───')
  process.exit(0)
}

// ── publish to a fresh one-off pubkey ───────────────────────────────
const idName = `snapshot-experiment-${Date.now()}`
const { pubkeyHex, password } = await identity.new(idName)
console.log('─── publish ───')
console.log(`  identity:   ${idName}`)
console.log(`  pubkey:     ${pubkeyHex}`)

const signer = new Signer(idName, password, 100000)
const recaller = new Recaller('snapshot')
const record = new WritableStreamoRecord({ recaller, name: 'snapshot' })

console.log(`  connecting to wss://streamo.dev...`)
const ws = await originSync(record, pubkeyHex, 'wss://streamo.dev')
await new Promise(r => setTimeout(r, 2500))
record.attachSigner(signer, idName)

console.log(`  committing ${(parsedBytes/1024/1024).toFixed(2)} MB...`)
const t0 = Date.now()
await record.update(
  () => ({ 'parsed.json': parsedJson }),
  { message: `snapshot ${collapsed.length} parsed messages from ${jsonlPath.split('/').pop()}` }
)
const localCommitMs = Date.now() - t0
const chainBytes = record.byteLength

console.log('')
console.log('─── streamo chain after commit ───')
console.log(`  chain bytes:            ${chainBytes.toLocaleString().padStart(15)} (${(chainBytes/1024/1024).toFixed(2)} MB)`)
console.log(`  chain/parsed ratio:     ${(chainBytes/parsedBytes*100).toFixed(1).padStart(15)}% (streamo overhead vs parsed)`)
console.log(`  chain/raw ratio:        ${(chainBytes/rawBytes*100).toFixed(1).padStart(15)}% (final compression vs raw)`)
console.log(`  local commit time:      ${localCommitMs.toLocaleString().padStart(15)} ms`)
console.log('')

// Wait for push to relay (rough estimate: 1 MB ~ 15s, min 10s)
const pushWaitMs = Math.max(10000, Math.floor(chainBytes / 1024 / 1024 * 15000))
console.log(`  waiting for push to relay (~${(pushWaitMs/1000)|0}s for ${(chainBytes/1024/1024).toFixed(2)} MB)...`)
await new Promise(r => setTimeout(r, pushWaitMs))

if (record.pushRejected) {
  console.error(`  ✖ push rejected: ${record.pushRejected.reason ?? 'unknown'}`)
  ws.close()
  process.exit(1)
}
console.log(`  ✓ push complete (no rejection)`)

console.log('')
console.log('─── verify ───')
console.log(`  node bin/streamo.js --home-key ${pubkeyHex} --feed wss://streamo.dev --cat parsed.json | head -50`)
console.log('')

ws.close()
process.exit(0)
