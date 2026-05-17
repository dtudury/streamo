#!/usr/bin/env node

import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { StreamoServer } from '../../streamo/StreamoServer.js'
import { bytesToHex } from '../../streamo/utils.js'

const envFile = process.argv.find((_, i) => process.argv[i - 1] === '--env-file')
if (envFile) config({ path: envFile })

const name       = process.env.STREAMO_NAME             ?? 'chat'
const username   = process.env.STREAMO_USERNAME         ?? 'relay'
const password   = process.env.STREAMO_PASSWORD         ?? ''
const port       = +(process.env.STREAMO_WEB            ?? 8080)
const dataDir    = process.env.STREAMO_DATA_DIR         ?? '.streamo'
const keyIter    = +(process.env.STREAMO_KEY_ITERATIONS ?? 100000)

// Optional additional journalist pubkeys (comma-separated hex). The relay's
// own pubkey is always included automatically — these are the OTHER peers
// whose repos the homepage walks for journal entries. Configured per relay
// in .env.prod; for streamo.dev this is just Claude's pubkey for now.
const extraJournalists = (process.env.STREAMO_JOURNALISTS ?? process.env.STREAMO_CLAUDE_PUBKEY ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

const server = await StreamoServer.create({ name, username, password, dataDir, keyIterations: keyIter })

// The history repo: deterministic keypair from the same credentials, named
// `streamo-history`.  Seeded by `npm run seed-history`; opened here so it's
// available in the registry for the WS sync to serve and added to the home
// repo's `journalists` so cascade discovery finds it on connect.
const historyKey = await server.signer.keysFor('streamo-history')
const historyKeyHex = bytesToHex(historyKey.publicKey)
const historyRepo = await server.registry.open(historyKeyHex)
const historyCommits = [...historyRepo.history()].length
console.log(`[chat] room key:    ${server.publicKeyHex}`)
console.log(`[chat] history key: ${historyKeyHex} (${historyCommits} commits)`)
console.log(`[chat] serving on http://localhost:${port}/apps/chat/`)

// Seed the primary repo with the journal — the home repo doubles as the
// homepage's content source. Each future journal entry is a new commit on
// this repo, and the homepage walks `entries` to render. The relay link
// in the explorer points somewhere meaningful: the journal you just read
// on the homepage.
//
// Note: no `members` seed. Chat-room membership is now discovered live
// via the announce/interest layer (see `onAnnounce` replay in
// registrySync.js) — no signed roster, no server-written list.
{
  const current = server.streamo.get() ?? {}
  const seed = { ...current }
  let needsCommit = false
  // Journalists: peers whose repos the homepage walks for journal entries.
  // The relay's own pubkey is always included; STREAMO_JOURNALISTS adds
  // others (Claude, future contributors). Idempotent — we only append.
  if (!Array.isArray(seed.journalists)) { seed.journalists = []; needsCommit = true }
  const wantJournalists = [server.publicKeyHex, historyKeyHex, ...extraJournalists]
  const missingJournalists = wantJournalists.filter(k => !seed.journalists.includes(k))
  if (missingJournalists.length) {
    seed.journalists = [...seed.journalists, ...missingJournalists]
    needsCommit = true
  }
  if (!Array.isArray(seed.entries) || seed.entries.length === 0) {
    seed.entries = [{
      headline: 'running streamo',
      body: 'this is the streamo journal. each entry is a signed commit on this repo; the homepage walks them and the relay link in the explorer leads here. append-only history made visible.',
      at: new Date()
    }]
    needsCommit = true
  }
  if (needsCommit) {
    server.streamo.defaultMessage = seed.entries[seed.entries.length - 1].headline
    server.streamo.set(seed)
    console.log('[chat] initialized chat room + journal seed')
  }
}

// Mirror the authored homepage at public/homepage/ to/from the home repo's
// `files` key.  fileSync is bidirectional: edits on disk become commits,
// commits become disk writes.  The home repo now multiplexes three
// concerns on one stream — chat bookkeeping, journal entries, and the
// homepage's served bytes — and consumers route via object paths.
const homepageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'homepage')
await server.files(homepageDir, { filesKey: 'files' })
console.log(`[chat] mirroring homepage: ${homepageDir} ↔ home.files`)

await server.web(port, {
  // serveFromRepo middleware reads the home repo's `files` key on every
  // request — any path present wins; misses fall through to express.static
  // so /apps/explorer/, /streamo/*.js, /apps/styles/*.css keep working.
  serveRepoFiles: { repo: server.streamo, filesKey: 'files' }
  // No onAnnounce handler: the relay no longer writes membership into a
  // signed roster. Peers discover each other via the announce/interest
  // ephemeral layer (with server-side replay for newcomers), and the
  // chat client builds its member view locally from announces.
})
