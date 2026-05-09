#!/usr/bin/env node
/**
 * streamo chat CLI
 *
 * Usage:
 *   node public/streamo/chat-cli.js [username] [password] [host] [port]
 *
 * Joins the chat room, prints incoming messages, and reads outgoing messages
 * from stdin (one line = one message).
 *
 * Example for Claude to join and help debug:
 *   node public/streamo/chat-cli.js claude claude localhost 8080
 */
import readline from 'node:readline'
import { Signer } from './Signer.js'
import { RepoRegistry } from './RepoRegistry.js'
import { registrySync } from './registrySync.js'
import { bytesToHex } from './utils.js'

const [,, username = 'claude', password = 'claude', host = 'localhost', portStr = '8080'] = process.argv
const port = Number(portStr)

// Derive identity from username + password (1 iteration = fast for dev)
const signer = new Signer(username, password, 1)
const { publicKey } = await signer.keysFor('chat')
const myKey = bytesToHex(publicKey)

// Fetch root key from server (/api/info is the canonical endpoint)
let rootKey
try {
  const res = await fetch(`http://${host}:${port}/api/info`)
  const info = await res.json()
  rootKey = info.primaryKeyHex ?? info.rootKey
} catch (e) {
  console.error(`could not reach server at http://${host}:${port}: ${e.message}`)
  process.exit(1)
}

console.log(`\njoining as ${username}`)
console.log(`my key  : ${myKey.slice(0, 16)}…`)
console.log(`root key: ${rootKey.slice(0, 16)}…`)
console.log('─'.repeat(40))

const registry = new RepoRegistry()
// Track who we've announced ourselves back to (deduped to prevent
// ping-pong) — see comment in chat/main.js for the discovery pattern.
const announcedTo = new Set()
const session = await registrySync(registry, host, port, {
  filter: k => k === rootKey,
  follow: (keyHex, repo, subscribe) => {
    // Auto-follow all members listed in the root repo (only present when
    // the server has chat-room onAnnounce wiring).
    for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
  },
  onAnnounce: (key) => {
    // Subscribe to the announcer AND announce ourselves back so they
    // learn we exist. Makes chat work even when the server has no
    // member-tracking onAnnounce of its own.
    session.subscribe(key)
    if (!announcedTo.has(key)) {
      announcedTo.add(key)
      session.announce(myKey, rootKey)
    }
  }
})

// Open my own repo and attach our signer so commits go out signed —
// "every write is provably yours" only holds if we actually sign. Set
// profile on first run.
const myRepo = await registry.open(myKey)
myRepo.attachSigner(signer, 'chat')
if (!myRepo.get('name')) {
  myRepo.defaultMessage = `joined as ${username} (cli)`
  myRepo.set({ name: username, messages: [] })
}

// Announce and express interest
session.interest(rootKey)
session.announce(myKey, rootKey)

// ── Message rendering ──────────────────────────────────────────────────────

// Track last-seen message count per repo so we only print new messages
const seen = new Map()

function printNewMessages (keyHex, repo) {
  const name = repo.get('name')
  if (!name || keyHex === myKey) return  // skip unnamed repos and self
  const messages = repo.get('messages') ?? []
  const prev = seen.get(keyHex) ?? 0
  for (let i = prev; i < messages.length; i++) {
    const msg = messages[i]
    const text = typeof msg === 'string' ? msg : msg?.text ?? String(msg)
    const time = msg?.at ? new Date(msg.at).toLocaleTimeString() : ''
    console.log(`\n${time ? `[${time}] ` : ''}${name}: ${text}`)
    process.stdout.write('> ')  // re-print prompt
  }
  seen.set(keyHex, messages.length)
}

function watchRepo (keyHex, repo) {
  if (seen.has(keyHex)) return
  seen.set(keyHex, 0)
  repo.watch(`chat-cli:${keyHex}`, () => printNewMessages(keyHex, repo))
}

// Watch all repos already in registry
for (const [k, r] of registry) watchRepo(k, r)

// Watch repos that open later
registry.onOpen((keyHex, repo) => watchRepo(keyHex, repo))

// ── Stdin → outgoing messages ──────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
})

rl.prompt()

rl.on('line', async line => {
  const text = line.trim()
  if (!text) { rl.prompt(); return }
  const messages = myRepo.get('messages') ?? []
  const preview = text.length > 50 ? text.slice(0, 50).trim() + '…' : text
  myRepo.defaultMessage = `"${preview}" (cli)`
  myRepo.set({ name: username, messages: [...messages, { text, at: new Date() }] })
  rl.prompt()
})

rl.on('close', () => {
  console.log('\nbye')
  process.exit(0)
})

console.log('ready — type a message and press enter\n')
rl.prompt()
