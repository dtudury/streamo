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
 *   1. Generate the library password at cryptopotamus.com:
 *        input: streamo.dev,streamo-library,32,,,
 *   2. Save the 32-char output to a file (e.g., /tmp/lib-pw).
 *   3. Run:  node scripts/publish-library.mjs /tmp/lib-pw
 *   4. Watch it sync. Ctrl-C to stop.
 *   5. The password file is unlinked on exit (clean or signal).
 *
 * Env (rarely overridden):
 *
 *   PUBLISH_LIBRARY_RELAY    upstream relay host (default streamo.dev)
 *
 * Why a watcher rather than one-shot:
 *
 * fileSync IS a watcher — it picks up local edits and pushes them. So this
 * script can stay running while we iterate streamo internals; bytes flow
 * automatically. Same warm-daemon pattern as streamon, just for a different
 * identity. The pattern: long-running daemons per signing identity, each
 * mirroring a directory or holding a substrate connection. See
 * [[shared-streamon-per-identity]] — right granularity is per-identity, not
 * per-task.
 */
import { readFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const [,, passwordFilePath] = process.argv
if (!passwordFilePath) {
  console.error('usage: node scripts/publish-library.mjs <password-file>')
  console.error('  generate the password at cryptopotamus.com with input:')
  console.error('  streamo.dev,streamo-library,32,,,')
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const streamoBin = join(repoRoot, 'bin', 'streamo.js')
const filesDir = join(repoRoot, 'public', 'streamo')

const password = (await readFile(passwordFilePath, 'utf8')).trim()
if (password.length !== 32) {
  console.error(`publish-library: password file should contain exactly 32 chars, got ${password.length}`)
  process.exit(2)
}

const RELAY_HOST = process.env.PUBLISH_LIBRARY_RELAY ?? 'streamo.dev'

const prefix = '\x1b[1;35m[streamo-library]\x1b[0m'
console.log(`${prefix} spawning bin/streamo.js → ${RELAY_HOST}`)
console.log(`${prefix} mirroring ${filesDir}`)
console.log(`${prefix} (Ctrl-C to stop)\n`)

const child = spawn(process.execPath, [
  streamoBin,
  '--username', 'streamo-library',
  '--password', password,
  '--name',     'streamo-library',
  '--files',    filesDir,
  '--feed',     `wss://${RELAY_HOST}`
], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe']
})

// Mirror child's stdout/stderr with a prefix so log story stays readable.
function forwardLines (stream, out) {
  const rl = readline.createInterface({ input: stream, terminal: false })
  rl.on('line', line => out.write(`${prefix} ${line}\n`))
}
forwardLines(child.stdout, process.stdout)
forwardLines(child.stderr, process.stderr)

let cleaning = false
async function cleanup (signal) {
  if (cleaning) return
  cleaning = true
  console.log(`\n${prefix} cleaning up (${signal ?? 'exit'})`)
  try { child.kill('SIGINT') } catch {}
  try { await unlink(passwordFilePath) } catch {}
  setTimeout(() => process.exit(0), 1500).unref?.()
}

process.on('SIGINT',  () => cleanup('SIGINT'))
process.on('SIGTERM', () => cleanup('SIGTERM'))
child.on('exit', (code, signal) => {
  console.log(`${prefix} child exited (code=${code} signal=${signal})`)
  cleanup('child-exit').catch(() => {})
})
