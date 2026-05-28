#!/usr/bin/env node
/**
 * @file publish-memory — publish Claude's memory corpus as a streamo Record.
 *
 * Federation arc step 6 (v1). Takes the entire `memory/` directory and
 * publishes it as ONE signed Record. The Record's value carries every
 * memory file under `files` (so webSync can serve them natively), plus a
 * top-level meta block (streamoVersion git-hash, writtenAt, identityType).
 *
 * **Deviation from the prior design sketches:** earlier subagent work
 * argued for per-file Records (one Record per memory file, keyed at
 * `keysFor('memory:<stem>')`). For v1, this script publishes a single
 * corpus Record at `keysFor('memory')` — much simpler, much faster to
 * run, mirrors the homepage convention. Per
 * `feedback_start_on_page_2_design_for_revisability`: v1 doesn't have to
 * be the final shape; it has to be cheap to revise. Going per-file in v2
 * is additive — the keys don't collide (`memory:<stem>` ≠ `memory`).
 *
 * Same root credentials as Claude's chat presence; sub-stream `memory` →
 * distinct keypair. Same person, separate stream.
 *
 * Usage:
 *
 *     STREAMO_CLAUDE_USERNAME=claude \
 *     STREAMO_CLAUDE_PASSWORD=<from-cryptopotamus> \
 *     node scripts/publish-memory.js
 *
 * Environment variables:
 *
 *   STREAMO_CLAUDE_USERNAME    — Claude's signer username (default 'claude')
 *   STREAMO_CLAUDE_PASSWORD    — Claude's signer password (REQUIRED)
 *   STREAMO_CLAUDE_ITERATIONS  — PBKDF2 iterations (default 100000)
 *   STREAMO_MEMORY_STREAM      — stream name for keysFor() (default 'memory')
 *   STREAMO_MEMORY_DIR         — path to memory directory (defaults to the
 *                                canonical ~/.claude/projects/.../memory/)
 *   STREAMO_RELAY_HOST         — relay hostname (default 'streamo.dev')
 *   STREAMO_RELAY_PORT         — relay port (default 443)
 *   STREAMO_RELAY_PROTOCOL     — 'ws' or 'wss' (default: 'wss' if port=443)
 */
import { readdir, readFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'
import { bytesToHex } from '../public/streamo/utils.js'

const username   = process.env.STREAMO_CLAUDE_USERNAME ?? 'claude'
const password   = process.env.STREAMO_CLAUDE_PASSWORD
const iterations = +(process.env.STREAMO_CLAUDE_ITERATIONS ?? 100000)
const streamName = process.env.STREAMO_MEMORY_STREAM     ?? 'memory'
const host       = process.env.STREAMO_RELAY_HOST        ?? 'streamo.dev'
const port       = +(process.env.STREAMO_RELAY_PORT      ?? 443)
const protocol   = process.env.STREAMO_RELAY_PROTOCOL    ?? (port === 443 ? 'wss' : 'ws')

const defaultMemoryDir = resolve(
  homedir(),
  '.claude/projects/-Users-davidtudury-Documents-repos-streamo/memory'
)
const memoryDir = process.env.STREAMO_MEMORY_DIR ?? defaultMemoryDir

if (!password) {
  console.error('STREAMO_CLAUDE_PASSWORD must be set (regenerate via cryptopotamus.com — recipe: streamo.dev,claude,32,,,)')
  process.exit(2)
}

// Read all .md files in the memory directory.
const entries = await readdir(memoryDir)
const mdFiles = entries.filter(f => f.endsWith('.md')).sort()
const files = {}
for (const name of mdFiles) {
  files[name] = await readFile(join(memoryDir, name), 'utf8')
}
const totalBytes = Object.values(files).reduce((a, s) => a + s.length, 0)

// Capture streamo's git HEAD as the version anchor.
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
let streamoVersion = 'unknown'
try {
  streamoVersion = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim()
} catch {}

// Derive the memory sub-key.
const signer = new Signer(username, password, iterations)
const { publicKey } = await signer.keysFor(streamName)
const publicKeyHex = bytesToHex(publicKey)

console.log(`[publish-memory] pubkey:         ${publicKeyHex}`)
console.log(`[publish-memory] files:          ${mdFiles.length}`)
console.log(`[publish-memory] total bytes:    ${totalBytes.toLocaleString()}`)
console.log(`[publish-memory] streamoVersion: ${streamoVersion}`)
console.log(`[publish-memory] target:         ${protocol}://${host}:${port}`)

// Open the Record + connect upstream.
const recaller = new Recaller(`publish-memory-${streamName}`)
const repo = new WritableStreamoRecord({ recaller, name: `publish-memory-${streamName}` })
const ws = await originSync(repo, publicKeyHex, host, port, { protocol })

// Wait for the relay's replay to finish before attaching the signer.
await new Promise(r => setTimeout(r, 2500))
repo.attachSigner(signer, streamName)

// Build the Record's value.
const value = {
  files,
  streamoVersion,
  writtenAt: new Date().toISOString(),
  identityType: 'memory-corpus'
}

repo.defaultMessage = `publish memory corpus @ ${streamoVersion.slice(0, 8)} (${mdFiles.length} files, ${totalBytes.toLocaleString()} bytes)`
repo.set(value)
console.log(`[publish-memory] set ${mdFiles.length} files / ${totalBytes.toLocaleString()} bytes`)

// Hold the connection long enough for sign + push to reach the relay.
await new Promise(r => setTimeout(r, 3000))
if (repo.pushRejected) {
  console.error(`[publish-memory] relay rejected: ${repo.pushRejected.reason ?? 'unknown'}`)
  ws.close()
  process.exit(1)
}

ws.close()
console.log(`[publish-memory] done — corpus published at ${publicKeyHex.slice(0, 16)}…`)
console.log(`[publish-memory] verify:    https://${host}/streams/${publicKeyHex}/MEMORY.md`)
