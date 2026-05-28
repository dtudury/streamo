#!/usr/bin/env node
/**
 * @file promote-bundled-apps — stand up each bundled app as its own
 * signed Record on streamo.dev, then add mount entries to the homepage
 * Record's streamo.json.
 *
 * Each app under `public/apps/` becomes a FolderRecord signed by a
 * per-app identity (`streamo-<name>`). The homepage Record then mounts
 * them at `/apps/<name>/`. After this script and the next deploy, app
 * paths are served entirely via signed Records — completing the 9.x
 * architectural commitment ("every URL is a signed Record's content or
 * a 404") for /apps/*. Phase D of the 9.x arc.
 *
 * Usage:
 *
 *   node scripts/promote-bundled-apps.js <path-to-passwords-file> [--apps=chat,flashcards,...] [--skip-lines=N]
 *
 * Passwords file shape: one cryptopotamus-derived password per line,
 * in the order the cryptopotamus config listed the identities. By
 * default, the script expects 7-line file where lines 4–7 are the
 * four bundled-app identities (skipping the first 3, which are
 * existing identities documented in memory: streamo-relay, claude,
 * streamo-library).
 *
 * The script:
 *   1. Reads passwords, derives the four pubkeys, prints them
 *   2. For each app: stages files (excluding tests/utils), spawns
 *      `node bin/streamo.js --origin streamo.dev`, waits for the
 *      bytes to land (polls streamo.dev for a probe file), kills
 *   3. Updates public/homepage/streamo.json with the four new mount
 *      entries
 *   4. Deletes the passwords file
 *   5. Prints identity recipes for memory
 */
import { spawn } from 'child_process'
import { readFile, readdir, unlink, mkdir, writeFile, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Signer } from '../public/streamo/Signer.js'
import { bytesToHex } from '../public/streamo/utils.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

// ── arg parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const passwordsFile = args.find(a => !a.startsWith('--'))
if (!passwordsFile) {
  console.error('usage: node scripts/promote-bundled-apps.js <passwords-file> [--apps=a,b,c] [--skip-lines=N]')
  process.exit(1)
}
const appsArg = args.find(a => a.startsWith('--apps='))?.slice('--apps='.length)
const apps = appsArg ? appsArg.split(',') : ['chat', 'flashcards', 'explorer', 'todomvc']
const skipLinesArg = args.find(a => a.startsWith('--skip-lines='))?.slice('--skip-lines='.length)
const SKIP_LINES = skipLinesArg ? +skipLinesArg : 3

const ITERATIONS = 100000
const ORIGIN = 'streamo.dev'

// ── derive pubkeys ─────────────────────────────────────────────────────
const lines = (await readFile(passwordsFile, 'utf8')).split('\n').map(l => l.trim())
const passwords = lines.slice(SKIP_LINES, SKIP_LINES + apps.length).filter(Boolean)
if (passwords.length !== apps.length) {
  console.error(`Expected ${apps.length} passwords starting at line ${SKIP_LINES + 1}, got ${passwords.length}`)
  process.exit(1)
}

console.log('━'.repeat(72))
console.log(`promoting ${apps.length} bundled app(s) to FolderRecords on ${ORIGIN}`)
console.log('━'.repeat(72))
console.log('\nderiving pubkeys (iterations=100000)…')

const identities = []
for (let i = 0; i < apps.length; i++) {
  const app = apps[i]
  const username = `streamo-${app}`
  const password = passwords[i]
  if (password.length !== 32) {
    console.error(`password for ${app} is ${password.length} chars, expected 32`)
    process.exit(1)
  }
  const signer = new Signer(username, password, ITERATIONS)
  const { publicKey } = await signer.keysFor(username)
  const pubkey = bytesToHex(publicKey)
  console.log(`  ${app.padEnd(12)} ${username.padEnd(20)} ${pubkey.slice(0, 16)}…`)
  identities.push({ app, username, password, pubkey })
}

// ── promote each app: stage + push + verify ────────────────────────────
async function promoteApp ({ app, username, password, pubkey }) {
  console.log(`\n━ ${app} ${'━'.repeat(72 - app.length - 4)}`)

  const stagingDir = `/tmp/streamo-promote-${app}`
  const dataDir    = `/tmp/streamo-promote-${app}-data`
  await rm(stagingDir, { recursive: true, force: true })
  await rm(dataDir,    { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  // Stage with rsync — same exclusions as the npm tarball.
  console.log(`  staging public/apps/${app}/ → ${stagingDir}`)
  await new Promise((resolve, reject) => {
    const r = spawn('rsync', [
      '-a',
      '--exclude=*.test.js',
      '--exclude=utils/testing.js',
      '--exclude=utils/mockDOM.js',
      `${join(repoRoot, 'public', 'apps', app)}/`,
      `${stagingDir}/`
    ], { stdio: 'inherit' })
    r.on('exit', code => code === 0 ? resolve() : reject(new Error(`rsync exit ${code}`)))
  })

  // Spawn the streamo CLI as the author for this Record. Password via env
  // so it's not in argv (still in the subprocess's environment, but no
  // hand-typed shell command preserves it). The CLI's startup prompts for
  // a password if STREAMO_PASSWORD isn't set — we set it.
  console.log(`  spawning streamo CLI → --origin ${ORIGIN}`)
  const child = spawn('node', [
    join(repoRoot, 'bin/streamo.js'),
    '--name', username,
    '--username', username,
    '--data-dir', dataDir,
    '--files', stagingDir,
    '--origin', ORIGIN
  ], {
    env: { ...process.env, STREAMO_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  // Wait for origin connection, then poll streamo.dev for a probe file.
  // The "origin: connected" line in the CLI's stdout signals the WS is up;
  // bytes start flowing immediately after. We poll until any one file in
  // the staged dir comes back 200. Picks the first file alphabetically as
  // the probe — robust to apps that don't have an index.html (e.g.,
  // pure-CSS shared records like styles).
  let connected = false
  let stderrBuf = ''
  child.stdout.on('data', d => { process.stdout.write(d); if (d.toString().includes('origin: connected')) connected = true })
  child.stderr.on('data', d => { stderrBuf += d.toString(); process.stderr.write(d) })

  // Find a probe file — walk staged dir, take first regular file.
  const stagedEntries = (await readdir(stagingDir, { withFileTypes: true, recursive: true }))
    .filter(e => e.isFile())
    .map(e => join(e.parentPath || stagingDir, e.name))
  const probeFsPath = stagedEntries[0]
  if (!probeFsPath) throw new Error(`no files in staged dir ${stagingDir}`)
  const probeRel = probeFsPath.slice(stagingDir.length + 1)
  const probeUrl = `https://${ORIGIN}/streams/${pubkey}/${probeRel}`
  console.log(`  polling ${probeUrl} for 200…`)
  const deadline = Date.now() + 60_000
  let pushed = false
  while (Date.now() < deadline) {
    if (connected) {
      const res = await fetch(probeUrl).catch(() => null)
      if (res?.status === 200) {
        const len = res.headers.get('content-length')
        console.log(`  ✓ ${PROBE_FILE} reachable on ${ORIGIN} (${len} bytes)`)
        pushed = true
        break
      }
    }
    await new Promise(r => setTimeout(r, 1000))
  }

  // Give the push a beat to drain any remaining chunks before we kill,
  // so the relay's chain is fully up-to-date for this Record.
  if (pushed) await new Promise(r => setTimeout(r, 2000))
  child.kill('SIGTERM')
  await new Promise(r => child.once('exit', r))

  // Cleanup staging
  await rm(stagingDir, { recursive: true, force: true })
  await rm(dataDir,    { recursive: true, force: true })

  if (!pushed) {
    console.error(`  ✗ ${app}: failed to land within 60s`)
    if (stderrBuf) console.error(`  stderr:\n${stderrBuf}`)
    throw new Error(`push timed out for ${app}`)
  }
}

for (const id of identities) {
  await promoteApp(id)
}

// ── update homepage streamo.json ───────────────────────────────────────
console.log('\n━━━ updating public/homepage/streamo.json ━━━')
const streamoJsonPath = join(repoRoot, 'public', 'homepage', 'streamo.json')
const streamoJson = JSON.parse(await readFile(streamoJsonPath, 'utf8'))
streamoJson.mounts = streamoJson.mounts || {}
for (const { app, pubkey } of identities) {
  streamoJson.mounts[`apps/${app}/`] = { key: pubkey }
}
await writeFile(streamoJsonPath, JSON.stringify(streamoJson, null, 2) + '\n')
console.log(`  added ${identities.length} mount entries`)

// ── delete passwords file ──────────────────────────────────────────────
console.log(`\n━━━ deleting ${passwordsFile} ━━━`)
await unlink(passwordsFile)
console.log('  done')

// ── summary for memory ─────────────────────────────────────────────────
console.log('\n━━━ identity recipes (save these to memory; never the password) ━━━')
for (const { app, username, pubkey } of identities) {
  console.log(`  ${app.padEnd(12)} cryptopotamus: streamo.dev,${username},32,,,`)
  console.log(`               pubkey:        ${pubkey}`)
}
console.log('\n━ done — commit + deploy to apply on prod ━')
