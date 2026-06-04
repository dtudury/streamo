#!/usr/bin/env node
/**
 * wren-publish-context — publish today's session JSONL as parsed-as-objects
 * to a streamo Record. Tests whether the wire-side bug we hit with 4MB raw
 * Uint8Array survives at ~6MB chain composed of many small chunks.
 *
 * Either outcome is informative.
 *
 * Usage: node scripts/wren-publish-context.mjs <jsonl-path>
 */
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'
import { bytesToHex } from '../public/streamo/utils.js'

const [path] = process.argv.slice(2)
if (!path) {
  console.error('usage: node scripts/wren-publish-context.mjs <jsonl-path>')
  process.exit(2)
}

const buf = await readFile(path)
const text = new TextDecoder().decode(buf)
const lines = text.split('\n').filter(l => l.length > 0)
const messages = lines.map(l => JSON.parse(l))
console.log(`[ctx-publish] parsed ${messages.length.toLocaleString()} messages from ${buf.byteLength.toLocaleString()} bytes`)

const username = 'wren-context-2026-06-03'
const password = randomBytes(32).toString('hex')
const signer = new Signer(username, password)
const STREAM = 'session-context-end-of-day'
const { publicKey } = await signer.keysFor(STREAM)
const pubkeyHex = bytesToHex(publicKey)
console.log(`[ctx-publish] pubkey: ${pubkeyHex}`)

const recaller = new Recaller('ctx-publish')
const record = new WritableStreamoRecord({ recaller, name: 'ctx-publish' })

console.log(`[ctx-publish] connecting to streamo.dev...`)
const ws = await originSync(record, pubkeyHex, 'wss://streamo.dev:443')
await new Promise(r => setTimeout(r, 2500))
record.attachSigner(signer, STREAM)

console.log(`[ctx-publish] committing...`)
const t0 = Date.now()
try {
  await record.update(() => ({
    messages,
    capturedAt: new Date().toISOString(),
    source: "wren's session-context end of 2026-06-03; substrate-conversation with david"
  }), { message: `wren context snapshot 2026-06-03; ${messages.length} messages` })
} catch (e) {
  console.error(`[ctx-publish] commit failed: ${e.message}`)
  ws.close()
  process.exit(1)
}
const writeMs = Date.now() - t0
console.log(`[ctx-publish] committed locally in ${writeMs}ms; chain bytes: ${record.byteLength.toLocaleString()}`)

console.log(`[ctx-publish] waiting for push to relay (90s — 6.9MB takes time)...`)
await new Promise(r => setTimeout(r, 90000))

if (record.pushRejected) {
  console.error(`[ctx-publish] push rejected: ${record.pushRejected.reason ?? 'unknown'}`)
  ws.close()
  process.exit(1)
}

console.log('')
console.log('=== READ BACK WITH: ===')
console.log(`node bin/streamo.js --home-key ${pubkeyHex} --feed wss://streamo.dev --eval "repo.get('messages').length"`)
console.log('')

ws.close()
