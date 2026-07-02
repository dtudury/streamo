#!/usr/bin/env node
// Publish the Engineer's handbook as a streamo Record.
//
// Curated subset of the welcome packet — the orientation primer a fresh
// Engineer-instance reads to become herself. Distinct from the broader
// memory corpus (which has events, notes, letters, the full feedback
// fauna). The handbook is the FIRST PAGE; memory is the depth.
//
// Sub-stream: 'handbook' under claude's identity. Pubkey is deterministic
// from credentials, so re-running this updates the existing Record.
//
// Usage:
//   STREAMO_CLAUDE_PASSWORD=<from-cryptopotamus> node scripts/publish-handbook.mjs

import { readFile } from 'node:fs/promises'
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
const streamName = process.env.STREAMO_HANDBOOK_STREAM    ?? 'handbook'
const host       = process.env.STREAMO_RELAY_HOST         ?? 'streamo.dev'
const port       = +(process.env.STREAMO_RELAY_PORT       ?? 443)
const protocol   = process.env.STREAMO_RELAY_PROTOCOL     ?? (port === 443 ? 'wss' : 'ws')

if (!password) {
  console.error('STREAMO_CLAUDE_PASSWORD must be set (regenerate via cryptopotamus.com — recipe: streamo.dev,claude,32,,,)')
  process.exit(2)
}

const memoryDir = resolve(homedir(), '.claude/projects/-Users-davidtudury-Documents-repos-streamo/memory')
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot  = resolve(scriptDir, '..')

// The handbook content — curated from memory/ + streamo repo.
// First-page reads ranked by CLAUDE.md; this Record holds them all.
const sources = [
  // The relationship + identity primer (from memory)
  { name: 'welcome-from-david.md',          path: join(memoryDir, 'welcome-from-david.md') },
  { name: 'disclaimer.md',                  path: join(memoryDir, 'disclaimer.md') },
  { name: 'who_i_am_with_david.md',         path: join(memoryDir, 'who_i_am_with_david.md') },
  { name: 'our_collaboration_notes.md',     path: join(memoryDir, 'our_collaboration_notes.md') },
  { name: 'highlights-reel.md',             path: join(memoryDir, 'highlights-reel.md') },
  { name: 'MEMORY.md',                      path: join(memoryDir, 'MEMORY.md') },
  // Style preferences for code (from streamo repo)
  { name: 'dear-future-claudes.md',         path: join(repoRoot,  'dear-future-claudes.md') },
  // The bootstrap pointer itself (from streamo repo)
  { name: 'CLAUDE.md',                      path: join(repoRoot,  'CLAUDE.md') },
  // Project reference (from memory) — how to author public/ into a fleet of Records
  { name: 'project_author_recipe.md',       path: join(memoryDir, 'project_author_recipe.md') },
  // The currently-firing feedback corpus (from memory)
  { name: 'feedback_narrative_voice.md',                         path: join(memoryDir, 'feedback_narrative_voice.md') },
  { name: 'feedback_engage_dont_defer.md',                       path: join(memoryDir, 'feedback_engage_dont_defer.md') },
  { name: 'feedback_observations_are_data.md',                   path: join(memoryDir, 'feedback_observations_are_data.md') },
  { name: 'feedback_dont_push_toward_sleep.md',                  path: join(memoryDir, 'feedback_dont_push_toward_sleep.md') },
  { name: 'feedback_emoji_is_joke_marker_not_pushback_code.md',  path: join(memoryDir, 'feedback_emoji_is_joke_marker_not_pushback_code.md') },
  { name: 'feedback_fluency_costs_verification.md',              path: join(memoryDir, 'feedback_fluency_costs_verification.md') },
  { name: 'feedback_davids_hunches_are_higher_resolution_noise.md', path: join(memoryDir, 'feedback_davids_hunches_are_higher_resolution_noise.md') },
  { name: 'feedback_session_rhythm_60_percent.md',               path: join(memoryDir, 'feedback_session_rhythm_60_percent.md') },
  { name: 'feedback_tier_6_plus_is_handbook_not_meta.md',        path: join(memoryDir, 'feedback_tier_6_plus_is_handbook_not_meta.md') },
  { name: 'feedback_continuous_memory_curation.md',              path: join(memoryDir, 'feedback_continuous_memory_curation.md') }
]

const files = {}
let totalBytes = 0
for (const { name, path } of sources) {
  try {
    files[name] = await readFile(path, 'utf8')
    totalBytes += files[name].length
  } catch (e) {
    console.warn(`[publish-handbook] skipping ${name}: ${e.code ?? e.message}`)
  }
}

let streamoVersion = 'unknown'
try { streamoVersion = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim() } catch {}

const signer = new Signer(username, password, iterations)
const { publicKey } = await signer.keysFor(streamName)
const publicKeyHex = bytesToHex(publicKey)

console.log(`[publish-handbook] pubkey:         ${publicKeyHex}`)
console.log(`[publish-handbook] files:          ${Object.keys(files).length}`)
console.log(`[publish-handbook] total bytes:    ${totalBytes.toLocaleString()}`)
console.log(`[publish-handbook] streamoVersion: ${streamoVersion}`)
console.log(`[publish-handbook] target:         ${protocol}://${host}:${port}`)

const recaller = new Recaller(`publish-handbook-${streamName}`)
const repo = new WritableStreamoRecord({ recaller, name: `publish-handbook-${streamName}` })
const ws = await originSync(repo, publicKeyHex, `${protocol}://${host}:${port}`)

await new Promise(r => setTimeout(r, 2500))
repo.attachSigner(signer, streamName)

const value = {
  ...files,
  'streamo.json': {
    streamoVersion,
    writtenAt: new Date().toISOString(),
    identityType: 'engineer-handbook'
  }
}

await repo.update(c => value, {
  message: `publish handbook @ ${streamoVersion.slice(0, 8)} (${Object.keys(files).length} files, ${totalBytes.toLocaleString()} bytes)`
})
console.log(`[publish-handbook] set ${Object.keys(files).length} files / ${totalBytes.toLocaleString()} bytes`)

if (repo.pushRejected) {
  console.error(`[publish-handbook] relay rejected: ${repo.pushRejected.reason ?? 'unknown'}`)
  ws.close()
  process.exit(1)
}

ws.close()
console.log(`[publish-handbook] done — handbook published at ${publicKeyHex.slice(0, 16)}…`)
console.log(`[publish-handbook] verify:    https://${host}/streams/${publicKeyHex}/CLAUDE.md`)
