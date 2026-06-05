#!/usr/bin/env node
/**
 * @file snapshot-compression-experiment — try several content tokenization
 * shapes and compare streamo chain bytes.
 *
 * David's intuition (2026-06-05): word-array storage sometimes gives
 * dramatic compression (especially for repetitive content like code
 * edits) and sometimes barely beats string storage (normal prose).
 * Run several shapes; report all numbers.
 *
 * Shapes tried (all stored as `value = { messages: [{role, content: <SHAPE>}, ...] }`):
 *   - string  : content kept as the original string (baseline)
 *   - words   : content split into words + whitespace tokens
 *   - chars   : content split into individual characters (extreme)
 *
 * Each publishes to a fresh one-off pubkey for clean measurement.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { identity } from '../public/streamo/identity.js'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'

// ── locate + load JSONL ──────────────────────────────────────────────
const sessionId = process.env.CLAUDE_CODE_SESSION_ID
if (!sessionId) {
  console.error('CLAUDE_CODE_SESSION_ID not in env')
  process.exit(2)
}
const jsonlPath = join(
  homedir(),
  '.claude/projects/-Users-davidtudury-Documents-repos-streamo',
  sessionId + '.jsonl'
)
const rawBuf = await readFile(jsonlPath)
const rawBytes = rawBuf.byteLength

// ── parse + filter to API shape (same logic as ContextRecord) ────────
const text = new TextDecoder().decode(rawBuf)
const rawObjs = text.split('\n').filter(Boolean).map(l => JSON.parse(l))

const filtered = []
for (const m of rawObjs) {
  if (m.isSidechain) continue
  if (m.type !== 'user' && m.type !== 'assistant') continue
  const c = m.message?.content
  const role = m.message?.role
  if (role !== 'user' && role !== 'assistant') continue
  let txt
  if (typeof c === 'string') txt = c
  else if (Array.isArray(c)) {
    txt = c.filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n')
  } else continue
  if (!txt || !txt.trim()) continue
  filtered.push({ role, content: txt })
}
const messages = []
for (const m of filtered) {
  const last = messages[messages.length - 1]
  if (last && last.role === m.role) last.content = last.content + '\n\n' + m.content
  else messages.push({ ...m })
}

// ── tokenization shapes ──────────────────────────────────────────────
const SHAPES = {
  string: (text) => text,
  words:  (text) => text.split(/(\s+)/).filter(t => t.length > 0),
  chars:  (text) => [...text]
}

// ── publish each shape, measure chain bytes ──────────────────────────
async function publishShape (shapeName, transformer) {
  const transformed = messages.map(m => ({ role: m.role, content: transformer(m.content) }))
  const value = { messages: transformed }

  const idName = `compression-${shapeName}-${Date.now()}`
  const { pubkeyHex, password } = await identity.new(idName)
  const signer = new Signer(idName, password, 100000)
  const recaller = new Recaller('comp-' + shapeName)
  const record = new WritableStreamoRecord({ recaller, name: 'comp-' + shapeName })

  const ws = await originSync(record, pubkeyHex, 'wss://streamo.dev')
  await new Promise(r => setTimeout(r, 2500))
  record.attachSigner(signer, idName)

  const t0 = Date.now()
  await record.update(() => value, { message: `compression experiment: ${shapeName}` })
  const commitMs = Date.now() - t0

  // Approximate token count for char/words shapes
  const totalElements = shapeName === 'string'
    ? messages.length
    : transformed.reduce((s, m) => s + m.content.length, 0)

  const result = {
    shape: shapeName,
    pubkey: pubkeyHex,
    elements: totalElements,
    chainBytes: record.byteLength,
    commitMs,
    pushRejected: false
  }

  // Wait for push (rough estimate)
  const waitMs = Math.max(5000, Math.floor(record.byteLength / 1024 / 1024 * 12000))
  await new Promise(r => setTimeout(r, waitMs))
  result.pushRejected = !!record.pushRejected
  ws.close()
  return result
}

console.log('')
console.log(`source: ${jsonlPath.split('/').pop()}`)
console.log(`raw JSONL bytes: ${rawBytes.toLocaleString()} (${(rawBytes/1024/1024).toFixed(2)} MB)`)
console.log(`parsed API messages: ${messages.length}`)
console.log('')
console.log('publishing each shape to a one-off pubkey...')
console.log('')

const results = []
for (const [name, fn] of Object.entries(SHAPES)) {
  process.stderr.write(`  ${name}... `)
  const r = await publishShape(name, fn)
  process.stderr.write(`chain=${r.chainBytes.toLocaleString()} bytes${r.pushRejected ? ' [REJECTED]' : ''}\n`)
  results.push(r)
}

console.log('')
console.log('─── results ───')
console.log('shape     | elements        | chain bytes        | chain/raw  | vs string')
console.log('----------|-----------------|--------------------|------------|----------')
const stringRow = results.find(r => r.shape === 'string')
for (const r of results) {
  const elements = r.elements.toLocaleString().padStart(15)
  const chain = r.chainBytes.toLocaleString().padStart(18)
  const vsRaw = ((r.chainBytes / rawBytes * 100).toFixed(1) + '%').padStart(10)
  const vsString = r === stringRow ? '   ----' : ((r.chainBytes / stringRow.chainBytes * 100).toFixed(1) + '%').padStart(7)
  console.log(`${r.shape.padEnd(9)} | ${elements} | ${chain} | ${vsRaw} | ${vsString}`)
}
console.log('')
for (const r of results) {
  console.log(`  ${r.shape}: ${r.pubkey}`)
}
console.log('')
process.exit(0)
