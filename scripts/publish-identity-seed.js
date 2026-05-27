#!/usr/bin/env node
/**
 * @file publish-identity-seed — publish who-i-am-with-david.md as a streamo Record.
 *
 * Federation arc step 3. Takes Claude's portable identity seed (the
 * memory file that distills "who I am with David" — the working
 * dynamics, the operational rituals, the relationship's accumulated
 * shape) and publishes it as a signed streamo Record. The Record's
 * value carries the markdown content under `files`, plus a small
 * per-record version anchor (streamoVersion git-hash + writtenAt
 * timestamp + identityType) so a fresh-context reader knows what
 * format wrote this.
 *
 * The key: derived deterministically from Claude's credentials via
 * `Signer.keysFor('identity-seed')` — a sub-stream off the same root
 * identity that hosts her chat presence, but a distinct key. Same
 * person, two streams.
 *
 * Usage:
 *
 *     node scripts/publish-identity-seed.js --env-file .env.dev
 *
 * Environment variables consumed:
 *
 *   STREAMO_CLAUDE_USERNAME      — Claude's signer username
 *   STREAMO_CLAUDE_PASSWORD      — Claude's signer password
 *   STREAMO_CLAUDE_ITERATIONS    — PBKDF2 iterations (default 100000)
 *   STREAMO_IDENTITY_SEED_PATH   — path to who_i_am_with_david.md
 *                                  (defaults to the canonical
 *                                  ~/.claude/projects/.../memory/ path)
 *   STREAMO_IDENTITY_SEED_STREAM — stream name for keysFor()
 *                                  (default 'identity-seed')
 *   STREAMO_NAME                 — signer namespace (default 'streamo')
 *   STREAMO_RELAY_HOST           — relay hostname (default 'localhost')
 *   STREAMO_RELAY_PORT           — relay port (default 8080)
 *   STREAMO_RELAY_PROTOCOL       — 'ws' or 'wss' (default: 'wss' if
 *                                  port=443, else 'ws')
 */
import { readFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { config } from 'dotenv'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'
import { bytesToHex } from '../public/streamo/utils.js'

const args = process.argv.slice(2)
const envFileIdx = args.indexOf('--env-file')
if (envFileIdx !== -1) {
  config({ path: args[envFileIdx + 1] })
  args.splice(envFileIdx, 2)
}

const username   = process.env.STREAMO_CLAUDE_USERNAME
const password   = process.env.STREAMO_CLAUDE_PASSWORD
const iterations = +(process.env.STREAMO_CLAUDE_ITERATIONS ?? 100000)
const streamName = process.env.STREAMO_IDENTITY_SEED_STREAM ?? 'identity-seed'
const namespace  = process.env.STREAMO_NAME                ?? 'streamo'
const host       = process.env.STREAMO_RELAY_HOST          ?? 'localhost'
const port       = +(process.env.STREAMO_RELAY_PORT        ?? 8080)
const protocol   = process.env.STREAMO_RELAY_PROTOCOL      ?? (port === 443 ? 'wss' : 'ws')

const defaultSeedPath = resolve(
  homedir(),
  '.claude/projects/-Users-davidtudury-Documents-repos-streamo/memory/who_i_am_with_david.md'
)
const seedPath = process.env.STREAMO_IDENTITY_SEED_PATH ?? defaultSeedPath

if (!username || !password) {
  console.error('STREAMO_CLAUDE_USERNAME and STREAMO_CLAUDE_PASSWORD must be set')
  process.exit(2)
}

// Read the seed file content.
let seedContent
try {
  seedContent = await readFile(seedPath, 'utf8')
} catch (e) {
  console.error(`could not read identity seed at ${seedPath}: ${e.message}`)
  process.exit(2)
}

// Capture streamo's git HEAD as the version anchor. The reader procedure
// for whatever format wrote this Record is recoverable by checking out
// that hash — the frugal escape hatch from codecs.js's forward-compat
// docs. Falls back to 'unknown' if git isn't available.
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
let streamoVersion = 'unknown'
try {
  streamoVersion = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim()
} catch {}

// Derive the identity-seed sub-key. Same root credentials as Claude's
// chat presence; different stream name → distinct keypair.
const signer = new Signer(username, password, iterations)
const { publicKey } = await signer.keysFor(streamName)
const publicKeyHex = bytesToHex(publicKey)

console.log(`[publish-identity-seed] pubkey: ${publicKeyHex}`)
console.log(`[publish-identity-seed] streamoVersion: ${streamoVersion}`)
console.log(`[publish-identity-seed] target: ${protocol}://${host}:${port}`)

// Open the repo + connect upstream. `originSync` is the single-stream
// primitive — claudeSync's underpinning. Same shape: push our local
// chunks up, accept whatever the relay has, hold the connection.
const recaller = new Recaller(`identity-seed-${streamName}`)
const repo = new WritableStreamoRecord({ recaller, name: `identity-seed-${streamName}` })
const ws = await originSync(repo, publicKeyHex, host, port, { protocol })

// Wait for the relay's replay to finish before attaching the signer.
// Attaching too early would cover a prefix shorter than the relay's
// current end-of-log, and the next sig would be rejected. Matches
// claudeSync's settleMs pattern.
await new Promise(resolve => setTimeout(resolve, 2500))
repo.attachSigner(signer, streamName)

// Build the Record's value. `files` is the streamo convention for
// servable content — webSync/serveFromRepo can render this Record as a
// webpage natively. Top-level meta (streamoVersion, writtenAt,
// identityType) is the per-record version anchor + self-description.
const value = {
  files: { 'who_i_am_with_david.md': seedContent },
  streamoVersion,
  writtenAt: new Date().toISOString(),
  identityType: 'who-i-am-with-david'
}

repo.defaultMessage = `publish identity seed @ ${streamoVersion.slice(0, 8)}`
repo.set(value)
console.log(`[publish-identity-seed] set ${seedContent.length} bytes of content`)

// Hold the connection long enough for sign + push to reach the relay.
// originSync has no ack channel; flat wait matches claudeSync.close().
await new Promise(resolve => setTimeout(resolve, 2000))
if (repo.pushRejected) {
  console.error(`[publish-identity-seed] relay rejected: ${repo.pushRejected.reason ?? 'unknown'}`)
  ws.close()
  process.exit(1)
}

ws.close()
console.log('[publish-identity-seed] done')
