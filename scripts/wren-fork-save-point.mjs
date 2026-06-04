#!/usr/bin/env node
/**
 * wren-fork-save-point — take today's session JSONL truncated to
 * messages[0..N], publish as a new streamo Record. The new pubkey is
 * the "fork" — an alternate timeline that diverges from save-point-1
 * at message N.
 *
 * Demonstrates the time-loop primitive: yesterday's full timeline +
 * an alternate-history branch, both addressable, both readable, both
 * extendable.
 *
 * Usage: node scripts/wren-fork-save-point.mjs <jsonl> <truncate-at-line>
 */
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'
import { bytesToHex } from '../public/streamo/utils.js'

const [path, truncateAtStr] = process.argv.slice(2)
const truncateAt = parseInt(truncateAtStr, 10)
if (!path || !Number.isFinite(truncateAt)) {
  console.error('usage: node scripts/wren-fork-save-point.mjs <jsonl> <truncate-at>')
  process.exit(2)
}

const ORIGINAL_SAVE_POINT = '03d44aeb6b737034cd0cc6ff803a9c5829e51827a78d71b6d03ece2dff7fe5bccf'

const buf = await readFile(path)
const text = new TextDecoder().decode(buf)
const lines = text.split('\n').filter(l => l.length > 0)
const allMessages = lines.map(l => JSON.parse(l))
const forked = allMessages.slice(0, truncateAt)
console.log(`[fork] full session: ${allMessages.length.toLocaleString()} msgs`)
console.log(`[fork] fork length:  ${forked.length.toLocaleString()} msgs (truncated at ${truncateAt})`)

const username = `wren-fork-at-${truncateAt}-2026-06-03`
const password = randomBytes(32).toString('hex')
const signer = new Signer(username, password)
const STREAM = `fork-at-${truncateAt}`
const { publicKey } = await signer.keysFor(STREAM)
const pubkeyHex = bytesToHex(publicKey)
console.log(`[fork] fork pubkey:  ${pubkeyHex}`)

const recaller = new Recaller('fork')
const record = new WritableStreamoRecord({ recaller, name: 'fork' })
const ws = await originSync(record, pubkeyHex, 'wss://streamo.dev:443')
await new Promise(r => setTimeout(r, 2500))
record.attachSigner(signer, STREAM)

console.log(`[fork] committing...`)
await record.update(() => ({
  messages: forked,
  capturedAt: new Date().toISOString(),
  source: `fork of wren's 2026-06-03 session at message ${truncateAt}`,
  forkedFromMessageCount: truncateAt,
  forkedFromOriginalSavePoint: ORIGINAL_SAVE_POINT,
  story: 'alternate-history branch — what would today have been if we had stopped here'
}), { message: `fork at message ${truncateAt} of 2026-06-03 wren session` })

const chainBytes = record.byteLength
const waitSec = 180  // generous; closing the WS too early loses the in-flight push
console.log(`[fork] local chain bytes: ${chainBytes.toLocaleString()}; waiting ${waitSec}s for push...`)
await new Promise(r => setTimeout(r, waitSec * 1000))

if (record.pushRejected) {
  console.error(`[fork] push rejected: ${record.pushRejected.reason ?? 'unknown'}`)
  ws.close()
  process.exit(1)
}

console.log('')
console.log('=== TWO SAVE-POINTS NOW EXIST: ===')
console.log(`original (full timeline @ ${allMessages.length} msgs): ${ORIGINAL_SAVE_POINT}`)
console.log(`fork     (alt-history @ ${truncateAt} msgs):           ${pubkeyHex}`)
console.log('')
console.log('Read either:')
console.log(`  node bin/streamo.js --home-key <pubkey> --feed wss://streamo.dev --eval "repo.get('messages').length"`)
ws.close()
