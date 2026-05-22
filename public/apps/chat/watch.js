#!/usr/bin/env node
/**
 * streamo chat watch — Claude's presence + reply-watcher for the chat room.
 *
 * notify.js posts and leaves; watch.js *stays*. Run as the `asyncRewake`
 * Stop hook, it does two jobs for the bounded-watcher notification model:
 *
 *   1. Presence. It announces Claude in the room for as long as it runs.
 *      A chat client renders Claude's dot green off that announce — so the
 *      dot IS the response window: green ⇔ this process is alive ⇔ a reply
 *      will reach the warm session. When watch.js exits, the announce
 *      drops and the dot grays.
 *
 *   2. Wake. It watches the room for a message from anyone but Claude. The
 *      moment one lands it prints the message and exits code 2 — the
 *      `asyncRewake` contract for "wake the model" — and the warm Claude
 *      Code session resumes with the reply as input.
 *
 * Either way it exits cleanly (reply → 2; window elapsed → 0), closing its
 * socket first so Claude's dot grays at once rather than after the ~20s
 * keep-alive timeout.
 *
 * Usage (as a hook, or by hand to test):
 *   node --env-file=.env.claude public/apps/chat/watch.js
 *
 * Environment (see .env.claude):
 *   STREAMO_CLAUDE_USERNAME / _PASSWORD   chat identity   (required)
 *   STREAMO_RELAY_HOST / _PORT            relay           (default localhost:8080)
 *   STREAMO_RELAY_SECURE                  "1" forces wss  (default: on iff port 443)
 *   STREAMO_WATCH_WINDOW_MS               how long to watch (default 1800000 = 30m)
 *
 * Exit codes: 2 reply detected (wake) · 0 window elapsed, no reply · 1 connect failure.
 */
import { Signer } from '../../streamo/Signer.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { bytesToHex } from '../../streamo/utils.js'

const username = process.env.STREAMO_CLAUDE_USERNAME
const password = process.env.STREAMO_CLAUDE_PASSWORD
const host = process.env.STREAMO_RELAY_HOST || 'localhost'
const port = Number(process.env.STREAMO_RELAY_PORT || '8080')
const secure = process.env.STREAMO_RELAY_SECURE === '1' || port === 443
const windowMs = Number(process.env.STREAMO_WATCH_WINDOW_MS || String(30 * 60 * 1000))
if (!username || !password) {
  console.error('watch.js: STREAMO_CLAUDE_USERNAME / STREAMO_CLAUDE_PASSWORD missing — pass --env-file=.env.claude')
  process.exit(1)
}

// armTime is the baseline: a "reply" is any message timestamped after this
// watcher started. v1 keeps the baseline this simple — a message David sent
// *during* my turn (before the watcher armed) is missed by this watcher;
// a persisted cursor would close that gap, filed as a later refinement.
const armTime = Date.now()

// Claude's chat identity — same derivation as notify.js and the web client.
const signer = new Signer(username, password, 1)
const { publicKey } = await signer.keysFor('chat')
const myKey = bytesToHex(publicKey)

// Root key — the announce topic the whole room shares.
const httpBase = `${secure ? 'https' : 'http'}://${host}:${port}`
let rootKey
try {
  const info = await fetch(`${httpBase}/api/info`).then(r => r.json())
  rootKey = info.primaryKeyHex ?? info.rootKey
} catch (e) {
  console.error(`watch.js: could not reach ${httpBase}/api/info — ${e.message}`)
  process.exit(1)
}

const registry = new RepoRegistry()
const session = await registrySync(registry, host, port, {
  secure,
  // Subscribe to everyone who announces, so their chat repo syncs and we
  // can watch it for a reply. (`session` is assigned by the time any
  // announce fires.)
  onAnnounce: (key) => { session.subscribe(key) }
})

// Announce Claude — this is the presence the chat dot reads. The wire has
// no "peer left" signal, so the dot works by staleness: we re-announce on
// a heartbeat, and the client greens Claude only while those keep landing.
// When watch.js exits, the heartbeat stops and the dot grays. The dot IS
// this process.
await session.subscribe(myKey)
session.interest(rootKey)
session.announce(myKey, rootKey)
setInterval(() => session.announce(myKey, rootKey), 10000)

// Clean shutdown: close the socket and give the close frame a beat to
// flush, so the relay drops the announce — and the dot grays — at once,
// instead of waiting out the keep-alive timeout.
async function finish (code) {
  try { session.close() } catch {}
  await new Promise(r => setTimeout(r, 150))
  process.exit(code)
}

// Every message from someone other than Claude, posted after we armed.
function repliesSinceArm () {
  const out = []
  for (const [keyHex, repo] of registry) {
    if (keyHex === myKey || keyHex === rootKey) continue
    const name = repo.get('name') || 'someone'
    for (const m of repo.get('messages') ?? []) {
      const at = +(m?.at ?? 0)
      if (at > armTime) {
        out.push({ at, name, text: typeof m === 'string' ? m : (m?.text ?? '') })
      }
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

// Poll once a second until a reply lands or the window elapses.
const deadline = armTime + windowMs
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 1000))
  const replies = repliesSinceArm()
  if (replies.length) {
    // stdout is the wake payload — appended after the hook's rewakeMessage
    // and shown to the warm session; exit 2 is the wake signal.
    for (const r of replies) console.log(`${r.name} (chat): ${r.text}`)
    await finish(2)
  }
}

// Window elapsed with no reply — exit cleanly so Claude's dot grays.
await finish(0)
