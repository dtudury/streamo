#!/usr/bin/env node
/**
 * @file fork-homepage — fork the homepage of a running streamo relay
 * into your own signed local repo.
 *
 * Thin shell around `Repo.merge(url, { from: 'files' })`: prompt for
 * credentials, derive a keypair, open the local archive, call merge,
 * print the next-step command.  All the HTTP fetch + pure-copy commit
 * machinery now lives in `Repo.merge` itself.
 *
 * Mechanics:
 *
 *   1. Prompt for username + password (or read from env).  Derive a
 *      keypair via PBKDF2-SHA256 for the stream named "homepage" — the
 *      same shape any streamo identity uses, deterministic across
 *      runs.
 *   2. Open `<data-dir>/<your-pubkey>.bin` via archiveSync, attach
 *      your signer.
 *   3. `await myRepo.merge(httpUrl, { from: 'files' })` — fetches the
 *      relay's home repo via `/streams/<key>/raw`, walks into `files`,
 *      makes a pure-copy commit signed by you with `remoteParent`
 *      cited automatically (URL form auto-fills host + repo).
 *   4. Print the exact CLI command to serve your fork.
 *
 * Idempotent in the soft sense: re-running with the same credentials
 * produces the same keypair, opens the same archive, and appends a
 * second pure-copy commit (since each merge is its own commit).  If
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
 *   STREAMO_KEY_ITERATIONS              (defaults to 100000)
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

// ── open local fork repo ──────────────────────────────────────────
const myRepo = new Repo()
await archiveSync(myRepo, dataDir, myKeyHex)
myRepo.attachSigner(signer, streamName)

// ── merge ─────────────────────────────────────────────────────────
// Repo.merge does the HTTP fetch, snapshot load, pure-copy commit
// with auto-filled remoteParent.  The `from: 'files'` slice means
// we incorporate the relay's homepage content (not its chat/journal
// state) — leaving room for our fork to grow its own siblings.
console.log(`  merging files from ${httpUrl}…`)
try {
  await myRepo.merge(httpUrl, { from: 'files' })
} catch (e) {
  if (/no value at path/.test(e.message)) {
    console.error(`  the relay's home repo has no \`files\` key — there's no homepage to fork.`)
    process.exit(5)
  }
  if (/no commits/.test(e.message)) {
    console.error("  the relay's home repo has no commits yet — nothing to fork.")
    process.exit(4)
  }
  console.error(`  could not merge from ${httpUrl}: ${e.message}`)
  console.error(`  is a streamo running there?  try \`npm run dev\` in another terminal.`)
  process.exit(3)
}

const myCommit = myRepo.lastCommit
const rp = myCommit.remoteParent
const fileNames = Object.keys(myRepo.get('files') ?? {})
console.log('')
console.log(`  ✨ forked ${fileNames.length} file${fileNames.length === 1 ? '' : 's'} from ${rp.host} (${rp.repo.slice(0, 12)}…):`)
for (const name of fileNames.slice(0, 8)) console.log(`    · ${name}`)
if (fileNames.length > 8) console.log(`    · …and ${fileNames.length - 8} more`)
console.log('')
console.log(`  fork commit landed:`)
console.log(`     message:      "${myCommit.message}"`)
console.log(`     dataAddress:  @${myCommit.dataAddress}`)
console.log(`     parent:       ${myCommit.parent ?? '(none — first commit, pure-copy fork)'}`)
console.log(`     remoteParent: ${rp.host} · ${rp.repo.slice(0, 12)}… · @${rp.dataAddress}`)
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
console.log(`      --key-iterations ${keyIterations} \\`)
console.log(`      --web 8081`)
console.log('')
console.log("  (or, from this repo: substitute 'node bin/streamo.js' for 'npx @dtudury/streamo'.)")
console.log('')
console.log(`  then visit http://localhost:8081 — that's YOUR signed fork of the homepage.`)
console.log(`  edit any file in ${filesDir}/ and the change becomes a signed commit.`)
console.log('')

process.exit(0)
