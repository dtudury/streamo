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
 * Re-running wipes ../streamo-three-record-demo/ and rebuilds —
 * safe to use as a reset.
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

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const demoDir = resolve(repoRoot, '..', 'streamo-three-record-demo')

const RULE = '━'.repeat(72)
console.log('\n' + RULE)
console.log('streamo three-record demo — setup')
console.log(RULE)

// ── Pre-derive deterministic pubkeys ───────────────────────────────────
// iterations=1 keeps the demo snappy; the npx commands include
// --key-iterations 1 so the runtime derivation matches. Don't ship
// credentials this weak for anything real.

const ITERATIONS = 1
const records = [
  { record: 'library',  name: 'library',  username: 'demo', password: 'lib-pw' },
  { record: 'explorer', name: 'explorer', username: 'demo', password: 'exp-pw' },
  { record: 'homepage', name: 'homepage', username: 'demo', password: 'hp-pw' }
]

console.log('\n  deriving pubkeys (iterations=1):')
const keys = {}
for (const r of records) {
  const signer = new Signer(r.username, r.password, ITERATIONS)
  const { publicKey } = await signer.keysFor(r.name)
  keys[r.record] = bytesToHex(publicKey)
  console.log(`    ${r.record.padEnd(10)} ${keys[r.record].slice(0, 16)}…`)
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
    $bytes.textContent = '✓ /streamo/h.js loaded (may be via mount OR static fallback)'
    void h
  } catch (err) {
    $bytes.className = 'fail'
    $bytes.textContent = '✗ /streamo/h.js failed — ' + err.message
  }

  try {
    const { MOUNT_SOURCE } = await import('./streamo/mount-proof.js')
    $mount.className = 'ok'
    $mount.textContent = '✓ mount resolver serving: ' + MOUNT_SOURCE
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

// Commands use relative paths from inside demoDir, so the user runs the
// printed `cd` first. -y skips npx's install confirmation, which would
// otherwise need a TTY response on a fresh machine.
const cmd = (record, password, extra) =>
  `npx -y @dtudury/streamo \\
      --name ${record} --username demo --password ${password} \\
      --data-dir ./${record} --files ./${record}/files \\
      --key-iterations 1 ${extra}`

console.log('\n' + RULE)
console.log('ready — run these in three separate terminals')
console.log(RULE)
console.log(`
  First, cd into the demo directory (so npx is OUTSIDE the streamo repo
  — see header comment for why):

    cd ${demoDir}

  Terminal 1 — homepage (the web + WS relay):

    ${cmd('homepage', 'hp-pw', '--web 8080')}

  Terminal 2 — library author (joins the relay over origin):

    ${cmd('library',  'lib-pw', '--origin localhost:8080')}

  Terminal 3 — explorer author (joins the relay over origin):

    ${cmd('explorer', 'exp-pw', '--origin localhost:8080')}

Then visit:

    http://localhost:8080/                — homepage (library mount smoke test)
    http://localhost:8080/apps/explorer/  — explorer composed with library

What to watch on the homepage's smoke tests:
  • "library bytes" — checks /streamo/h.js loads. This ALMOST ALWAYS
    passes, because the relay falls through to express.static(publicDir)
    when the mount resolver misses. h.js is in the installed
    @dtudury/streamo package, so this check passes even without library
    running. It only tells you bytes are *somewhere*.
  • "mount resolver" — checks /streamo/mount-proof.js loads. This file
    exists ONLY in the library Record (the setup script injects it).
    The static fallback cannot serve it. Passing this check means the
    mount is actually doing the work.

  Start only homepage → reload → "bytes" ✓ (via static fallback),
    "mount" ✗ (library Record not connected). This is the surprise:
    the page looks fine because the package supplied the bytes.
  Start library → reload → "mount" ✓: real composition is now live.
  Start explorer → visit /apps/explorer/ → the explorer loads. Its
    \`../../streamo/h.js\` imports may resolve through EITHER the mount
    OR the static fallback — bytes are identical, you can't tell from
    the explorer alone. But the homepage's mount-proof test settles it
    for the whole page.
`)
console.log(RULE)
