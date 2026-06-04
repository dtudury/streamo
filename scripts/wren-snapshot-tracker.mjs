#!/usr/bin/env node
/**
 * wren-snapshot-tracker — record JSONL → chain-bytes metrics per invocation.
 * Appends one JSON line per run to a tracker file. Local encode only
 * (no wire-publish; that's a separate experiment).
 *
 * Usage: node scripts/wren-snapshot-tracker.mjs <jsonl> [tracker]
 */
import { readFile, appendFile } from 'node:fs/promises'
import { Streamo } from '../public/streamo/Streamo.js'

const [path, trackerPath = '/tmp/wren-snapshots.jsonl'] = process.argv.slice(2)
if (!path) {
  console.error('usage: node scripts/wren-snapshot-tracker.mjs <jsonl> [tracker]')
  process.exit(2)
}

const buf = await readFile(path)
const text = new TextDecoder().decode(buf)
const lines = text.split('\n').filter(l => l.length > 0)
const messages = lines.map(l => JSON.parse(l))

const t0 = Date.now()
const s = new Streamo()
s.set({ messages })
const chainBytes = s.byteLength
const encodeMs = Date.now() - t0

const entry = {
  t:           new Date().toISOString(),
  inputBytes:  buf.byteLength,
  messages:    messages.length,
  chainBytes,
  ratio:       Number((chainBytes / buf.byteLength).toFixed(4)),
  encodeMs
}

await appendFile(trackerPath, JSON.stringify(entry) + '\n')
console.log(JSON.stringify(entry))
