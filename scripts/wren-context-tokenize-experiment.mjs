#!/usr/bin/env node
/**
 * wren-context-tokenize-experiment — test David's hypothesis:
 * splitting long strings into arrays of whitespace-delimited tokens
 * lets the codec dedup common words (the, a, of, to, ...) since they
 * become identical whole-values.
 *
 * Compare three encodings of the same JSONL:
 *   A. raw bytes                   (baseline)
 *   B. parsed as array of objects  (today's baseline)
 *   C. parsed + long strings tokenized into arrays of word+whitespace
 *
 * Usage: node scripts/wren-context-tokenize-experiment.mjs <jsonl>
 */
import { readFile } from 'node:fs/promises'
import { Streamo } from '../public/streamo/Streamo.js'

const [path] = process.argv.slice(2)
const buf = await readFile(path)

const inputBytes = buf.byteLength
console.log(`input bytes: ${inputBytes.toLocaleString()}`)
console.log('')

// A. raw bytes
{
  const s = new Streamo()
  s.set({ transcript: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) })
  console.log(`A. raw bytes:                ${s.byteLength.toLocaleString().padStart(10)}   ratio ${(s.byteLength / inputBytes).toFixed(3)}`)
}

// B. parsed as array of objects
const text = new TextDecoder().decode(buf)
const lines = text.split('\n').filter(l => l.length > 0)
const messages = lines.map(l => JSON.parse(l))
{
  const s = new Streamo()
  s.set({ messages })
  console.log(`B. parsed (objects):         ${s.byteLength.toLocaleString().padStart(10)}   ratio ${(s.byteLength / inputBytes).toFixed(3)}`)
}

// C. parsed + tokenize long strings
function tokenize (str) {
  return str.split(/(\s+)/)
}
function walk (value) {
  if (typeof value === 'string' && value.length > 10) return tokenize(value)
  if (Array.isArray(value)) return value.map(walk)
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const out = {}
    for (const k of Object.keys(value)) out[k] = walk(value[k])
    return out
  }
  return value
}
const tokenized = messages.map(walk)
{
  const s = new Streamo()
  s.set({ messages: tokenized })
  console.log(`C. parsed + tokenized:       ${s.byteLength.toLocaleString().padStart(10)}   ratio ${(s.byteLength / inputBytes).toFixed(3)}`)
}

// stats on the tokenization
let totalTokens = 0
let uniqueTokens = new Set()
function count (value) {
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string') { totalTokens++; uniqueTokens.add(v) }
      else count(v)
    }
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) count(value[k])
  }
}
count(tokenized)
console.log('')
console.log(`tokenization stats: ${totalTokens.toLocaleString()} total tokens, ${uniqueTokens.size.toLocaleString()} unique (${(100 * uniqueTokens.size / totalTokens).toFixed(1)}% unique)`)
