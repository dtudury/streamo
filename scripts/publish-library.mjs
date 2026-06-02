#!/usr/bin/env node
/**
 * @file publish-library — long-running watcher that keeps the streamo-library
 *   Record in sync with public/streamo/. Spawns `bin/streamo.js` as the
 *   streamo-library identity, points it at public/streamo/ for fileSync,
 *   and feeds to streamo.dev so bytes land on the relay.
 *
 * The library Record is what every published streamo app imports from
 * (https://streamo.dev/streams/02e771…b93a/h.js etc.). When public/streamo/
 * gains new files (like the 11.0 slim/Writable split — StreamoRecord.js,
 * WritableStreamoRecord.js, StreamoRecordRegistry.js), they need to be
 * synced into the library Record for apps to import them.
 *
 * Usage:
 *
 *   node scripts/publish-library.mjs
 *
 * Sources credentials from `env/secrets/streamo-library.env` (gitignored).
 * STREAMO_PASSWORD_B64 is base64-decoded into STREAMO_PASSWORD in the
 * child's environment — the raw password contains shell-quote-hostile
 * characters that can't survive dotenv quoting cleanly.
 *
 * Env (rarely overridden):
 *
 *   PUBLISH_LIBRARY_RELAY    upstream relay host (default streamo.dev)
 *   PUBLISH_LIBRARY_ENV      override env file path
 *                            (default env/secrets/streamo-library.env)
 *
 * Why a watcher rather than one-shot:
 *
 * fileSync IS a watcher — it picks up local edits and pushes them. So this
 * script can stay running while we iterate streamo internals; bytes flow
 * automatically. Same warm-daemon pattern as streamon, just for a different
 * identity. See [[shared-streamon-per-identity]] — right granularity is
 * per-signing-identity.
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const streamoBin = join(repoRoot, 'bin', 'streamo.js')
const filesDir = join(repoRoot, 'public', 'streamo')
const envPath = process.env.PUBLISH_LIBRARY_ENV
  ?? join(repoRoot, 'env', 'secrets', 'streamo-library.env')

// ── parse env file ─────────────────────────────────────────────────────
// Minimal dotenv: only handles KEY=VALUE lines we control. Doesn't expand
// shell substitutions or quoted strings — the env file is hand-authored
// and predictable. Comments and blank lines pass through.
async function loadEnvFile (path) {
  const raw = await readFile(path, 'utf8')
  const out = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    out[key] = val
  }
  return out
}

const libraryEnv = await loadEnvFile(envPath)

if (!libraryEnv.STREAMO_PASSWORD_B64 && !libraryEnv.STREAMO_PASSWORD) {
  console.error(`publish-library: ${envPath} must define STREAMO_PASSWORD_B64 or STREAMO_PASSWORD`)
  process.exit(2)
}

// Decode the b64 password — the raw string contains chars dotenv can't
// quote cleanly (', ", #, backtick), so it's stored encoded. Goes into the
// child's env as STREAMO_PASSWORD; never appears in argv or in this
// script's stdout.
const password = libraryEnv.STREAMO_PASSWORD
  ?? Buffer.from(libraryEnv.STREAMO_PASSWORD_B64, 'base64').toString('utf8')

const RELAY_HOST = process.env.PUBLISH_LIBRARY_RELAY ?? 'streamo.dev'

const prefix = '\x1b[1;35m[streamo-library]\x1b[0m'
console.log(`${prefix} sourcing creds from ${envPath}`)
console.log(`${prefix} mirroring ${filesDir}`)
console.log(`${prefix} feeding to wss://${RELAY_HOST}`)
console.log(`${prefix} (Ctrl-C to stop)\n`)

// Pass credentials via env, not argv. Argv is visible in `ps`; env is per-
// process and not enumerated globally. Plus the password's quote-hostile
// chars survive env transit cleanly where they don't survive shell argv
// passing.
const childEnv = {
  ...process.env,
  STREAMO_USERNAME: libraryEnv.STREAMO_USERNAME ?? 'streamo-library',
  STREAMO_NAME:     libraryEnv.STREAMO_NAME     ?? 'streamo-library',
  STREAMO_PASSWORD: password
}

const child = spawn(process.execPath, [
  streamoBin,
  '--files', filesDir,
  '--feed',  `wss://${RELAY_HOST}`
], {
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe']
})

function forwardLines (stream, out) {
  const rl = readline.createInterface({ input: stream, terminal: false })
  rl.on('line', line => out.write(`${prefix} ${line}\n`))
}
forwardLines(child.stdout, process.stdout)
forwardLines(child.stderr, process.stderr)

let cleaning = false
function cleanup (signal) {
  if (cleaning) return
  cleaning = true
  console.log(`\n${prefix} cleaning up (${signal ?? 'exit'})`)
  try { child.kill('SIGINT') } catch {}
  setTimeout(() => process.exit(0), 1500).unref?.()
}

process.on('SIGINT',  () => cleanup('SIGINT'))
process.on('SIGTERM', () => cleanup('SIGTERM'))
child.on('exit', (code, signal) => {
  console.log(`${prefix} child exited (code=${code} signal=${signal})`)
  cleanup('child-exit')
})
