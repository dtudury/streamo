#!/usr/bin/env node
/**
 * @file demo-mounts — show the mounts feature end-to-end on disk.
 *
 * Builds two in-process Repos:
 *   - `library`: a fake "streamo library" with a few .js files
 *   - `app`:     a fake app whose `mounts.streamo/` points at library,
 *                with an `index.html` / `main.js` that imports from
 *                `./streamo/...` as if the library were a sibling folder
 *
 * Then fileSyncs `app` to a temp folder and prints the composed tree.
 * You'll see the app's own files AND the library's files materialized
 * at the mount path — the same tree an IDE would resolve imports against.
 *
 *   $ node scripts/demo-mounts.js
 */
import { Repo } from '../public/streamo/Repo.js'
import { RepoRegistry } from '../public/streamo/RepoRegistry.js'
import { fileSync } from '../public/streamo/fileSync.js'
import { Signer } from '../public/streamo/Signer.js'
import { bytesToHex } from '../public/streamo/utils.js'
import { mkdtemp } from 'fs/promises'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const RULE = '━'.repeat(72)
console.log('\n' + RULE)
console.log('streamo mounts demo')
console.log(RULE)

// Deterministic signers — re-runs produce stable pubkeys, so the demo
// output is reproducible. The credentials don't authorize anything; they
// just give us reproducible keypairs for the demo records.
const libSigner = new Signer('demo', 'mounts-lib', 1)
const appSigner = new Signer('demo', 'mounts-app', 1)
const libKeyHex = bytesToHex((await libSigner.keysFor('lib')).publicKey)
const appKeyHex = bytesToHex((await appSigner.keysFor('app')).publicKey)

console.log(`\n  library record  ${libKeyHex.slice(0, 16)}…`)
console.log(`  app record      ${appKeyHex.slice(0, 16)}…`)

// ── Library record ──────────────────────────────────────────────────────
// A few fake "streamo library" files. Pretending these are the real
// `h.js`, `mount.js`, etc. — content doesn't matter for the demo, just
// that they're distinct files we can prove arrived via the mount.

const lib = new Repo()
lib.attachSigner(libSigner, 'lib')
{
  const w = lib.checkout()
  w.set({
    files: {
      'h.js':    '// fake h.js — tagged template literal parser\nexport function h () { return "(stub)" }\n',
      'mount.js': '// fake mount.js — reactive DOM renderer\nexport function mount () { /* … */ }\n',
      'Repo.js': '// fake Repo.js — the signed-chain wrapper\nexport class Repo {}\n'
    }
  })
  lib.commit(w, 'seed library')
}

// ── App record ──────────────────────────────────────────────────────────
// Its own `files` + a `mounts` entry pointing at the library record.
// The app's `main.js` imports from `./streamo/h.js` as if streamo were
// a sibling folder — the mount makes that path real.

const app = new Repo()
app.attachSigner(appSigner, 'app')
{
  const w = app.checkout()
  w.set({
    files: {
      'index.html': '<!doctype html>\n<title>mounts demo</title>\n<script type="module" src="./main.js"></script>\n<h1>App</h1>\n',
      'main.js':    "// app code that imports from the mounted library\nimport { h, mount } from './streamo/h.js'\nconsole.log('app booted', h(), mount)\n"
    },
    mounts: {
      'streamo/': { key: libKeyHex }
    }
  })
  app.commit(w, 'seed app + mount')
}

// ── Registry whose factory returns our pre-built repos ─────────────────
// `registry.get(key)` is the lookup the mount-resolver uses; the factory
// is the lazy-open path. We pre-open both so the resolver finds them.

const registry = new RepoRegistry(async (keyHex) => {
  if (keyHex === libKeyHex) return lib
  if (keyHex === appKeyHex) return app
  return new Repo()
})
await registry.open(libKeyHex)
await registry.open(appKeyHex)

// ── fileSync the app to a temp folder, mounts enabled ───────────────────

const outDir  = await mkdtemp(join(tmpdir(), 'streamo-mounts-demo-'))
const dataDir = await mkdtemp(join(tmpdir(), 'streamo-mounts-demo-data-'))

console.log(`\n  materializing → ${outDir}`)

const sub = await fileSync(app, outDir, dataDir, {
  filesKey: 'files',
  registry,
  pubkeyHex: appKeyHex
})

// fileSync's initial materialization is synchronous-with-the-await above,
// so the files are on disk by the time we get here. A tiny grace beat for
// any background writes (mounts) to settle.
await new Promise(r => setTimeout(r, 50))

// ── Pretty-print the resulting tree ─────────────────────────────────────

function tree (dir, prefix = '') {
  const lines = []
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const isLast = i === entries.length - 1
    const connector = isLast ? '└── ' : '├── '
    const continuation = isLast ? '    ' : '│   '
    lines.push(prefix + connector + entry.name)
    if (entry.isDirectory()) lines.push(...tree(join(dir, entry.name), prefix + continuation))
  }
  return lines
}

console.log('\n  composed tree on disk:\n')
console.log('  ' + outDir + '/')
for (const line of tree(outDir)) console.log('  ' + line)

// Show one mounted file's actual contents to prove it's the library's
console.log(`\n  contents of streamo/h.js:`)
const hContent = readFileSync(join(outDir, 'streamo/h.js'), 'utf8')
for (const line of hContent.trimEnd().split('\n')) console.log('    │ ' + line)

// ── Demonstrate the read-only enforcement (banner fires + revert) ──────
// Briefly write to a mounted path; watch the banner appear; show the
// file reverted. Captures the banner so we control its placement in the
// demo output rather than interleaving with our prose.

console.log('\n' + RULE)
console.log('read-only enforcement check')
console.log(RULE)

console.log('\n  tampering with streamo/h.js…')
writeFileSync(join(outDir, 'streamo/h.js'), '// USER WROTE THIS — should be reverted')

// Capture the banner so we can show it cleanly
const origErr = console.error
const captured = []
console.error = (...args) => captured.push(args.join(' '))

// Give the watcher time to fire + revert
await new Promise(r => setTimeout(r, 500))

console.error = origErr

console.log('  (banner that fired)')
console.log()
for (const line of captured) console.log('  ' + line.replace(/\n/g, '\n  '))

const afterContent = readFileSync(join(outDir, 'streamo/h.js'), 'utf8')
const reverted = afterContent === hContent
console.log(`\n  after the banner — file ${reverted ? 'REVERTED ✓' : 'NOT reverted ✗'}`)

console.log('\n' + RULE)
console.log('what just happened')
console.log(RULE)
console.log(`
  • The "app" record has its own files (index.html, main.js) plus a
    \`mounts.streamo/\` entry pointing at the "library" record by pubkey.

  • fileSync materialized BOTH onto disk — app files at root, library
    files under streamo/. The composed tree mirrors the URL hierarchy
    the relay would serve, so the IDE resolves \`./streamo/h.js\` from
    main.js because the file is physically there.

  • Editing a mounted path is read-only — the banner fires, fileSync
    immediately re-materializes from the upstream library record's bytes,
    your edit visibly disappears. The library record's chain is not
    touched; you can't write to bytes you don't own.

  • To play with it:
      ${outDir}
    Edit main.js (your own) — it'll commit. Edit streamo/h.js — the
    banner will fire and the file reverts.

  cleanup:
      rm -rf ${outDir} ${dataDir}
`)
console.log(RULE)

await sub.unsubscribe()
process.exit(0)
