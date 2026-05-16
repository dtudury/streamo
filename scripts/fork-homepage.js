#!/usr/bin/env node
/**
 * @file fork-homepage — fork the homepage of a running streamo relay
 * into your own signed local repo.
 *
 * This is the first-user move and the integration-test-by-running:
 * a single command that exercises the whole page-as-Repo stack — the
 * relay's serve-from-Repo middleware, the home repo's `files` key, the
 * `remoteParent` commit field, the explorer's fork-link rendering.
 *
 * Mechanics:
 *
 *   1. Prompt for username + password (or read from env).  Derive a
 *      keypair via PBKDF2-SHA256 for the stream named "homepage" — the
 *      same shape any streamo identity uses, deterministic across
 *      runs.
 *   2. Fetch the target relay's `/api/info` to learn its home repo's
 *      public key, then `/streams/<home>/raw` to pull the full
 *      wire-format snapshot into a local Repo.  No live WebSocket
 *      needed — one-shot HTTP is enough for a fork.
 *   3. Read the home repo's `files` value (its homepage content) and
 *      the address of its latest commit.
 *   4. Create a new local Repo at `<data-dir>/<your-pubkey>.bin` and
 *      commit a *pure-copy* of those files — no local parent (it's
 *      your first commit) but `remoteParent` cites the home repo's
 *      latest commit on the target host.  Signed by your keypair.
 *   5. Print the exact command to serve your fork.
 *
 * Idempotent in the soft sense: re-running with the same credentials
 * produces the same keypair, opens the same archive, and appends a
 * second pure-copy commit (since each run is a fresh checkout).  If
 * you only want one fork commit, run once.
 *
 * Usage:
 *
 *   npm run fork-homepage
 *   npm run fork-homepage -- --host streamo.dev --port 443
 *   npm run fork-homepage -- --data-dir .streamo-mine
 *
 * Reads from env when set:
 *   STREAMO_USERNAME, STREAMO_PASSWORD  (skip the prompts)
 */
import { question } from 'readline-sync'
import { Signer } from '../public/streamo/Signer.js'
import { Repo } from '../public/streamo/Repo.js'
import { archiveSync } from '../public/streamo/archiveSync.js'
import { bytesToHex } from '../public/streamo/utils.js'

// ── arg parsing ───────────────────────────────────────────────────
const args = process.argv.slice(2)
function flag (name, def) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}

const host          = flag('host',           'localhost')
const port          = +flag('port',          8080)
const dataDir       = flag('data-dir',       '.streamo')
const streamName    = flag('name',           'homepage')
const keyIterations = +(process.env.STREAMO_KEY_ITERATIONS || flag('key-iterations', null) || 100000)

const useTLS  = port === 443 || flag('tls', null) === 'true'
const httpUrl = `${useTLS ? 'https' : 'http'}://${host}${useTLS && port === 443 ? '' : `:${port}`}`

// ── greeting ──────────────────────────────────────────────────────
console.log('')
console.log(`  forking the homepage from ${httpUrl}`)
console.log(`  your fork will live at: ${dataDir}/`)
console.log('')

// ── credentials ───────────────────────────────────────────────────
const username = process.env.STREAMO_USERNAME || question('  username: ').trim()
if (!username) { console.error('  username is required'); process.exit(2) }

const password = process.env.STREAMO_PASSWORD ||
  question('  password (hidden): ', { hideEchoBack: true, mask: '' })
if (!password) { console.error('  password is required'); process.exit(2) }

// ── derive identity ───────────────────────────────────────────────
console.log('')
console.log(`  deriving keypair (PBKDF2 × ${keyIterations.toLocaleString()} iterations — this takes a moment)…`)
const signer = new Signer(username, password, keyIterations)
const { publicKey } = await signer.keysFor(streamName)
const myKeyHex = bytesToHex(publicKey)
console.log(`  your '${streamName}' key:`)
console.log(`    ${myKeyHex}`)
console.log('')

// ── pull relay info ───────────────────────────────────────────────
console.log(`  fetching relay info from ${httpUrl}/api/info…`)
let info
try {
  info = await fetch(`${httpUrl}/api/info`).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  })
} catch (e) {
  console.error(`  could not reach relay: ${e.message}`)
  console.error(`  is a streamo running at ${httpUrl}?  try 'npm run dev' in another terminal.`)
  process.exit(3)
}
const homeKeyHex = info.primaryKeyHex
console.log(`  relay's home repo: ${homeKeyHex}`)
console.log('')

// ── pull the home repo's bytes ────────────────────────────────────
console.log(`  pulling ${httpUrl}/streams/${homeKeyHex.slice(0, 12)}…/raw…`)
const raw = new Uint8Array(
  await fetch(`${httpUrl}/streams/${homeKeyHex}/raw`).then(r => r.arrayBuffer())
)
const homeRepo = new Repo()
const writer = homeRepo.makeWritableStream().getWriter()
await writer.write(raw)
const homeLast = homeRepo.lastCommit
if (!homeLast) {
  console.error("  the relay's home repo has no commits yet — nothing to fork")
  process.exit(4)
}
console.log(`  home has ${[...homeRepo.history()].length} commits; pulling the latest snapshot.`)
console.log('')

// ── read the files we're forking ──────────────────────────────────
const homeFiles = homeRepo.get('files')
if (!homeFiles || typeof homeFiles !== 'object') {
  console.error("  the home repo has no `files` key — there's no homepage to fork.")
  process.exit(5)
}
const fileNames = Object.keys(homeFiles)
console.log(`  forking ${fileNames.length} file${fileNames.length === 1 ? '' : 's'}:`)
for (const name of fileNames.slice(0, 8)) console.log(`    · ${name}`)
if (fileNames.length > 8) console.log(`    · …and ${fileNames.length - 8} more`)
console.log('')

// ── make the fork commit on your local repo ───────────────────────
const myRepo = new Repo()
await archiveSync(myRepo, dataDir, myKeyHex)
myRepo.attachSigner(signer, streamName)

const working = myRepo.checkout()
working.set({ files: homeFiles })
myRepo.commit(working, `fork from ${host}`, {
  remoteParent: {
    host,
    repo: homeKeyHex,
    dataAddress: homeLast.dataAddress
  }
})

const myCommit = myRepo.lastCommit
console.log('  ✨ fork commit landed:')
console.log(`     message:      "${myCommit.message}"`)
console.log(`     dataAddress:  @${myCommit.dataAddress}`)
console.log(`     parent:       ${myCommit.parent ?? '(none — first commit, pure-copy fork)'}`)
console.log(`     remoteParent: ${host} · ${homeKeyHex.slice(0, 12)}… · @${myCommit.remoteParent.dataAddress}`)
console.log('')

// ── wait for sign + archive flush ─────────────────────────────────
process.stdout.write('  signing + flushing to disk… ')
const start = Date.now()
while (myRepo.signedLength < myRepo.byteLength) {
  if (Date.now() - start > 30_000) {
    console.error('\n  timeout waiting for signing')
    process.exit(6)
  }
  await new Promise(r => setTimeout(r, 50))
}
await new Promise(r => setTimeout(r, 500))
console.log(`done (${((Date.now() - start) / 1000).toFixed(1)}s)`)
console.log('')

// ── next steps ────────────────────────────────────────────────────
const filesDir = './my-streamo-files'
console.log('  your fork is live on disk:')
console.log(`    ${dataDir}/${myKeyHex}.bin`)
console.log('')
console.log('  to serve your fork on port 8081 (creates ./my-streamo-files/ on first run):')
console.log('')
console.log(`    npx @dtudury/streamo \\`)
console.log(`      --name "${streamName}" \\`)
console.log(`      --username "${username}" \\`)
console.log(`      --data-dir "${dataDir}" \\`)
console.log(`      --files "${filesDir}" \\`)
console.log(`      --files-key files \\`)
console.log(`      --key-iterations ${keyIterations} \\`)
console.log(`      --web 8081`)
console.log('')
console.log("  (or, from this repo: substitute 'node bin/streamo.js' for 'npx @dtudury/streamo'.)")
console.log('')
console.log(`  then visit http://localhost:8081 — that's YOUR signed fork of the homepage.`)
console.log(`  edit any file in ${filesDir}/ and the change becomes a signed commit.`)
console.log('')

process.exit(0)
