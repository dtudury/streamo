#!/usr/bin/env node
/**
 * @file seed-history — replay the project's git log into a streamo.
 *
 * Builds (or extends) a `streamo-history` repo whose commit chain
 * mirrors the git log.  Each git commit becomes a streamo commit:
 *   - message:     git subject (first line)
 *   - date:        git committer date (back-stamped via commit options.date)
 *   - dataAddress: points to { sha, tree, parents, author, body }
 *
 * Idempotent: walks existing streamo commits oldest-first, verifies
 * they match the first N git commits by sha, then appends only the
 * tail.  Safe to re-run after new git commits land.
 *
 * Aborts loudly if the existing chain diverges from git (e.g. after a
 * force-push / rebase) — manual archive deletion is the recovery.
 *
 * Walks `git log --first-parent --reverse` only — the streamo's
 * commit chain is linear, so merges collapse to their first-parent
 * lineage on this side.  Original git parents are preserved inside
 * each commit's value for downstream inspection.
 *
 * Usage:
 *   npm run seed-history
 *   npm run seed-history -- --env-file .env.dev
 *
 * Reads STREAMO_USERNAME / STREAMO_PASSWORD / STREAMO_DATA_DIR /
 * STREAMO_KEY_ITERATIONS from env (or the --env-file).  The history
 * repo is signed with `signer.keysFor('streamo-history')` — the same
 * relay credentials, different key namespace.
 */
import { config } from 'dotenv'
import { execSync } from 'child_process'
import { StreamoServer } from '../public/streamo/StreamoServer.js'

// --env-file handling, same convention as the chat server.
const args = process.argv.slice(2)
const envFileIdx = args.indexOf('--env-file')
if (envFileIdx !== -1) {
  config({ path: args[envFileIdx + 1] })
  args.splice(envFileIdx, 2)
}

const username = process.env.STREAMO_USERNAME ?? 'relay'
const password = process.env.STREAMO_PASSWORD ?? ''
const dataDir  = process.env.STREAMO_DATA_DIR ?? '.streamo'
const keyIter  = +(process.env.STREAMO_KEY_ITERATIONS ?? 100000)

if (!password) {
  console.error('STREAMO_PASSWORD is required (set via --env-file or environment)')
  process.exit(2)
}

// Field/record separators that can't appear in commit metadata.  We
// could pipe per-line and lean on `--no-color` etc, but commit bodies
// can contain anything — these ASCII control chars are the safest
// boundary.
const FIELD  = '\x1e'
const RECORD = '\x1f'
const fmt    = `%H${FIELD}%T${FIELD}%P${FIELD}%ct${FIELD}%an${FIELD}%ae${FIELD}%B${RECORD}`

console.log('[seed-history] reading git log…')
// Pass the format via argv (not a sub-shell string) so the bytes are
// preserved exactly — control chars survive without shell escaping
// complications.
const raw = execSync(
  ['git', 'log', '--first-parent', '--reverse', `--pretty=format:${fmt}`].join(' '),
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: '/bin/sh' }
)

const gitCommits = raw.split(RECORD).map(r => {
  // Each record after the first has a leading newline (from the previous
  // record's trailing newline post-%B); the very first record doesn't.
  return r.replace(/^\n/, '')
}).filter(r => r.length > 0).map(r => {
  // %B (body) may itself contain FIELD chars in degenerate cases; the
  // separator chars I chose (\x1e \x1f) are extremely unlikely in commit
  // text but be defensive: split into the 6 fixed fields, join the rest.
  const parts = r.split(FIELD)
  if (parts.length < 7) {
    console.error(`[seed-history] malformed record (${parts.length} fields):`)
    console.error(JSON.stringify(r.slice(0, 200)))
    process.exit(5)
  }
  const [sha, tree, parents, ct, authorName, authorEmail, ...rest] = parts
  const body = rest.join(FIELD).replace(/\n+$/, '')
  const firstNL = body.indexOf('\n')
  const subject = firstNL === -1 ? body : body.slice(0, firstNL)
  return {
    sha,
    tree,
    parents: parents.split(' ').filter(Boolean),
    date: new Date(+ct * 1000),
    author: { name: authorName, email: authorEmail },
    subject,
    body
  }
})

console.log(`[seed-history] git: ${gitCommits.length} commits on first-parent trunk`)

// Open (or create) the history repo using the same relay credentials
// but a different name → different keypair.
const server = await StreamoServer.create({
  name: 'streamo-history',
  username,
  password,
  dataDir,
  keyIterations: keyIter,
})

console.log(`[seed-history] history repo: ${server.publicKeyHex}`)

// Walk existing streamo commits oldest-first to find where we are.
const existing = [...server.streamo.history()].reverse()
console.log(`[seed-history] streamo: ${existing.length} commits already present`)

// Verify the existing prefix matches git's first N commits by sha.
for (let i = 0; i < existing.length; i++) {
  const sValue = server.streamo.decode(existing[i].dataAddress)
  const g = gitCommits[i]
  if (!g || sValue.sha !== g.sha) {
    console.error(`[seed-history] divergence at index ${i}:`)
    console.error(`  streamo: ${sValue.sha?.slice(0, 8)}… "${existing[i].message?.slice(0, 60)}"`)
    console.error(`  git:     ${g?.sha?.slice(0, 8)}… "${g?.subject?.slice(0, 60)}"`)
    console.error('  manual recovery: delete the streamo-history archive and re-run.')
    process.exit(3)
  }
}

let appended = 0
for (let i = existing.length; i < gitCommits.length; i++) {
  const g = gitCommits[i]
  const working = server.streamo.checkout()
  working.set({
    sha:     g.sha,
    tree:    g.tree,
    parents: g.parents,
    author:  g.author,
    body:    g.body,
  })
  server.streamo.commit(working, g.subject, { date: g.date })
  appended++
}

console.log(`[seed-history] appended ${appended} new commits (total: ${gitCommits.length})`)

// Wait for auto-sign to cover all new commits, then a brief moment for
// archiveSync's writer to flush.  Auto-signing is batched: at most one
// sign in flight, with the trailing-pending bit guaranteeing one more
// after.  signedLength === byteLength when all commits are covered.
process.stdout.write('[seed-history] waiting for signing… ')
const start = Date.now()
while (server.streamo.signedLength < server.streamo.byteLength) {
  if (Date.now() - start > 30_000) {
    console.error('\n[seed-history] timeout waiting for signing')
    process.exit(4)
  }
  await new Promise(r => setTimeout(r, 50))
}
console.log(`done (${((Date.now() - start) / 1000).toFixed(1)}s)`)

// Close the streamo and let archiveSync drain. Signals end-of-stream
// to the writer loop, which finishes whatever's in the pipe and closes
// the file handle. Replaces a 500ms `setTimeout` that was guessing
// instead of asking — without it, `process.exit(0)` would tear down
// the process mid-write and drop in-flight chunks (typically the SIG
// tail, which makes the loaded `.bin` look complete but actually be
// staged-forever-no-SIG on the next reader).
await server.close()

console.log('[seed-history] done.')
process.exit(0)
