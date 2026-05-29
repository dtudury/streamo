#!/usr/bin/env node
/**
 * @file demo-relays-3 — three-relay composed-website demo.
 *
 * Same three Records as demo-three-records.js (library / explorer / homepage)
 * but spawned together as one orchestrator command, with each relay's
 * stdout colored by source so you can watch bytes propagate between them.
 *
 * ## Topology (Version B — "homepage watches its sources")
 *
 *   homepage  ───watches──▶ library (outlet on 1024)
 *                ───watches──▶ explorer (outlet on 1025)
 *   homepage   serves HTTP at http://localhost:8080/
 *   homepage   owns the homepage Record's chain (--files)
 *   library    owns the library Record's chain (--files)
 *   explorer   owns the explorer Record's chain (--files)
 *
 * Each Record's relay opens an outlet for incoming connections; homepage
 * dials out to library's and explorer's outlets (--watch) and serves
 * their content composed under URL paths via mounts.json.
 *
 * ## In the new streamo.json shape we've been designing
 *
 *   homepage: { server: { outlet: true, web: 8080, files: "./homepage/files",
 *                         watch: ["localhost:1024", "localhost:1025"] } }
 *   library:  { server: { outlet: 1024, files: "./library/files" } }
 *   explorer: { server: { outlet: 1025, files: "./explorer/files" } }
 *
 * The substrate doesn't read this shape yet — bin/streamo.js currently
 * takes CLI flags only. The script below translates the JS-literal
 * configs into the equivalent CLI invocations.
 *
 * ## Startup order
 *
 *   1. library  (outlet)
 *   2. explorer (outlet)
 *   3. homepage (web + watches both — its watches retry-until-success, so
 *                even if order flipped it'd still come together; but the
 *                deterministic order makes the log story reproducible)
 *
 * Run:
 *
 *   $ node scripts/demo-relays-3.js
 *
 * SIGINT (Ctrl-C) shuts all three down cleanly.
 */
import { cp, mkdir, rm, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { question } from 'readline-sync'
import { Signer } from '../public/streamo/Signer.js'
import { bytesToHex } from '../public/streamo/utils.js'
import { runRelays } from './lib/relay-orchestrator.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const demoDir = resolve(repoRoot, '..', 'streamo-relays-3-demo')
const streamoBin = join(repoRoot, 'bin', 'streamo.js')

const RULE = '━'.repeat(72)
console.log('\n' + RULE)
console.log('streamo 3-relay demo — setup')
console.log(RULE)

// Credentials: env-var first (for scripted runs / CI), interactive prompt
// otherwise. Defaults to 'demo'/'demo' if the user just hits Enter — the
// demo doesn't pretend to be production-secure.
let username, password
if (process.env.STREAMO_DEMO_USERNAME) {
  username = process.env.STREAMO_DEMO_USERNAME
  password = process.env.STREAMO_DEMO_PASSWORD || 'demo'
  console.log(`\nusing credentials from env (username: ${username})`)
} else {
  console.log(`
Three Records, one author. You'll type a username and password once;
the same credentials get passed to all three spawned relays (with
different --name values to derive distinct pubkeys per Record).`)
  username = (question('\n  Username (demo): ') || 'demo').trim()
  password = question('  Password (demo, hidden): ', {
    hideEchoBack: true,
    mask: ''
  }) || 'demo'
}

const ITERATIONS = 100000
const records = ['library', 'explorer', 'homepage']

console.log('\nderiving pubkeys (~1s per Record at 100k iterations)…')
const keys = {}
for (const name of records) {
  const signer = new Signer(username, password, ITERATIONS)
  const { publicKey } = await signer.keysFor(name)
  keys[name] = bytesToHex(publicKey)
  console.log(`  ${name.padEnd(8)}: ${keys[name].slice(0, 16)}…`)
}

// ── Reset the demo dir and lay out each Record's files ──────────────────

console.log(`\nlaying out files under ${demoDir}`)
await rm(demoDir, { recursive: true, force: true })
await mkdir(demoDir, { recursive: true })

// library Record: copy the streamo lib so /streamo/h.js etc. resolve
await mkdir(join(demoDir, 'library', 'files'), { recursive: true })
await cp(
  join(repoRoot, 'public', 'streamo'),
  join(demoDir, 'library', 'files'),
  { recursive: true }
)
// One distinguishing file the homepage can probe for to verify "I'm
// actually reading the library Record, not some static fallback."
await writeFile(
  join(demoDir, 'library', 'files', 'mount-proof.js'),
  "export const MOUNT_SOURCE = 'library-record-via-mount'\n"
)

// explorer Record: copy the explorer app
await mkdir(join(demoDir, 'explorer', 'files'), { recursive: true })
await cp(
  join(repoRoot, 'public', 'apps', 'explorer'),
  join(demoDir, 'explorer', 'files'),
  { recursive: true }
)

// homepage Record: a tiny landing page + mounts.json composing the others
await mkdir(join(demoDir, 'homepage', 'files'), { recursive: true })
const indexHtml = `<!doctype html>
<meta charset="utf-8">
<title>3-relay demo</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 42em; margin: 4em auto; padding: 0 1em; color: #222; }
  code { background: #f3f3f3; padding: 0 0.3em; border-radius: 3px; }
  .ok   { color: #2a7a3a; }
  .fail { color: #c33; }
  .pending { color: #888; }
</style>
<h1>three records, three relays, one website</h1>
<p>The homepage relay (this server) watches a library relay and an explorer
   relay. mounts.json declares URL routing into both. <em>Composed, not
   copied.</em></p>
<ul>
  <li><a href="/apps/explorer/">open the explorer →</a></li>
</ul>
<p id="bytes" class="pending">checking library bytes…</p>
<p id="mount" class="pending">checking mount resolver…</p>
<script type="module">
  const $bytes = document.getElementById('bytes')
  const $mount = document.getElementById('mount')
  try {
    const { h } = await import('./streamo/h.js')
    $bytes.className = 'ok'
    $bytes.textContent = '✓ /streamo/h.js loaded — library Record served via mount'
    void h
  } catch {
    $bytes.className = 'fail'
    $bytes.textContent = '✗ /streamo/h.js — library Record not connected'
  }
  try {
    const { MOUNT_SOURCE } = await import('./streamo/mount-proof.js')
    $mount.className = 'ok'
    $mount.textContent = '✓ mount-proof.js loaded: ' + MOUNT_SOURCE
  } catch {
    $mount.className = 'fail'
    $mount.textContent = '✗ mount-proof.js not served — library Record not connected'
  }
</script>
`
await writeFile(join(demoDir, 'homepage', 'files', 'index.html'), indexHtml)
await writeFile(
  join(demoDir, 'homepage', 'files', 'mounts.json'),
  JSON.stringify({
    mounts: {
      'streamo/':       { key: keys.library },
      'apps/explorer/': { key: keys.explorer }
    }
  }, null, 2) + '\n'
)

// ── Write the intended streamo.json config alongside each relay's dir ──
// The substrate doesn't read these yet (bin/streamo.js still takes CLI
// flags only), but the files are the design artifact — what each relay
// would declare under the new shape we've been refining. The script
// below translates them into the equivalent CLI invocations.

const writeStreamoJson = async (name, server) => {
  await writeFile(
    join(demoDir, name, 'streamo.json'),
    JSON.stringify({
      identity: {
        name,
        username,
        keyIterations: ITERATIONS,
        self: keys[name]
      },
      server
    }, null, 2) + '\n'
  )
}

await writeStreamoJson('library', {
  outlet: 1024,
  files: './files'
})
await writeStreamoJson('explorer', {
  outlet: 1025,
  files: './files'
})
await writeStreamoJson('homepage', {
  outlet: true,
  web: 8080,
  files: './files',
  watch: ['localhost:1024', 'localhost:1025']
})

console.log('files ready. spawning relays…\n' + RULE)

// ── Spawn the three relays in order ─────────────────────────────────────
// Each relay's args correspond to one streamo.json `server:` block from
// the design conversation. The orchestrator handles colored prefixes,
// SIGINT shutdown, and stream piping.

const sharedAuth = name => [
  '--name',     name,
  '--username', username,
  '--password', password,
  '--key-iterations', String(ITERATIONS),
  '--no-record-file',           // no top-level meta to mirror to streamo.json
  '--verbose', 'debug'
]

await runRelays([
  // library — outlet on 1024, owns the library Record via --files
  // streamo.json shape: { server: { outlet: 1024, files: "./library/files" } }
  {
    name: 'library',
    args: [
      ...sharedAuth('library'),
      '--files',    join(demoDir, 'library',  'files'),
      '--data-dir', join(demoDir, 'library',  '.streamo'),
      '--outlet',   '1024'
    ]
  },

  // explorer — outlet on 1025
  // streamo.json shape: { server: { outlet: 1025, files: "./explorer/files" } }
  {
    name: 'explorer',
    args: [
      ...sharedAuth('explorer'),
      '--files',    join(demoDir, 'explorer', 'files'),
      '--data-dir', join(demoDir, 'explorer', '.streamo'),
      '--outlet',   '1025'
    ],
    startupDelayMs: 500
  },

  // homepage — web on 8080, watches both source relays, owns homepage Record
  // streamo.json shape: {
  //   server: {
  //     outlet: true, web: 8080, files: "./homepage/files",
  //     watch: ["localhost:1024", "localhost:1025"]
  //   }
  // }
  {
    name: 'homepage',
    args: [
      ...sharedAuth('homepage'),
      '--files',    join(demoDir, 'homepage', 'files'),
      '--data-dir', join(demoDir, 'homepage', '.streamo'),
      '--web',      '8080',
      '--watch',    'localhost:1024',
      '--watch',    'localhost:1025'
    ],
    startupDelayMs: 500
  }
])
