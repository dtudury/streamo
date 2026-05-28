#!/usr/bin/env node

import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFile, readdir } from 'fs/promises'
import { StreamoServer } from '../../streamo/StreamoServer.js'
import { Streamo } from '../../streamo/Streamo.js'
import { bytesToHex } from '../../streamo/utils.js'
import { buildTarotData } from '../../../scripts/tarot-data.js'
import { PushStore, pushRoutes, notifyOnMessages } from './push.js'

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
// Both shapes ultimately call server.web() with the page-as-StreamoRecord middleware.
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
  const historyRepo = await server.registry._materialize(historyKeyHex)
  const historyCommits = [...historyRepo.history()].length
  console.log(`[chat] history key: ${historyKeyHex} (${historyCommits} commits)`)

  // The tarot demo: a non-StreamoRecord Streamo. Deterministic key from the same
  // credentials, opened so the registry serves it like any other repo —
  // but seeded via repo.set() WITHOUT commit() or sign(). The byte stream
  // contains data chunks (Duples, OBJECTs, STRINGs, ARRAYs) but no
  // commit/signature records. Surfaces the explorer's no-head case
  // (at-view.js:104) and exercises the storage tab on real nested data.
  // Idempotent: only seeds if byteLength is 0.
  const tarotKey = await server.signer.keysFor('tarot')
  const tarotKeyHex = bytesToHex(tarotKey.publicKey)
  const tarotRepo = await server.registry._materialize(tarotKeyHex)
  if (tarotRepo.byteLength === 0) {
    // StreamoRecord.set() auto-commits (checkout → working.set → this.commit), which
    // we DON'T want — we want a no-commits Streamo. Bypass the StreamoRecord
    // override by calling Streamo's prototype set directly. This appends
    // data chunks to the byte stream without writing a commit record.
    Streamo.prototype.set.call(tarotRepo, buildTarotData())
    console.log(`[chat] tarot demo seeded (no commit): ${tarotRepo.byteLength} bytes`)
  }
  console.log(`[chat] tarot key: ${tarotKeyHex} (${tarotRepo.byteLength} bytes, ${[...tarotRepo.history()].length} commits)`)

  // Bundled flashcards decks: each JSON in public/apps/flashcards/decks/
  // becomes a signed StreamoRecord whose author is this relay's home identity.
  // Deterministic per-deck subkey via `flashcards-deck:<id>`. The home
  // repo's `flashcardsDecks` field will map id → pubkey-hex so the
  // client can discover them at runtime — no hardcoded addresses.
  const flashcardsDecksDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'flashcards', 'decks')
  const flashcardsDecks = {}
  try {
    const files = (await readdir(flashcardsDecksDir)).filter(f => f.endsWith('.json') && !f.startsWith('_'))
    for (const file of files) {
      const id = file.replace(/\.json$/, '')
      const content = JSON.parse(await readFile(join(flashcardsDecksDir, file), 'utf8'))
      const deckKey = await server.signer.keysFor(`flashcards-deck:${id}`)
      const deckKeyHex = bytesToHex(deckKey.publicKey)
      const deckRepo = await server.registry._materialize(deckKeyHex)
      deckRepo.attachSigner(server.signer, `flashcards-deck:${id}`)
      // Idempotent: only commit when content actually differs.
      if (JSON.stringify(deckRepo.get() ?? null) !== JSON.stringify(content)) {
        deckRepo.defaultMessage = `seed: ${content.title}`
        deckRepo.set(content)
        console.log(`[chat] flashcards: seeded ${id} → ${deckKeyHex}`)
      }
      flashcardsDecks[id] = deckKeyHex
    }
    console.log(`[chat] flashcards: ${Object.keys(flashcardsDecks).length} deck(s) ready`)
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(`[chat] flashcards: ${e.message}`)
  }

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
  const wantSet = new Set([server.publicKeyHex, historyKeyHex, ...extraJournalists])
  const missingJournalists = [...wantSet].filter(k => !seed.journalists.includes(k))
  const staleJournalists = seed.journalists.filter(k => !wantSet.has(k))
  if (missingJournalists.length || staleJournalists.length) {
    // Add anything in want-but-not-present; drop anything present-but-not-wanted.
    // Without the prune, removing a journalist from the env required manual
    // archive surgery — the seed logic only added, never removed.
    seed.journalists = [...seed.journalists.filter(k => wantSet.has(k)), ...missingJournalists]
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
  // Publish the bundled-deck address map on the home repo so the
  // flashcards client can discover what's served without hardcoding.
  if (JSON.stringify(seed.flashcardsDecks ?? {}) !== JSON.stringify(flashcardsDecks)) {
    seed.flashcardsDecks = flashcardsDecks
    needsCommit = true
  }
  if (needsCommit) {
    server.streamo.defaultMessage = seed.entries[seed.entries.length - 1].headline
    server.streamo.set(seed)
    console.log('[chat] initialized chat room + journal seed')
  }

  // Mirror the authored homepage at public/homepage/ to/from the home repo's
  // `files` key.  fileSync is bidirectional: edits on disk become commits,
  // commits become disk writes. `recordFile: 'streamo.json'` separates the
  // home Record's metadata (mounts, title, etc.) from the file tree so a
  // homepage's `mounts` table can be authored on disk as plain JSON.
  const homepageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'homepage')
  await server.files(homepageDir, { recordFile: 'streamo.json' })
  console.log(`[chat] mirroring homepage: ${homepageDir} ↔ home.files`)
}

// Watch subscription — when STREAMO_WATCH (or its deprecated alias
// STREAMO_PEER) is set, open a registrySync to that host. The
// followMounts: true cascade subscribes to every Record the host's
// home mounts reference, so bundled-app Records (library, chat,
// flashcards, explorer, styles, todomvc, shared-note) come alive
// locally without manual seeding. Canonical dev shape:
// STREAMO_WATCH=streamo.dev in .env.dev — a local relay that's a window
// onto production. Unset for production itself (no self-subscription).
// "Watch" rather than "peer" because streamo's per-record authority is
// asymmetric: each Record has one origin, so a relay is a subscriber to
// records the host originates, not a peer in the symmetric sense.
const watchHost = process.env.STREAMO_WATCH ?? process.env.STREAMO_PEER
if (watchHost) {
  console.log(`[chat] watch:       opening registrySync → ${watchHost}`)
  await server.watch(watchHost, {
    onConnectionChange: c => console.log(`[chat] watch ${watchHost}: ${c ? 'connected' : 'disconnected'}`)
  })
  console.log(`[chat] watch:       cascade subscribing to mounted records`)
}

// Web Push — the relay's subscription store, endpoints, and the watcher
// that fires a notification when a chat message lands. Stood up only when
// a full VAPID keypair is configured (.env STREAMO_VAPID_PUBLIC/_PRIVATE);
// a relay without one just runs without push.
let pushStore = null
let vapid = null
if (process.env.STREAMO_VAPID_PUBLIC && process.env.STREAMO_VAPID_PRIVATE) {
  pushStore = new PushStore(join(dataDir, 'push-subscriptions.json'))
  vapid = {
    publicKey: process.env.STREAMO_VAPID_PUBLIC,
    privateKey: process.env.STREAMO_VAPID_PRIVATE,
    subject: process.env.STREAMO_VAPID_SUBJECT ?? 'mailto:streamo@streamo.dev'
  }
  console.log(`[chat] web push: enabled (${pushStore.all().length} stored subscription(s))`)
} else {
  console.log('[chat] web push: off — set STREAMO_VAPID_PUBLIC/_PRIVATE to enable')
}

await server.web(port, {
  // serveFromRepo middleware reads the home repo's `value.files` first,
  // then walks its `mounts` table (longest-prefix match) recursively
  // through any subscribed Records the registry holds. No static-file
  // fallback — the 9.x architectural commitment is that every URL is
  // either a signed Record's content or a 404. /apps/chat/, /streamo/*.js,
  // /apps/styles/*.css work because the homepage's mounts route them to
  // bundled Records the relay has subscribed to.
  serveRepoFiles: { repo: server.streamo },
  routes: pushStore ? pushRoutes(pushStore, vapid.publicKey) : undefined
})

// Relay-side watcher: Web Push the subscribers when a fresh chat message lands.
if (pushStore) notifyOnMessages(server.registry, pushStore, vapid)

// Hint for relay-only operators: if no author has connected, the homepage
// is being served from bundled defaults rather than the home repo.
if (isRelayOnly && server.streamo.byteLength === 0) {
  console.log(`[chat] archive is empty — homepage is served from bundled defaults until an author pushes bytes`)
  console.log(`[chat] author can connect with: npx @dtudury/streamo --name ${name} --username ... --password ... --files ./public/homepage --origin localhost:${port}`)
}
