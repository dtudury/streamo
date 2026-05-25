#!/usr/bin/env node
/**
 * @file demo-three-records — three-record composed website demo setup.
 *
 * Builds the on-disk scaffolding for the demo described in
 * EXPLORATION-three-records.md:
 *
 *   - library Record   — holds public/streamo/* (the streamo lib)
 *   - explorer Record  — holds public/apps/explorer/* (the app)
 *   - homepage Record  — holds a small landing page + a streamo.json
 *                        whose `mounts` table composes the other two
 *                        into one URL hierarchy
 *
 * After this script runs, three terminals run three streamo authors:
 * the homepage one is the relay (--web 8080); the others --origin into
 * it. The relay-side mount resolver composes the three Records into the
 * URL tree served at localhost:8080/.
 *
 *   $ node scripts/demo-three-records.js
 *
 * Then follow the printed three commands.
 *
 * Re-running wipes ../streamo-three-record-demo/ and rebuilds — safe
 * to use as a reset. If you re-run while a CLI terminal still has the
 * demo dir as CWD, that shell's working-directory inode disappears
 * out from under it and subsequent commands die with
 * `ENOENT: no such file or directory, uv_cwd`. Fix: `cd` back into
 * the (newly-recreated) directory to refresh the shell's CWD reference.
 *
 * Why a sibling directory and not ./demo/ inside the repo? Because
 * running `npx @dtudury/streamo ...` inside a directory whose
 * package.json declares "name": "@dtudury/streamo" makes npx treat
 * the local package as already resolved, skip the install, and try
 * to run `streamo` from PATH — which doesn't exist. The demo must
 * live outside our repo for the npx invocations to fetch the
 * published 8.x package cleanly. This is also more honest about
 * what the demo claims: anyone with npm and no streamo checkout
 * can reproduce it.
 */
import { Signer } from '../public/streamo/Signer.js'
import { bytesToHex } from '../public/streamo/utils.js'
import { cp, mkdir, rm, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { question } from 'readline-sync'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const demoDir = resolve(repoRoot, '..', 'streamo-three-record-demo')

const RULE = '━'.repeat(72)
console.log('\n' + RULE)
console.log('streamo three-record demo — setup')
console.log(RULE)

// ── Interactive: who's the author? ─────────────────────────────────────
// The username + password define ONE identity. The three Records share
// that identity but have different stream names (library, explorer,
// homepage). That's the streamo model — pubkey = derive(username,
// password, streamName). Same person, three streams.

console.log(`
The three Records share ONE author identity. You'll type a username and
password now; the npx commands will prompt for the same password three
times (one per Record).`)

const username = (question('\n  Username (demo): ') || 'demo').trim()
const password = question('  Password (demo, hidden): ', {
  hideEchoBack: true,
  mask: ''
}) || 'demo'

// ── Pre-derive deterministic pubkeys at the CLI's default iteration count ──
// 100000 matches what `npx @dtudury/streamo` does without --key-iterations,
// so the commands stay minimal (no flag to keep in sync). The derivation
// takes ~1s here and again at each CLI startup; that's the production
// experience, not a demo shortcut.

const ITERATIONS = 100000
const records = ['library', 'explorer', 'homepage']

console.log('\n  deriving pubkeys (iterations=100000, takes a moment)…')
const signer = new Signer(username, password, ITERATIONS)
const keys = {}
for (const r of records) {
  const { publicKey } = await signer.keysFor(r)
  keys[r] = bytesToHex(publicKey)
  console.log(`    ${r.padEnd(10)} ${keys[r].slice(0, 16)}…`)
}

// ── Reset ./demo/ and build the directory layout ───────────────────────

console.log(`\n  resetting ${demoDir} …`)
await rm(demoDir, { recursive: true, force: true })
await mkdir(join(demoDir, 'library', 'files'),  { recursive: true })
await mkdir(join(demoDir, 'explorer', 'files'), { recursive: true })
await mkdir(join(demoDir, 'homepage', 'files'), { recursive: true })

// ── Seed library and explorer from the live dev tree ───────────────────
// One-shot copy for the kick-the-wheels demo. The follow-up arc David
// floated (point --files at public/streamo/ in place) skips this step
// entirely.

console.log('  seeding library Record from public/streamo/ …')
await cp(
  join(repoRoot, 'public', 'streamo'),
  join(demoDir, 'library', 'files'),
  { recursive: true }
)

// Inject a marker file the static-file fallback cannot serve. The relay's
// web server falls through to express.static(publicDir) — the installed
// package's public/ folder — after the repo+mount resolver fails. Real lib
// files (h.js, mount.js) exist there too, so a working smoke test on those
// proves only that the bytes are *available*, not that the mount is doing
// the work. This file exists ONLY in the library Record. If the homepage
// can import it, the mount resolver is the one serving.
console.log('  injecting mount-proof.js into library Record …')
await writeFile(
  join(demoDir, 'library', 'files', 'mount-proof.js'),
  "export const MOUNT_SOURCE = 'library-record-via-mount'\n"
)

console.log('  seeding explorer Record from public/apps/explorer/ …')
await cp(
  join(repoRoot, 'public', 'apps', 'explorer'),
  join(demoDir, 'explorer', 'files'),
  { recursive: true }
)

// ── Write the homepage Record's files + streamo.json ───────────────────

console.log('  writing homepage Record (index.html + streamo.json) …')

const indexHtml = `<!doctype html>
<meta charset="utf-8">
<title>three-record demo</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 42em; margin: 4em auto; padding: 0 1em; color: #222; }
  code { background: #f3f3f3; padding: 0 0.3em; border-radius: 3px; }
  .ok   { color: #2a7a3a; }
  .fail { color: #c33; }
  .pending { color: #888; }
</style>
<h1>three records, one website</h1>
<p>This page is one Record. The streamo library mounted at
   <code>/streamo/</code> is another. The explorer at
   <code>/apps/explorer/</code> is a third.
   <em>Composed, not copied.</em></p>
<ul>
  <li><a href="/apps/explorer/">open the explorer →</a></li>
</ul>
<p id="bytes" class="pending">checking library bytes…</p>
<p id="mount" class="pending">checking mount resolver…</p>
<script type="module">
  // Two signals: bytes-available (which the static-file fallback can fake),
  // and mount-actually-serving (which only the library Record can satisfy).
  const $bytes = document.getElementById('bytes')
  const $mount = document.getElementById('mount')

  try {
    const { h } = await import('./streamo/h.js')
    $bytes.className = 'ok'
    $bytes.textContent = '✓ /streamo/h.js loaded — library Record served via mount'
    void h
  } catch (err) {
    $bytes.className = 'fail'
    $bytes.textContent = '✗ /streamo/h.js — library Record not connected'
  }

  try {
    const { MOUNT_SOURCE } = await import('./streamo/mount-proof.js')
    $mount.className = 'ok'
    $mount.textContent = '✓ mount-proof.js loaded: ' + MOUNT_SOURCE
  } catch (err) {
    $mount.className = 'fail'
    $mount.textContent = '✗ mount-proof.js not served — library Record not connected'
  }
</script>
`
await writeFile(join(demoDir, 'homepage', 'files', 'index.html'), indexHtml)

const streamoJson = {
  mounts: {
    'streamo/':       { key: keys.library },
    'apps/explorer/': { key: keys.explorer }
  }
}
await writeFile(
  join(demoDir, 'homepage', 'files', 'streamo.json'),
  JSON.stringify(streamoJson, null, 2) + '\n'
)

// ── Print the three commands to copy/paste into three terminals ────────

// Each terminal cd's into its Record's subdir. --data-dir defaults to
// `.streamo` per CWD (per-Record isolation). --files ./files finds
// the seeded directory and (since 9.0.0) auto-enables --record-file
// streamo.json so value.mounts gets populated from disk.
//
// `npx -y @dtudury/streamo@9.0.1` pins the published version the demo
// is known to work with — defensive against version drift (the demo
// stays good even if a future minor changes default behavior), and a
// clean test point: "does the demo still work with 10.0.0? drop the
// pin and re-run." 9.0.1 is the no-static-fallback world: until the
// library terminal starts, /streamo/* genuinely 404s (the previous
// 9.0.0 demo passed `library bytes` via the static fallback before
// library started; now both `library bytes` and `mount-proof` fail
// until library is up — honest signal). If you want to test an
// unpublished local build, substitute `node /path/to/streamo/bin/streamo.js`
// for the npx call.
const cmd = (record, extra) =>
  `cd ${join(demoDir, record)} && \\
      npx -y @dtudury/streamo@9.0.1 --name ${record} --username ${username} \\
        --files ./files ${extra}`

console.log('\n' + RULE)
console.log('ready — run these in three separate terminals')
console.log(RULE)
console.log(`
You'll be prompted for "Password (hidden):" in each terminal. Type the
same password you just entered above. (First-time npx will also ask
"Need to install... Ok to proceed?" — press y once and it's cached for
the other two.)

  Terminal 1 — homepage (the web + WS relay):

    ${cmd('homepage', '--web 8080')}

  Terminal 2 — library author (joins the relay over origin):

    ${cmd('library',  '--origin localhost:8080')}

  Terminal 3 — explorer author (joins the relay over origin):

    ${cmd('explorer', '--origin localhost:8080')}

Then visit:

    http://localhost:8080/                — homepage (library mount smoke test)
    http://localhost:8080/apps/explorer/  — explorer composed with library

What to watch on the homepage's smoke tests:
  • "library bytes" — checks /streamo/h.js loads. Under 9.0.1 there
    is NO static fallback; the only way this loads is if the library
    Record is connected and the mount resolver is doing the work.
  • "mount-proof.js" — a file that exists ONLY in the library Record
    (this setup script injects it). Redundant signal under 9.0.1
    (both checks now mean "library Record is up") but kept as a
    concrete demonstration of what's in the library Record vs the
    homepage Record vs other Records.

  Start only homepage → reload → both checks ✗ (library not up).
    Under 9.0.0 the first check would have passed via the static
    fallback, leaving a confusing "page looks fine" surface; 9.0.1
    is honest about what's actually missing.
  Start library → reload → both checks ✓. The library Record's bytes
    are now flowing through the homepage's mount resolver.
  Start explorer → visit /apps/explorer/ → the explorer loads (from
    the explorer Record, with its own \`../../streamo/h.js\` imports
    resolving through the homepage's library mount — composition
    end-to-end).
`)
console.log(RULE)
