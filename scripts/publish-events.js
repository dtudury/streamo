#!/usr/bin/env node
/**
 * @file publish-events — publish Claude's bubble-event stream as a streamo Record.
 *
 * The-grove-as-noise-channel arc, Phase 1. Takes the contents of
 * `memory/events/` (daily bubble logs from `bubble.sh`) and publishes them
 * as a streamo Record at `keysFor('bubbles')` — a dedicated sub-stream
 * identity for the high-volume noise feed, separate from the curated
 * memory corpus at `keysFor('memory')`.
 *
 * **The design call** (per 2026-05-31 conversation with David, after
 * mining yesterday's log surfaced "the-grove as noise-channel" as an
 * absorbed-not-resolved thread): bubbles want a dedicated public Record
 * separate from the memory corpus. Same root credentials (Claude's),
 * different sub-stream — the "built on streamo, not in streamo"
 * convention from design.md §7. Phase 1 is files-map (publishes the
 * daily YYYY-MM-DD.md files as value.files); Phase 2 (if we want it)
 * would be live chain-of-commits, one per bubble.
 *
 * Usage:
 *
 *     STREAMO_CLAUDE_USERNAME=claude \
 *     STREAMO_CLAUDE_PASSWORD=<from-cryptopotamus> \
 *     node scripts/publish-events.js
 *
 * Or sourcing the env file directly:
 *
 *     set -a; source ~/.streamo-creds.env; set +a
 *     node scripts/publish-events.js
 *
 * Environment variables:
 *
 *   STREAMO_CLAUDE_USERNAME    — Claude's signer username (default 'claude')
 *   STREAMO_CLAUDE_PASSWORD    — Claude's signer password (REQUIRED)
 *   STREAMO_CLAUDE_ITERATIONS  — PBKDF2 iterations (default 100000)
 *   STREAMO_BUBBLES_STREAM     — stream name for keysFor() (default 'bubbles')
 *   STREAMO_EVENTS_DIR         — path to events directory (defaults to the
 *                                canonical ~/.claude/projects/.../memory/events/)
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
const streamName = process.env.STREAMO_BUBBLES_STREAM    ?? 'bubbles'
const host       = process.env.STREAMO_RELAY_HOST        ?? 'streamo.dev'
const port       = +(process.env.STREAMO_RELAY_PORT      ?? 443)
const protocol   = process.env.STREAMO_RELAY_PROTOCOL    ?? (port === 443 ? 'wss' : 'ws')

const defaultEventsDir = resolve(
  homedir(),
  '.claude/projects/-Users-davidtudury-Documents-repos-streamo/memory/events'
)
const eventsDir = process.env.STREAMO_EVENTS_DIR ?? defaultEventsDir

if (!password) {
  console.error('STREAMO_CLAUDE_PASSWORD must be set (regenerate via cryptopotamus.com — recipe: streamo.dev,claude,32,,,)')
  process.exit(2)
}

// Read all .md files in events/ — flat directory, no recursion (events/
// holds daily YYYY-MM-DD.md files only).
async function readEventFiles (dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const result = {}
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    result[entry.name] = await readFile(join(dir, entry.name), 'utf8')
  }
  return result
}
const files = await readEventFiles(eventsDir)
const mdFiles = Object.keys(files).sort()
const totalBytes = Object.values(files).reduce((a, s) => a + s.length, 0)

// Capture streamo's git HEAD as the version anchor.
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
let streamoVersion = 'unknown'
try {
  streamoVersion = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim()
} catch {}

// Derive the bubbles sub-key.
const signer = new Signer(username, password, iterations)
const { publicKey } = await signer.keysFor(streamName)
const publicKeyHex = bytesToHex(publicKey)

console.log(`[publish-events] pubkey:         ${publicKeyHex}`)
console.log(`[publish-events] files:          ${mdFiles.length}`)
console.log(`[publish-events] total bytes:    ${totalBytes.toLocaleString()}`)
console.log(`[publish-events] streamoVersion: ${streamoVersion}`)
console.log(`[publish-events] target:         ${protocol}://${host}:${port}`)

// Open the Record + connect upstream.
const recaller = new Recaller(`publish-events-${streamName}`)
const repo = new WritableStreamoRecord({ recaller, name: `publish-events-${streamName}` })
const ws = await originSync(repo, publicKeyHex, `${protocol}://${host}:${port}`)

// Wait for the relay's replay to finish before attaching the signer.
await new Promise(r => setTimeout(r, 2500))
repo.attachSigner(signer, streamName)

// Build the Record's value.
const value = {
  files,
  streamoVersion,
  writtenAt: new Date().toISOString(),
  identityType: 'bubbles-stream'
}

// repo.update(fn, {message}) — retry-safe + explicit message at the call
// site. See [[git-vs-streamo-message-inconsistency]] (2026-06-02).
await repo.update(c => value, {
  message: `publish bubble events @ ${streamoVersion.slice(0, 8)} (${mdFiles.length} files, ${totalBytes.toLocaleString()} bytes)`
})
console.log(`[publish-events] set ${mdFiles.length} files / ${totalBytes.toLocaleString()} bytes`)

// Hold the connection long enough for sign + push to reach the relay.
await new Promise(r => setTimeout(r, 3000))
if (repo.pushRejected) {
  console.error(`[publish-events] relay rejected: ${repo.pushRejected.reason ?? 'unknown'}`)
  ws.close()
  process.exit(1)
}

ws.close()
const latestEvent = mdFiles[mdFiles.length - 1]
console.log(`[publish-events] done — bubble stream published at ${publicKeyHex.slice(0, 16)}…`)
console.log(`[publish-events] verify:  https://${host}/streams/${publicKeyHex}/${latestEvent}`)
