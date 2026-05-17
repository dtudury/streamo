#!/usr/bin/env node

import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { StreamoServer } from '../../streamo/StreamoServer.js'
import { bytesToHex } from '../../streamo/utils.js'

const envFile = process.argv.find((_, i) => process.argv[i - 1] === '--env-file')
if (envFile) config({ path: envFile })

const name       = process.env.STREAMO_NAME             ?? 'chat'
const username   = process.env.STREAMO_USERNAME
const password   = process.env.STREAMO_PASSWORD
const homeKeyEnv = process.env.STREAMO_HOME_KEY
const port       = +(process.env.STREAMO_WEB            ?? 8080)
const dataDir    = process.env.STREAMO_DATA_DIR         ?? '.streamo'
const keyIter    = +(process.env.STREAMO_KEY_ITERATIONS ?? 100000)

// Optional additional journalist pubkeys (comma-separated hex). The relay's
// own pubkey is always included automatically — these are the OTHER peers
// whose repos the homepage walks for journal entries. Configured per relay
// in .env.prod; for streamo.dev this is just Claude's pubkey for now.
const extraJournalists = (process.env.STREAMO_JOURNALISTS ?? process.env.STREAMO_CLAUDE_PUBKEY ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

// Two startup shapes, selected by env:
//   (a) credentials present  →  all-in-one: relay + seed + fileSync (legacy dev shape).
//   (b) STREAMO_HOME_KEY only → pure relay: open archive by pubkey, serve bytes,
//                                no seed, no fileSync. Bytes arrive via origin sync
//                                from an author process elsewhere.
// Both shapes ultimately call server.web() with the page-as-Repo middleware.
// The mode is logged so it's obvious in the output.
const isRelayOnly = !!homeKeyEnv && !username

let server
if (isRelayOnly) {
  server = await StreamoServer.create({
    publicKeyHex:  homeKeyEnv,
    dataDir,
    keyIterations: keyIter,
  })
  console.log(`[chat] mode: relay-only (no signer)`)
  console.log(`[chat] home key:    ${server.publicKeyHex}`)
} else {
  if (!username || password == null) {
    console.error(`
chat/server.js needs either:
  - STREAMO_HOME_KEY (relay-only — opens repo by pubkey, no signer)
  - or STREAMO_USERNAME + STREAMO_PASSWORD (all-in-one — derives signer, runs seed + fileSync)
`)
    process.exit(1)
  }
  server = await StreamoServer.create({ name, username, password, dataDir, keyIterations: keyIter })
  console.log(`[chat] mode: all-in-one (signer + seed + fileSync)`)
  console.log(`[chat] room key:    ${server.publicKeyHex}`)
}

console.log(`[chat] serving on http://localhost:${port}/apps/chat/`)

// Author-side work only happens when we have a signer. The seed step (which
// writes the journal entries + journalists list into the home repo) and the
// fileSync (which mirrors public/homepage/ to/from value.files) both
// require signing commits.
if (server.signer) {
  // The history repo: deterministic keypair from the same credentials, named
  // `streamo-history`. Seeded by `npm run seed-history`; opened here so it's
  // available in the registry for the WS sync to serve and added to the home
  // repo's `journalists` so cascade discovery finds it on connect.
  const historyKey = await server.signer.keysFor('streamo-history')
  const historyKeyHex = bytesToHex(historyKey.publicKey)
  const historyRepo = await server.registry.open(historyKeyHex)
  const historyCommits = [...historyRepo.history()].length
  console.log(`[chat] history key: ${historyKeyHex} (${historyCommits} commits)`)

  // Seed the primary repo with the journal — the home repo doubles as the
  // homepage's content source. Each future journal entry is a new commit on
  // this repo, and the homepage walks `entries` to render. The relay link
  // in the explorer points somewhere meaningful: the journal you just read
  // on the homepage.
  //
  // Note: no `members` seed. Chat-room membership is now discovered live
  // via the announce/interest layer (see `onAnnounce` replay in
  // registrySync.js) — no signed roster, no server-written list.
  const current = server.streamo.get() ?? {}
  const seed = { ...current }
  let needsCommit = false
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

  // Mirror the authored homepage at public/homepage/ to/from the home repo's
  // `files` key.  fileSync is bidirectional: edits on disk become commits,
  // commits become disk writes.
  const homepageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'homepage')
  await server.files(homepageDir, { filesKey: 'files' })
  console.log(`[chat] mirroring homepage: ${homepageDir} ↔ home.files`)
}

await server.web(port, {
  // serveFromRepo middleware reads the home repo's `files` key on every
  // request — any path present wins; misses fall through to express.static
  // so /apps/explorer/, /streamo/*.js, /apps/styles/*.css keep working.
  // In relay-only mode, an empty archive means everything falls through to
  // express.static (the bundled defaults) until an author pushes their bytes.
  serveRepoFiles: { repo: server.streamo, filesKey: 'files' }
})

// Hint for relay-only operators: if no author has connected, the homepage
// is being served from bundled defaults rather than the home repo.
if (isRelayOnly && server.streamo.byteLength === 0) {
  console.log(`[chat] archive is empty — homepage is served from bundled defaults until an author pushes bytes`)
  console.log(`[chat] author can connect with: npx @dtudury/streamo --name ${name} --username ... --password ... --files ./public/homepage --files-key files --origin localhost:${port}`)
}
