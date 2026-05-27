#!/usr/bin/env node
/**
 * Demo for turtleLog — shows the checkerboard-block visual demux
 * across many peers and the per-event glyph table. Run:
 *
 *   node scripts/demo-turtle-log.js
 */
import { randomBytes } from 'node:crypto'
import { turtleIn, turtleOut, turtleLocal } from '../public/streamo/utils/turtleLog.js'
import { setLogLevel, SILLY } from '../public/streamo/utils/logger.js'

setLogLevel(SILLY)

// Generate a faithful-looking secp256k1-compressed pubkey: 33 bytes,
// leading 02 or 03, tail uniformly random.
function fakeKey () {
  const prefix = Math.random() < 0.5 ? '02' : '03'
  return prefix + randomBytes(32).toString('hex')
}

// A few "named" peers for the storyline sections (stable across run).
const LIBRARY  = '02e771a8b3c4d5e6f708192a3b4c5d6e7f80910a2b3c4d5e6f70819203b93a55'
const HOMEPAGE = '03a1b2c3d4e5f607182930415263748596a7b8c9dadbecfd0e1f203142536475'
const EXPLORER = '02f0e1d2c3b4a5968778695a4b3c2d1e0f9e8d7c6b5a493827160504030201f0'
const CHAT     = '03cafebabe1234567890abcdef0123456789abcdef0123456789abcdef012345'
const FLASHCRD = '021357924680ace0fdb97531864297531864297531864297531864297531864'
const TODOMVC  = '03beefdeadc0de1337f00dbabe5151515151515151515151515151515151515151'

console.log()
console.log('  \x1b[1m— peer gallery: 30 random pubkeys, one hello each —\x1b[0m')
console.log('  \x1b[2m  same key always picks the same block; swap-bit doubles the visual space\x1b[0m')
console.log()
for (let i = 0; i < 30; i++) {
  const k = fakeKey()
  turtleOut('hello', k, { home: k })
}

console.log()
console.log('  \x1b[1m— named-peers gallery: stable across runs —\x1b[0m')
console.log()
for (const [name, k] of [
  ['library',  LIBRARY],
  ['homepage', HOMEPAGE],
  ['explorer', EXPLORER],
  ['chat',     CHAT],
  ['flashcrd', FLASHCRD],
  ['todomvc',  TODOMVC]
]) {
  turtleOut('hello', k, { name, home: k })
}

console.log()
console.log('  \x1b[1m— a single peer (library) running a full subscribe cycle —\x1b[0m')
console.log()
turtleLocal('open',      LIBRARY)
turtleOut  ('hello',     LIBRARY, { home: LIBRARY })
turtleIn   ('hello',     LIBRARY, { home: LIBRARY })
turtleOut  ('subscribe', LIBRARY, { fromOffset: 0, fromChainHash: new Uint8Array(32) })
turtleIn   ('subscribed',LIBRARY, { atOffset: 527014 })
for (let i = 0; i < 8; i++) {
  turtleIn ('chunk',     LIBRARY, { bytes: 4096 + Math.floor(Math.random() * 2048) })
}
turtleIn   ('sig',       LIBRARY, { chainHash: 'ab12cd34ef5678901234567890abcdef1234567890abcdef1234567890abcdef' })
for (let i = 0; i < 5; i++) {
  turtleIn ('chunk',     LIBRARY, { bytes: 4096 + Math.floor(Math.random() * 2048) })
}
turtleIn   ('sig',       LIBRARY, { chainHash: 'cd34ef567890123456789012345678901234567890abcdef1234567890abcdef' })
turtleLocal('caughtUp',  LIBRARY, { atOffset: 527014 })

console.log()
console.log('  \x1b[1m— interest / announce flow across several peers —\x1b[0m')
console.log()
turtleOut  ('interest',  HOMEPAGE, { topic: HOMEPAGE })
turtleIn   ('announce',  HOMEPAGE, { topic: HOMEPAGE, related: LIBRARY })
turtleIn   ('announce',  HOMEPAGE, { topic: HOMEPAGE, related: EXPLORER })
turtleIn   ('announce',  HOMEPAGE, { topic: HOMEPAGE, related: CHAT })
turtleIn   ('announce',  HOMEPAGE, { topic: HOMEPAGE, related: FLASHCRD })
turtleIn   ('announce',  HOMEPAGE, { topic: HOMEPAGE, related: TODOMVC })
turtleOut  ('subscribe', LIBRARY,  { fromOffset: 0 })
turtleOut  ('subscribe', EXPLORER, { fromOffset: 0 })
turtleOut  ('subscribe', CHAT,     { fromOffset: 0 })

console.log()
console.log('  \x1b[1m— the unhappy path: push race, reject, conflict —\x1b[0m')
console.log()
turtleOut  ('subscribe',    CHAT, { fromOffset: 143657, fromChainHash: 'deadbeefcafef00d' })
turtleIn   ('chunk',        CHAT, { bytes: 320 })
turtleIn   ('reject',       CHAT, { reason: 'chain-mismatch' })
turtleLocal('pushRejected', CHAT, { reason: 'chain-mismatch' })
turtleLocal('conflict',     CHAT, { dataAddress: 17 })
turtleLocal('close',        CHAT, { code: 1006, reason: 'conflict' })

console.log()
console.log('  \x1b[1m— mixed traffic: many peers, interleaved —\x1b[0m')
console.log()
const peers = [LIBRARY, HOMEPAGE, EXPLORER, CHAT, FLASHCRD, TODOMVC]
const events = [
  ['in',  'chunk',     { bytes: 4096 }],
  ['out', 'chunk',     { bytes: 2048 }],
  ['in',  'sig',       { chainHash: 'a1b2c3d4e5f607182930415263748596a7b8c9da' }],
  ['out', 'subscribe', { fromOffset: 8192 }],
  ['in',  'announce',  { topic: 'home', related: 'sibling' }],
  ['local', 'caughtUp', { atOffset: 65536 }],
  ['in',  'ping',      null],
  ['out', 'ping',      null]
]
for (let i = 0; i < 40; i++) {
  const peer = peers[Math.floor(Math.random() * peers.length)]
  const [dir, evt, details] = events[Math.floor(Math.random() * events.length)]
  const fn = dir === 'in' ? turtleIn : dir === 'out' ? turtleOut : turtleLocal
  fn(evt, peer, details)
}

console.log()
