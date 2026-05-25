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
<p id="smoke" class="pending">loading library mount…</p>
<script type="module">
  const el = document.getElementById('smoke')
  try {
    const { h }     = await import('./streamo/h.js')
    const { mount } = await import('./streamo/mount.js')
    if (typeof h === 'function' && typeof mount === 'function') {
      el.className = 'ok'
      el.textContent = '✓ library mounted — imported h() and mount() from ./streamo/'
    } else {
      el.className = 'fail'
      el.textContent = '✗ library mount resolved but exports are not functions'
    }
  } catch (err) {
    el.className = 'fail'
    el.textContent = '✗ library mount not yet available — ' + err.message
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

What to watch:
  • Start only homepage first → reload page → smoke test fails (✗): the
    mount points at a key the relay doesn't have bytes for yet.
  • Start library → reload → smoke test goes ✓: bytes arrived via origin,
    the mount resolver lights up live.
  • Start explorer → visit /apps/explorer/ → the explorer loads, and its
    \`../../streamo/h.js\` imports resolve through the homepage's library
    mount. One URL hierarchy composed from three signed chains.
`)
console.log(RULE)
