#!/usr/bin/env node
/**
 * @file sync-all — subscribe to a Record + follow the mount cascade,
 *   wait for the whole reachable tree to caught-up-to-relay, exit.
 *
 * The single-command "pull every Record reachable from this root" verb.
 * registrySync + followMounts already does the work; this just adds the
 * settle-and-exit detection so a one-shot caller knows when "done."
 *
 * Usage:
 *   node scripts/sync-all.mjs <rootPubkey> <feedUrl>
 *
 * Examples:
 *   node scripts/sync-all.mjs \
 *     02766553da17474eb9c90d4cf63bbcde8c1d9d1d8c50fa086e9890bd9560c58263 \
 *     wss://streamo.dev
 */
import { StreamoRecordRegistry } from '../public/streamo/StreamoRecordRegistry.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { registrySync } from '../public/streamo/registrySync.js'

const [rootKey, feedUrl] = process.argv.slice(2)
if (!rootKey || !feedUrl) {
  console.error('usage: sync-all.mjs <rootPubkey> <feedUrl>')
  process.exit(2)
}

const STABLE_MS = 2000   // no new subscriptions for this long → settled
const CHECK_MS  = 250
const PER_RECORD_TIMEOUT_MS = 30000

const recaller = new Recaller('sync-all')
const registry = new StreamoRecordRegistry({ recaller })

console.error(`[sync-all] connecting to ${feedUrl}`)
const session = await registrySync(registry, feedUrl, {
  followMounts: true,
  follow: (keyHex, repo, subscribe) => {
    // If a Record carries members/journalists/decks/etc. as separate
    // top-level .json files in flat shape, walk those as additional
    // subscription targets too. Keeps memory/bubbles/etc. cascade-discoverable
    // even when they're not in a mounts table.
    const journalists = repo.get('journalists.json')
    if (Array.isArray(journalists)) for (const k of journalists) subscribe(k)
    const members = repo.get('members.json')
    if (Array.isArray(members)) for (const k of members) subscribe(k)
    const decks = repo.get('flashcardsDecks.json')
    if (decks && typeof decks === 'object') for (const k of Object.values(decks)) subscribe(k)
  }
})

await session.subscribe(rootKey)
console.error(`[sync-all] subscribed to root ${rootKey.slice(0, 12)}…`)

// Wait for the subscription set to stabilize (no new keys for STABLE_MS).
let lastSize = -1
let stableSince = Date.now()
while (Date.now() - stableSince < STABLE_MS) {
  await new Promise(r => setTimeout(r, CHECK_MS))
  const size = [...registry].length
  if (size !== lastSize) {
    console.error(`[sync-all] subscribed: ${size}`)
    lastSize = size
    stableSince = Date.now()
  }
}

// Wait for every subscribed Record to be caughtUpToRelay (bounded).
const entries = [...registry]
console.error(`[sync-all] waiting for ${entries.length} Records to catch up`)
for (const [key, repo] of entries) {
  if (repo.caughtUpToRelay) continue
  try {
    await Promise.race([
      repo.recaller.when(() => repo.caughtUpToRelay, { name: `sync-all:caughtUp:${key.slice(0,8)}` }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PER_RECORD_TIMEOUT_MS))
    ])
  } catch (e) {
    console.error(`[sync-all] ${key.slice(0, 12)}… didn't catch up (${e.message})`)
  }
}

// Report.
console.log(`[sync-all] done — ${entries.length} Records reachable from ${rootKey.slice(0, 12)}…`)
for (const [key, repo] of entries) {
  const caughtUp = repo.caughtUpToRelay ? '✓' : '✗'
  const bytes = repo.byteLength
  console.log(`  ${caughtUp} ${key}  (${bytes.toLocaleString()} bytes)`)
}

session.close()
