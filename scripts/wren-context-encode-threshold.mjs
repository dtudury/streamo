#!/usr/bin/env node
/**
 * wren-context-encode-threshold — find the size at which streamo's codec
 * starts failing on a raw Uint8Array. Local-only; no network, no signer.
 *
 * David's hypothesis: "we probably take a ton of memory trying to keep
 * the largest power of 2 of the whole thing in memory." Test it by
 * halving input size until encode succeeds.
 *
 * Usage: node scripts/wren-context-encode-threshold.mjs <jsonl-path>
 */
import { readFile } from 'node:fs/promises'
import { Streamo } from '../public/streamo/Streamo.js'

const [path] = process.argv.slice(2)
if (!path) {
  console.error('usage: node scripts/wren-context-encode-threshold.mjs <path>')
  process.exit(2)
}

const buf = await readFile(path)
const full = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
console.log(`[threshold] full input: ${full.byteLength.toLocaleString()} bytes`)
console.log('')

const sizes = [
  4_000_000,
  2_500_000,
  2_097_152,  // exactly 2^21
  2_000_000,
  1_500_000,
  1_048_576,  // exactly 2^20
  1_000_000,
  524_288,    // exactly 2^19
  500_000,
  262_144,    // exactly 2^18
  100_000,
  10_000,
  1_000,
]

for (const size of sizes) {
  if (size > full.byteLength) continue
  const slice = full.slice(0, size)
  const s = new Streamo()
  try {
    s.set({ transcript: slice })
    const chainBytes = s.byteLength
    console.log(`  ✓ ${size.toLocaleString().padStart(12)}  →  chain ${chainBytes.toLocaleString().padStart(10)}  ratio ${(chainBytes / size).toFixed(3)}`)
  } catch (e) {
    console.log(`  ✗ ${size.toLocaleString().padStart(12)}  →  ${e.message}`)
  }
}

// Now the parsed variant: split JSONL into lines, parse each, store as
// { messages: [...parsed objects...] } so the codec sees structure.
console.log('')
console.log('--- parsed as array of JS objects ---')
const text = new TextDecoder().decode(full)
const lines = text.split('\n').filter(l => l.length > 0)
const messages = []
let parseErrors = 0
for (const line of lines) {
  try { messages.push(JSON.parse(line)) }
  catch { parseErrors++ }
}
console.log(`  parsed ${messages.length.toLocaleString()} objects (${parseErrors} parse-error skips)`)

const sParsed = new Streamo()
try {
  sParsed.set({ messages })
  const parsedChainBytes = sParsed.byteLength
  console.log(`  ✓ chain bytes: ${parsedChainBytes.toLocaleString()}`)
  console.log(`  ratio vs input: ${(parsedChainBytes / full.byteLength).toFixed(3)} (chain / input)`)
  console.log(`  delta vs raw-bytes: ${(parsedChainBytes - 7010157).toLocaleString()} bytes (using prior 4M-row chain estimate)`)
} catch (e) {
  console.log(`  ✗ parsed encode failed: ${e.message}`)
}
