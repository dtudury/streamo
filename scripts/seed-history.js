#!/usr/bin/env node
/**
 * @file seed-history — replay the project's git log into a streamo, with
 * per-shard chains for anything mounts.json routes.
 *
 * Each git commit's FULL file tree is authored via `FolderRecord.writeMany`.
 * writeMany reads mounts.json from the record's CURRENT state, splits the
 * incoming files map by longest-prefix mount match, and:
 *   - files NOT under any mount go into the home Record as commit N
 *   - files under `ours: true` mounts route into shard child Records
 *     (signer.keysFor(homeName + '/' + mountPrefix)); each shard grows
 *     its own chain of commits, one per git commit that touched files
 *     under that prefix
 *   - git commits that don't touch a shard's files leave that shard's
 *     chain alone (writeMany skips empty shard batches)
 *
 * Before mounts.json exists in the tree: no mounts, everything lands on
 * the home Record — pre-shard history stays one big chain. The commit
 * that ADDS mounts.json goes to home (mounts() is read from the record
 * BEFORE the commit lands, so shard routing kicks in one commit later).
 * From then on, shards start collecting.
 *
 * Idempotent (looser than the pre-shard version): walks the home Record's
 * existing chain and matches by (message, date) against git commits. If
 * the existing prefix matches, appends only the tail. Divergence aborts
 * loudly. Full sha verification is possible via a metadata sidecar if the
 * looser check turns out to be too soft — hasn't bit us yet.
 *
 * Walks `git log --first-parent --reverse` only — the streamo's commit
 * chain is linear, so merges collapse to their first-parent lineage.
 *
 * Usage:
 *   npm run seed-history
 *   npm run seed-history -- --env-file .env.dev
 *   npm run seed-history -- --limit 50           # first 50 commits only
 *
 * Reads STREAMO_USERNAME / STREAMO_PASSWORD / STREAMO_DATA_DIR /
 * STREAMO_KEY_ITERATIONS from env (or the --env-file). The history
 * repo is signed with `signer.keysFor('streamo-history')` — the same
 * relay credentials, different key namespace.
 */
import { config } from 'dotenv'
import { execSync } from 'child_process'
import { StreamoServer } from '../public/streamo/StreamoServer.js'
import { FolderRecord } from '../public/streamo/FolderRecord.js'
import { DiskTier } from '../public/streamo/StorageTier.js'
import { bytesToHex } from '../public/streamo/utils.js'

const args = process.argv.slice(2)
const envFileIdx = args.indexOf('--env-file')
if (envFileIdx !== -1) {
  config({ path: args[envFileIdx + 1] })
  args.splice(envFileIdx, 2)
}
const limitIdx = args.indexOf('--limit')
const limit = limitIdx !== -1 ? +args[limitIdx + 1] : Infinity
if (limitIdx !== -1) args.splice(limitIdx, 2)

// --mounts-only: passes through to FolderRecord.writeMany so the home
// Record's value ends up holding ONLY the injected mounts.json —
// non-shard-routed root files (LICENSE, README.md, package.json, etc.)
// get DROPPED. Enforces the lightweight-outermost shape at the cost of
// losing content that isn't under a --shard prefix. Use additional
// --shard flags to route the content you want to preserve.
const mountsOnly = args.includes('--mounts-only')
if (mountsOnly) args.splice(args.indexOf('--mounts-only'), 1)

// --shard <prefix> (repeatable): inject a synthetic top-level `mounts.json`
// into each committed tree declaring the given prefix as an ours:true shard.
// Files under the prefix route into a per-shard child Record (its own chain
// of commits); the mounts table lives in the home Record's value. Since
// most repos DON'T have a top-level mounts.json in their git history but
// we still want to shard their content, this is the "pretend it exists"
// hatch — the archive we produce has the sharded shape.
//
// One-commit lag caveat: writeMany reads mounts() from the record's
// pre-commit state, so the FIRST commit lands everything (including the
// synthetic mounts.json) on home; from commit 2 onward, routing kicks in.
// Fine in practice: commit 1 is usually trivially small ("Initial commit").
const shardPrefixes = []
while (true) {
  const idx = args.indexOf('--shard')
  if (idx === -1) break
  shardPrefixes.push(args[idx + 1])
  args.splice(idx, 2)
}

const username = process.env.STREAMO_USERNAME ?? 'relay'
const password = process.env.STREAMO_PASSWORD ?? ''
const dataDir  = process.env.STREAMO_DATA_DIR ?? '.streamo'
const keyIter  = +(process.env.STREAMO_KEY_ITERATIONS ?? 100000)
const name     = process.env.STREAMO_HISTORY_NAME ?? 'streamo-history'

if (!password) {
  console.error('STREAMO_PASSWORD is required (set via --env-file or environment)')
  process.exit(2)
}

// ─── git log ─────────────────────────────────────────────────────────
const FIELD  = '\x1e'
const RECORD = '\x1f'
const fmt    = `%H${FIELD}%ct${FIELD}%an${FIELD}%ae${FIELD}%B${RECORD}`

console.log('[seed-history] reading git log…')
const rawLog = execSync(
  ['git', 'log', '--first-parent', '--reverse', `--pretty=format:${fmt}`].join(' '),
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: '/bin/sh' }
)

const gitCommits = rawLog.split(RECORD).map(r => r.replace(/^\n/, '')).filter(r => r.length > 0).map(r => {
  const parts = r.split(FIELD)
  if (parts.length < 5) {
    console.error(`[seed-history] malformed record (${parts.length} fields):`, JSON.stringify(r.slice(0, 200)))
    process.exit(5)
  }
  const [sha, ct, authorName, authorEmail, ...rest] = parts
  const body = rest.join(FIELD).replace(/\n+$/, '')
  const firstNL = body.indexOf('\n')
  const subject = firstNL === -1 ? body : body.slice(0, firstNL)
  return {
    sha,
    date: new Date(+ct * 1000),
    author: { name: authorName, email: authorEmail },
    subject: subject || '(no message)',
    body,
  }
}).slice(0, limit)

console.log(`[seed-history] git: ${gitCommits.length} commits on first-parent trunk${limit !== Infinity ? ` (--limit ${limit})` : ''}`)

// ─── blob cache ──────────────────────────────────────────────────────
// git blobs are content-addressed; the same sha across commits = same bytes.
// Cache once, reuse forever. Massive speedup when only a few files change
// per commit.
const blobCache = new Map()
function readBlob (sha) {
  if (blobCache.has(sha)) return blobCache.get(sha)
  const buf = execSync(`git cat-file blob ${sha}`, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  // Store as Uint8Array (Buffer is a Uint8Array subclass; slicing to a fresh
  // Uint8Array detaches from Node's internal pool).
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice()
  blobCache.set(sha, u8)
  return u8
}

// Fetch full file tree at a git commit as { path: Uint8Array }.
function fileTreeAt (commitSha) {
  const raw = execSync(`git ls-tree -r ${commitSha}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const files = {}
  for (const line of raw.split('\n')) {
    if (!line) continue
    // format: <mode> <type> <blob-sha>\t<path>
    const tabIdx = line.indexOf('\t')
    if (tabIdx === -1) continue
    const meta = line.slice(0, tabIdx).split(' ')
    if (meta.length < 3) continue
    const [_mode, type, blobSha] = meta
    if (type !== 'blob') continue  // skip submodules (commit), symlinks handled as blobs
    const path = line.slice(tabIdx + 1)
    files[path] = readBlob(blobSha)
  }
  return files
}

// ─── open the streamo, build the folder lens ─────────────────────────
// StreamoServer.create's default tier is `new DiskTier({dir: '.streamo'})` —
// it does not honor a `dataDir` argument (silently ignored). Pass tiers
// explicitly so STREAMO_DATA_DIR actually routes to the right archive.
const server = await StreamoServer.create({
  name, username, password, keyIterations: keyIter,
  tiers: [new DiskTier({ dir: dataDir, capacity: Infinity })]
})
console.log(`[seed-history] history repo: ${server.publicKeyHex}  (name: ${name})`)

const folderLens = new FolderRecord(server.streamo, server.registry, {
  signer: server.signer,
  signerName: name,
})

// Precompute the synthetic mounts.json for injection (once — same for
// every commit). Key derivation matches FolderRecord.writeMany's:
// signer.keysFor(signerName + '/' + mountPrefix). markWritable each
// shard pubkey so the registry factory returns a WritableStreamoRecord
// when writeMany materializes it — otherwise writeMany would throw
// "mounted Record for '<prefix>' is not Writable".
let syntheticMountsFile = null
if (shardPrefixes.length > 0) {
  const mounts = {}
  for (const prefix of shardPrefixes) {
    const childName = name + '/' + prefix
    const { publicKey } = await server.signer.keysFor(childName)
    const childHex = bytesToHex(publicKey)
    mounts[prefix] = { ours: true, key: childHex }
    server.markWritable(childHex)
    console.log(`[seed-history] shard: ${prefix} → ${childHex.slice(0, 16)}… (child stream name: ${childName})`)
  }
  syntheticMountsFile = { mounts }
}

// ─── idempotency: match existing home commits by (message, date) ─────
const existing = [...server.streamo.history()].reverse()
console.log(`[seed-history] streamo: ${existing.length} home commits already present`)

for (let i = 0; i < existing.length; i++) {
  const s = existing[i]
  const g = gitCommits[i]
  if (!g) {
    console.error(`[seed-history] streamo has ${existing.length} commits but git only has ${gitCommits.length} — chain is ahead of git (rebase? force-push? rewritten history?).`)
    console.error('  manual recovery: delete the streamo-history archive and re-run.')
    process.exit(3)
  }
  if (s.message !== g.subject || Math.abs(s.date.getTime() - g.date.getTime()) > 500) {
    console.error(`[seed-history] divergence at index ${i}:`)
    console.error(`  streamo: "${s.message?.slice(0, 60)}" @ ${s.date.toISOString()}`)
    console.error(`  git:     "${g.subject?.slice(0, 60)}" @ ${g.date.toISOString()}`)
    console.error('  manual recovery: delete the streamo-history archive and re-run.')
    process.exit(3)
  }
}

// ─── append new commits ────────────────────────────────────────────────
let appended = 0
let mountsSeen = false
const start = Date.now()

for (let i = existing.length; i < gitCommits.length; i++) {
  const g = gitCommits[i]
  const tree = fileTreeAt(g.sha)
  // Inject the synthetic mounts.json (as a JS object, not bytes — writeMany
  // reads it via record.get() which returns the parsed value; a Uint8Array
  // would be ignored by FolderRecord.mounts()).
  if (syntheticMountsFile) tree['mounts.json'] = syntheticMountsFile
  const hasMounts = 'mounts.json' in tree
  if (hasMounts && !mountsSeen) {
    if (syntheticMountsFile) {
      console.log(`[seed-history] shard routing active starting from commit ${i} (one-lag from ${i + 1})`)
    } else {
      console.log(`[seed-history] commit ${i} (${g.sha.slice(0, 8)}) introduces mounts.json — shard routing kicks in on the NEXT commit`)
    }
    mountsSeen = true
  }
  await folderLens.writeMany(tree, { replace: true, message: g.subject, date: g.date, mountsOnly })
  appended++
  if (appended % 25 === 0 || i === gitCommits.length - 1) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    process.stdout.write(`\r[seed-history] appended ${appended} / ${gitCommits.length - existing.length}  (${elapsed}s, blob-cache: ${blobCache.size})    `)
  }
}
process.stdout.write('\n')

console.log(`[seed-history] appended ${appended} new commits (${gitCommits.length} total)`)

// ─── wait for signing across home + all shards, then close ───────────
process.stdout.write('[seed-history] waiting for signing… ')
const signStart = Date.now()
async function waitSigned (repo) {
  while (repo.signedLength < repo.byteLength) {
    if (Date.now() - signStart > 60_000) {
      console.error(`\n[seed-history] timeout waiting for signing on ${repo.publicKeyHex?.slice(0, 16)}…`)
      process.exit(4)
    }
    await new Promise(r => setTimeout(r, 50))
  }
}
await waitSigned(server.streamo)
// Sign each shard the registry has materialized (writeMany populated them
// via _materialize + attachSigner).
for (const [_key, repo] of server.registry) {
  if (repo === server.streamo) continue
  if (typeof repo.attachSigner === 'function' && repo.byteLength > 0) {
    await waitSigned(repo)
  }
}
console.log(`done (${((Date.now() - signStart) / 1000).toFixed(1)}s)`)

// ─── report shard chain lengths ──────────────────────────────────────
const shardMounts = folderLens.mounts()
if (Object.keys(shardMounts).length > 0) {
  console.log('[seed-history] shard chain lengths:')
  for (const [prefix, mount] of Object.entries(shardMounts)) {
    if (!mount?.ours) continue
    const shard = server.registry.get(mount.key)
    if (!shard) {
      console.log(`  ${prefix}: (not materialized)`)
      continue
    }
    const chainLen = [...shard.history()].length
    console.log(`  ${prefix}: ${chainLen} commits  (${shard.publicKeyHex.slice(0, 16)}…)`)
  }
}

await server.close()
console.log('[seed-history] done.')
process.exit(0)
