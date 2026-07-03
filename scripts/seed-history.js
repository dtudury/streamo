#!/usr/bin/env node
/**
 * @file seed-history — replay `git log --first-parent --reverse` into a
 * streamo, one file-tree-per-commit via FolderRecord.writeMany.
 *
 * Flags:
 *   --limit N                 stop after N commits
 *   --shard <prefix>          repeatable; inject a synthetic top-level
 *                             mounts.json declaring `<prefix>` as ours:true
 *   --mounts-only             home Record holds only mounts.json;
 *                             non-shard-routed root files get DROPPED
 *   --env-file <path>         sourced before reading STREAMO_* env vars
 *
 * Env: STREAMO_USERNAME / STREAMO_PASSWORD / STREAMO_DATA_DIR /
 *      STREAMO_KEY_ITERATIONS / STREAMO_HISTORY_NAME (default 'streamo-history').
 *
 * Traps to know:
 *   - Idempotency matches by (message, date) — brittle if the repo has
 *     duplicate commit messages at the same second. Full sha verification
 *     would need a metadata sidecar file per commit; not built.
 *   - writeMany reads mounts() from the record's PRE-commit state, so the
 *     commit that first lands mounts.json goes entirely to home; routing
 *     kicks in one commit later. With --shard, that means commit 0 is the
 *     lag commit.
 *   - StreamoServer.create doesn't honor a `dataDir` kwarg — it hardcodes
 *     `.streamo`. Passing tiers explicitly is the workaround.
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

const mountsOnly = args.includes('--mounts-only')
if (mountsOnly) args.splice(args.indexOf('--mounts-only'), 1)

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

// ASCII control chars as separators; safe because they don't appear in
// commit metadata or bodies.
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

// ─── blob + tree reads ───────────────────────────────────────────────

// Blobs are content-addressed, so the same sha across commits is the
// same bytes. Cache aggressively.
const blobCache = new Map()
function readBlob (sha) {
  if (blobCache.has(sha)) return blobCache.get(sha)
  const buf = execSync(`git cat-file blob ${sha}`, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  // .slice() detaches from Node's internal Buffer pool.
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice()
  blobCache.set(sha, u8)
  return u8
}

function fileTreeAt (commitSha) {
  const raw = execSync(`git ls-tree -r ${commitSha}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const files = {}
  for (const line of raw.split('\n')) {
    if (!line) continue
    // <mode> <type> <blob-sha>\t<path>
    const tabIdx = line.indexOf('\t')
    if (tabIdx === -1) continue
    const meta = line.slice(0, tabIdx).split(' ')
    if (meta.length < 3) continue
    const [_mode, type, blobSha] = meta
    if (type !== 'blob') continue  // skip submodules
    files[line.slice(tabIdx + 1)] = readBlob(blobSha)
  }
  return files
}

// ─── open the streamo, build the folder lens ─────────────────────────

// tiers passed explicitly — StreamoServer.create silently drops `dataDir`.
const server = await StreamoServer.create({
  name, username, password, keyIterations: keyIter,
  tiers: [new DiskTier({ dir: dataDir, capacity: Infinity })]
})
console.log(`[seed-history] history repo: ${server.publicKeyHex}  (name: ${name})`)

const folderLens = new FolderRecord(server.streamo, server.registry, {
  signer: server.signer,
  signerName: name,
})

// Precompute the synthetic mounts.json (same for every commit). Each shard
// pubkey must be markWritable'd BEFORE any writeMany that touches it —
// the factory's Writable-decision is cached at first _materialize.
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

// ─── idempotency ─────────────────────────────────────────────────────

const existing = [...server.streamo.history()].reverse()
console.log(`[seed-history] streamo: ${existing.length} home commits already present`)

for (let i = 0; i < existing.length; i++) {
  const s = existing[i]
  const g = gitCommits[i]
  if (!g) {
    console.error(`[seed-history] streamo has ${existing.length} commits but git only has ${gitCommits.length} — chain ahead of git (rebase / force-push / rewritten history).`)
    console.error('  recovery: delete the archive and re-run.')
    process.exit(3)
  }
  if (s.message !== g.subject || Math.abs(s.date.getTime() - g.date.getTime()) > 500) {
    console.error(`[seed-history] divergence at index ${i}:`)
    console.error(`  streamo: "${s.message?.slice(0, 60)}" @ ${s.date.toISOString()}`)
    console.error(`  git:     "${g.subject?.slice(0, 60)}" @ ${g.date.toISOString()}`)
    console.error('  recovery: delete the archive and re-run.')
    process.exit(3)
  }
}

// ─── append new commits ──────────────────────────────────────────────

let appended = 0
let mountsSeen = false
const start = Date.now()

for (let i = existing.length; i < gitCommits.length; i++) {
  const g = gitCommits[i]
  const tree = fileTreeAt(g.sha)
  // JS object, not bytes — FolderRecord.mounts() ignores Uint8Array values.
  if (syntheticMountsFile) tree['mounts.json'] = syntheticMountsFile
  if ('mounts.json' in tree && !mountsSeen) {
    console.log(`[seed-history] mounts.json seen at commit ${i} — routing kicks in from commit ${i + 1}`)
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
for (const [_key, repo] of server.registry) {
  if (repo === server.streamo) continue
  if (typeof repo.attachSigner === 'function' && repo.byteLength > 0) {
    await waitSigned(repo)
  }
}
console.log(`done (${((Date.now() - signStart) / 1000).toFixed(1)}s)`)

const shardMounts = folderLens.mounts()
if (Object.keys(shardMounts).length > 0) {
  console.log('[seed-history] shard chain lengths:')
  for (const [prefix, mount] of Object.entries(shardMounts)) {
    if (!mount?.ours) continue
    const shard = server.registry.get(mount.key)
    if (!shard) { console.log(`  ${prefix}: (not materialized)`); continue }
    console.log(`  ${prefix}: ${[...shard.history()].length} commits  (${shard.publicKeyHex.slice(0, 16)}…)`)
  }
}

await server.close()
console.log('[seed-history] done.')
process.exit(0)
