#!/usr/bin/env node
/**
 * @file demo-relays-6 — six-relay split-role topology.
 *
 * Same three Records as demo-relays-3.js (library / explorer / homepage),
 * but each Record is split across TWO relays: a *source* (holds the
 * files, authors the chain, ephemeral) and a *mirror* (outlet open,
 * persistent archive, serves the world). The two endpoints of the
 * topology spectrum:
 *
 *   demo-relays-3.js  →  fewest relays, most things per relay
 *   demo-relays-6.js  →  most relays, fewest things per relay
 *
 * ## Topology
 *
 *   library-source   ──feed──▶ library-mirror   (outlet 1024, archive)
 *   explorer-source  ──feed──▶ explorer-mirror  (outlet 1025, archive)
 *   homepage-source  ──feed──▶ homepage-mirror  (outlet 1026, archive, web 8080)
 *                                       └──feed──▶ library-mirror
 *                                       └──feed──▶ explorer-mirror
 *
 *   3 sources:  --files only, ephemeral, each feeds its own mirror
 *   3 mirrors:  --outlet open, persistent archive, never has --files
 *               (homepage-mirror also has --web + feeds composing the others)
 *
 * ## The visible-archive contrast
 *
 * 3-relay (demo-relays-3): everything ephemeral, no .bin files anywhere —
 *   proves the wire path is the only source of content.
 * 6-relay (this one):     mirrors keep persistent archives — you can
 *   `ls demoDir/library-mirror/.streamo/` and see real .bin files appear
 *   after the source's bytes have flowed in. Restart a mirror; its archive
 *   rehydrates without the source even running.
 *
 * Each role does ONE thing. Sources read directories, sign commits, push
 * up. Mirrors accept incoming feeds, hold the chain, serve downstream.
 * The homepage-mirror is the only relay with multiple jobs (outlet + web
 * + composing-via-feeds), and that's because someone has to be the
 * integration point browsers can talk to.
 *
 * Run:
 *
 *   $ node scripts/demo-relays-6.js
 *
 * SIGINT shuts all six down cleanly.
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
const demoDir = resolve(repoRoot, '..', 'streamo-relays-6-demo')

const RULE = '━'.repeat(72)
console.log('\n' + RULE)
console.log('streamo 6-relay demo — setup ("most relays doing fewest things")')
console.log(RULE)

// Credentials: env-var first (for scripted runs / CI), interactive prompt
// otherwise. Defaults to 'demo'/'demo' if the user just hits Enter.
let username, password
if (process.env.STREAMO_DEMO_USERNAME) {
  username = process.env.STREAMO_DEMO_USERNAME
  password = process.env.STREAMO_DEMO_PASSWORD || 'demo'
  console.log(`\nusing credentials from env (username: ${username})`)
} else {
  console.log(`
Three Records, two relays each (source + mirror), one author identity.`)
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
// One subdir per RELAY (six total). The source dirs hold the input files;
// the mirror dirs hold the archive .bin files. No files in mirror dirs;
// no archive in source dirs.

console.log(`\nlaying out files under ${demoDir}`)
await rm(demoDir, { recursive: true, force: true })
await mkdir(demoDir, { recursive: true })

for (const role of ['library-source', 'explorer-source', 'homepage-source',
                    'library-mirror', 'explorer-mirror', 'homepage-mirror']) {
  await mkdir(join(demoDir, role), { recursive: true })
}

// library-source: copy the streamo lib + a probe file
await mkdir(join(demoDir, 'library-source', 'files'), { recursive: true })
await cp(
  join(repoRoot, 'public', 'streamo'),
  join(demoDir, 'library-source', 'files'),
  { recursive: true }
)
await writeFile(
  join(demoDir, 'library-source', 'files', 'mount-proof.js'),
  "export const MOUNT_SOURCE = 'library-record-via-mount'\n"
)

// explorer-source: copy the explorer app
await mkdir(join(demoDir, 'explorer-source', 'files'), { recursive: true })
await cp(
  join(repoRoot, 'public', 'apps', 'explorer'),
  join(demoDir, 'explorer-source', 'files'),
  { recursive: true }
)

// homepage-source: landing page + mounts.json + streamo.svg + proto.css
await mkdir(join(demoDir, 'homepage-source', 'files'), { recursive: true })
await cp(
  join(repoRoot, 'public', 'homepage', 'streamo.svg'),
  join(demoDir, 'homepage-source', 'files', 'streamo.svg')
)
// Same proto.css workaround as the 3-relay demo (next iteration would
// add a 4th Record for the styles Record).
await mkdir(join(demoDir, 'homepage-source', 'files', 'apps', 'styles'), { recursive: true })
await cp(
  join(repoRoot, 'public', 'apps', 'styles', 'proto.css'),
  join(demoDir, 'homepage-source', 'files', 'apps', 'styles', 'proto.css')
)
const indexHtml = `<!doctype html>
<meta charset="utf-8">
<link rel="icon" type="image/svg+xml" href="/streamo.svg">
<title>6-relay demo</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 42em; margin: 4em auto; padding: 0 1em; color: #222; }
  code { background: #f3f3f3; padding: 0 0.3em; border-radius: 3px; }
  .ok   { color: #2a7a3a; }
  .fail { color: #c33; }
  .pending { color: #888; }
</style>
<h1><img src="/streamo.svg" alt="" style="height:1em;vertical-align:-.15em">  six relays — split-role topology</h1>
<p>Each of the three Records (library, explorer, homepage) is split across
   two relays: a <em>source</em> (holds the directory, authors the chain,
   no archive) and a <em>mirror</em> (outlet open, persistent archive,
   serves the world). The visible <code>.streamo/</code> dirs appear under
   the three mirrors as bytes flow through.</p>
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
    $bytes.textContent = '✓ /streamo/h.js loaded — library Record via mirror via mount'
    void h
  } catch {
    $bytes.className = 'fail'
    $bytes.textContent = '✗ /streamo/h.js — library chain not flowing'
  }
  try {
    const { MOUNT_SOURCE } = await import('./streamo/mount-proof.js')
    $mount.className = 'ok'
    $mount.textContent = '✓ mount-proof.js: ' + MOUNT_SOURCE
  } catch {
    $mount.className = 'fail'
    $mount.textContent = '✗ mount-proof.js not served — library chain not flowing'
  }
</script>
`
await writeFile(join(demoDir, 'homepage-source', 'files', 'index.html'), indexHtml)
await writeFile(
  join(demoDir, 'homepage-source', 'files', 'mounts.json'),
  JSON.stringify({
    mounts: {
      'streamo/':       { key: keys.library },
      'apps/explorer/': { key: keys.explorer }
    }
  }, null, 2) + '\n'
)

// ── Write the six streamo.json configs ──────────────────────────────────

const writeStreamoJson = async (role, recordName, server) => {
  await writeFile(
    join(demoDir, role, 'streamo.json'),
    JSON.stringify({
      identity: {
        name: recordName,    // same Record name for source + mirror (same pubkey)
        username,
        keyIterations: ITERATIONS,
        self: keys[recordName]
      },
      server
    }, null, 2) + '\n'
  )
}

// Sources: ephemeral (no archive on disk), files only, feed up to their mirror.
// Each source's authoritative artifact IS the files directory; archive would
// be redundant copy. The source's job is "directory → signed chain → push."
await writeStreamoJson('library-source', 'library', {
  archive: false,
  files: './files',
  feed: 'localhost:1024',     // → library-mirror's outlet
  recordFile: false,
  verbose: 'debug'
})
await writeStreamoJson('explorer-source', 'explorer', {
  archive: false,
  files: './files',
  feed: 'localhost:1025',     // → explorer-mirror's outlet
  recordFile: false,
  verbose: 'debug'
})
await writeStreamoJson('homepage-source', 'homepage', {
  archive: false,
  files: './files',
  feed: 'localhost:1026',     // → homepage-mirror's outlet
  recordFile: false,
  verbose: 'debug'
})

// Mirrors: persistent archive (this is where the .bin files appear), outlet
// open, NO --files. The mirror's job is "accept feeds → hold the chain →
// serve downstream." The homepage-mirror also serves HTTP (--web) and
// composes by feeding to the other two mirrors.
await writeStreamoJson('library-mirror', 'library', {
  archive: './.streamo',
  outlet: 1024,
  recordFile: false,
  verbose: 'debug'
})
await writeStreamoJson('explorer-mirror', 'explorer', {
  archive: './.streamo',
  outlet: 1025,
  recordFile: false,
  verbose: 'debug'
})
await writeStreamoJson('homepage-mirror', 'homepage', {
  archive: './.streamo',
  outlet: 1026,
  web: 8080,
  feed: ['localhost:1024', 'localhost:1025'],   // compose library + explorer
  recordFile: false,
  verbose: 'debug'
})

console.log('files ready. spawning relays…\n' + RULE)

// ── Spawn the six relays ────────────────────────────────────────────────
// Order: mirrors first (so their outlets are ready), then sources (which
// dial up). Retry-first-connect would handle the inverse too, but
// deterministic order makes the log story easier to follow.

const passwordEnv = name => ({
  STREAMO_USERNAME: username,
  STREAMO_PASSWORD: password,
  STREAMO_NAME:     name
})

await runRelays([
  { name: 'lib-mir',  args: ['--config', join(demoDir, 'library-mirror',  'streamo.json')], env: passwordEnv('library')  },
  { name: 'exp-mir',  args: ['--config', join(demoDir, 'explorer-mirror', 'streamo.json')], env: passwordEnv('explorer'), staggerMs: 300 },
  { name: 'home-mir', args: ['--config', join(demoDir, 'homepage-mirror', 'streamo.json')], env: passwordEnv('homepage'), staggerMs: 300 },
  { name: 'lib-src',  args: ['--config', join(demoDir, 'library-source',  'streamo.json')], env: passwordEnv('library'),  staggerMs: 800 },
  { name: 'exp-src',  args: ['--config', join(demoDir, 'explorer-source', 'streamo.json')], env: passwordEnv('explorer'), staggerMs: 300 },
  { name: 'home-src', args: ['--config', join(demoDir, 'homepage-source', 'streamo.json')], env: passwordEnv('homepage'), staggerMs: 300 }
])
