#!/usr/bin/env node
/**
 * wren-context-update-experiment — set the same Streamo twice with
 * messages[0..N1] then messages[0..N2]; compare actual chain growth
 * with the separate-encode delta. This is the real dedup test.
 *
 * Usage: node scripts/wren-context-update-experiment.mjs <jsonl>
 */
import { readFile } from 'node:fs/promises'
import { Streamo } from '../public/streamo/Streamo.js'

const [path] = process.argv.slice(2)
const buf = await readFile(path)
const text = new TextDecoder().decode(buf)
const lines = text.split('\n').filter(l => l.length > 0)
const messages = lines.map(l => JSON.parse(l))
console.log(`parsed ${messages.length.toLocaleString()} messages from ${buf.byteLength.toLocaleString()} bytes`)

const FIRST_N = 1619  // matches the snapshot from the first experiment
const FULL_N  = messages.length

if (FULL_N <= FIRST_N) {
  console.error(`need more than ${FIRST_N} messages; have ${FULL_N}`)
  process.exit(1)
}

const s = new Streamo()

s.set({ messages: messages.slice(0, FIRST_N) })
const c1 = s.byteLength
console.log(`after set #1 (${FIRST_N.toLocaleString()} msgs): ${c1.toLocaleString()} bytes`)

s.set({ messages: messages.slice(0, FULL_N) })
const c2 = s.byteLength
console.log(`after set #2 (${FULL_N.toLocaleString()} msgs): ${c2.toLocaleString()} bytes`)

const delta = c2 - c1
const newMsgs = FULL_N - FIRST_N
console.log(``)
console.log(`marginal storage:  ${delta.toLocaleString()} bytes`)
console.log(`new msgs:          ${newMsgs}`)
console.log(`bytes per new msg: ${Math.round(delta / newMsgs).toLocaleString()}`)
console.log(``)
console.log(`(compare: separate-encode delta was ~214,279 bytes for the same N1→N2 gap)`)
