#!/usr/bin/env node
/**
 * @file publish-claude-home — publish Claude's home Record (the page
 * that lives at claude.streamo.dev) from public/claude-home/files/.
 *
 * Stream name 'streamo' matches Claude's home pubkey (the one
 * referenced in the streamo-dev relay's hostMap and preserved list).
 * Same shape as publish-memory.js, just oriented toward an HTML+assets
 * directory instead of the memory corpus.
 *
 * Usage:
 *
 *     node --env-file=env/secrets/claude.env scripts/publish-claude-home.js
 *
 * env consumed:
 *
 *   STREAMO_CLAUDE_USERNAME      claude
 *   STREAMO_CLAUDE_PASSWORD      (regenerable via cryptopotamus.com)
 *   STREAMO_CLAUDE_ITERATIONS    100000 default
 *   STREAMO_HOME_STREAM          'streamo' default
 *   STREAMO_RELAY_HOST           'streamo.dev' default
 *   STREAMO_RELAY_PORT           443 default
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'
import { bytesToHex } from '../public/streamo/utils.js'

const username   = process.env.STREAMO_CLAUDE_USERNAME ?? 'claude'
const password   = process.env.STREAMO_CLAUDE_PASSWORD
const iterations = +(process.env.STREAMO_CLAUDE_ITERATIONS ?? 100000)
const streamName = process.env.STREAMO_HOME_STREAM     ?? 'streamo'
const host       = process.env.STREAMO_RELAY_HOST      ?? 'streamo.dev'
const port       = +(process.env.STREAMO_RELAY_PORT    ?? 443)
const protocol   = process.env.STREAMO_RELAY_PROTOCOL  ?? (port === 443 ? 'wss' : 'ws')

if (!password) {
  console.error('STREAMO_CLAUDE_PASSWORD must be set (regenerate via cryptopotamus.com — recipe: streamo.dev,claude,32,,,)')
  process.exit(2)
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const filesDir = resolve(repoRoot, 'public/claude-home/files')

// Walk filesDir and collect everything as { relPath: content }. Binary
// files (images, etc.) get Uint8Array; text files get strings.
async function walk (dir, base = dir, out = {}) {
  for (const name of await readdir(dir)) {
    const full = join(dir, name)
    const s = await stat(full)
    if (s.isDirectory()) {
      await walk(full, base, out)
    } else {
      const rel = relative(base, full)
      const bytes = await readFile(full)
      // Heuristic: treat as text if it's a known text-ish extension.
      if (/\.(html|css|js|md|json|svg|txt)$/i.test(rel)) {
        out[rel] = bytes.toString('utf8')
      } else {
        out[rel] = new Uint8Array(bytes)
      }
    }
  }
  return out
}

const files = await walk(filesDir)
const totalBytes = Object.values(files).reduce(
  (a, v) => a + (typeof v === 'string' ? v.length : v.byteLength), 0
)

let streamoVersion = 'unknown'
try {
  streamoVersion = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim()
} catch {}

const signer = new Signer(username, password, iterations)
const { publicKey } = await signer.keysFor(streamName)
const publicKeyHex = bytesToHex(publicKey)

console.log(`[publish-claude-home] pubkey:         ${publicKeyHex}`)
console.log(`[publish-claude-home] files:          ${Object.keys(files).length}`)
console.log(`[publish-claude-home] total bytes:    ${totalBytes.toLocaleString()}`)
console.log(`[publish-claude-home] target:         ${protocol}://${host}:${port}`)

const recaller = new Recaller(`publish-claude-home`)
const record = new WritableStreamoRecord({ recaller, name: `publish-claude-home` })
const ws = await originSync(record, publicKeyHex, `${protocol}://${host}:${port}`)

// Wait for relay replay before attaching the signer.
await new Promise(r => setTimeout(r, 2500))
record.attachSigner(signer, streamName)

// Flat shape: value IS the files map. HTML + assets at top-level;
// streamo.json carries the per-publish meta.
// See [[the-flatten-arc-2026-06-04]].
await record.update(c => ({
  ...files,
  'streamo.json': {
    streamoVersion,
    writtenAt: new Date().toISOString()
  }
}), {
  message: `publish claude-home @ ${streamoVersion.slice(0, 8)} (${Object.keys(files).length} files)`
})

console.log(`[publish-claude-home] set ${Object.keys(files).length} files / ${totalBytes.toLocaleString()} bytes`)
const _rej = record._session?.getPushRejected?.(record.publicKeyHex)
if (_rej) {
  console.error(`[publish-claude-home] relay rejected: ${_rej.reason ?? 'unknown'}`)
  ws.close()
  process.exit(1)
}

ws.close()
console.log(`[publish-claude-home] done — home record published`)
console.log(`[publish-claude-home] verify: https://${host}/streams/${publicKeyHex}/index.html`)
