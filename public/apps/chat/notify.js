#!/usr/bin/env node
/**
 * streamo chat notify — post ONE message to the chat room, then exit.
 *
 * The non-interactive sibling of cli.js: where cli.js joins and stays,
 * notify.js joins, says one thing, waits for it to reach the relay, and
 * leaves. It's the keystone of the streamo-native notification channel —
 * Claude Code's Stop/Notification hooks call this to chime an open chat
 * tab.
 *
 * Usage:
 *   node --env-file=.env.claude public/apps/chat/notify.js "your message"
 *
 * Environment (see .env.claude):
 *   STREAMO_CLAUDE_USERNAME   chat-identity username   (required)
 *   STREAMO_CLAUDE_PASSWORD   chat-identity password   (required)
 *   STREAMO_RELAY_HOST        relay hostname           (default localhost)
 *   STREAMO_RELAY_PORT        relay port               (default 8080)
 *   STREAMO_RELAY_SECURE      "1" forces wss           (default: on iff port 443)
 *
 * Exit codes: 0 posted · 1 connect/push failure · 2 bad usage.
 */
import { Signer } from '../../streamo/Signer.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { bytesToHex } from '../../streamo/utils.js'

const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('usage: node --env-file=.env.claude notify.js "message"')
  process.exit(2)
}

const username = process.env.STREAMO_CLAUDE_USERNAME
const password = process.env.STREAMO_CLAUDE_PASSWORD
const host = process.env.STREAMO_RELAY_HOST || 'localhost'
const port = Number(process.env.STREAMO_RELAY_PORT || '8080')
const secure = process.env.STREAMO_RELAY_SECURE === '1' || port === 443
if (!username || !password) {
  console.error('notify.js: STREAMO_CLAUDE_USERNAME / STREAMO_CLAUDE_PASSWORD missing — pass --env-file=.env.claude')
  process.exit(2)
}

// No explicit "fully synced" signal exists, so treat a repo as settled
// once its byteLength has held still for `quietMs` — after a `minMs`
// floor that gives the relay's download time to even begin.
async function settle (read, { minMs = 0, quietMs = 600, capMs = 8000 } = {}) {
  const start = Date.now()
  let last = read()
  let lastChange = start
  while (Date.now() - start < capMs) {
    await new Promise(r => setTimeout(r, 120))
    const v = read()
    if (v !== last) { last = v; lastChange = Date.now() }
    if (Date.now() - lastChange >= quietMs && Date.now() - start >= minMs) return
  }
}

// Identity — same derivation as the chat web client (1 iteration).
const signer = new Signer(username, password, 1)
const { publicKey } = await signer.keysFor('chat')
const myKey = bytesToHex(publicKey)

// Root key — the relay's home repo, the shared announce topic.
const httpBase = `${secure ? 'https' : 'http'}://${host}:${port}`
let rootKey
try {
  const info = await fetch(`${httpBase}/api/info`).then(r => r.json())
  rootKey = info.primaryKeyHex ?? info.rootKey
} catch (e) {
  console.error(`notify.js: could not reach ${httpBase}/api/info — ${e.message}`)
  process.exit(1)
}

const registry = new RepoRegistry()
const session = await registrySync(registry, host, port, { secure })

// subscribe() opens my repo AND plumbs it to the wire, so the relay
// streams my history down. attachSigner makes the commit provably mine;
// announce lets any open chat tab discover me and start listening.
const myRepo = await session.subscribe(myKey)
myRepo.attachSigner(signer, 'chat')
session.interest(rootKey)
session.announce(myKey, rootKey)

// Wait for my history to finish arriving before appending — committing
// onto a stale (short) message list would push a divergent chain and
// the relay would reject it.
await settle(() => myRepo.byteLength, { minMs: 1500, quietMs: 600, capMs: 8000 })

const messages = myRepo.get('messages') ?? []
const preview = text.length > 50 ? text.slice(0, 50).trim() + '…' : text
myRepo.defaultMessage = `"${preview}" (notify)`
myRepo.set({ name: myRepo.get('name') ?? username, messages: [...messages, { text, at: new Date() }] })

// Give the push ~2s to travel up the WebSocket before we exit — there's
// no relay ack to wait on; pushRejected is the one failure signal.
await new Promise(r => setTimeout(r, 2000))
if (myRepo.pushRejected) {
  console.error('notify.js: relay rejected the push — chain diverged')
  process.exit(1)
}

console.log(`posted to chat as "${myRepo.get('name') ?? username}": ${preview}`)
session.close()
process.exit(0)
