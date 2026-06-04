#!/usr/bin/env node
/**
 * wren-context-experiment — publish a JSONL file as Uint8Array value
 *   in a streamo Record, measure chain bytes vs input bytes.
 *
 * David's "let's see how it does" empirical step before any
 * architecture decisions about context-as-Record.
 *
 * Usage: node scripts/wren-context-experiment.mjs <path-to-jsonl>
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
  console.error('usage: node scripts/wren-context-experiment.mjs <jsonl-path>')
  process.exit(2)
}

const buf = await readFile(path)
const inputSize = buf.byteLength
const transcript = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
console.log(`[ctx-exp] input bytes: ${inputSize.toLocaleString()}`)

const username = 'wren-context-experiment'
const password = randomBytes(32).toString('hex')
const signer = new Signer(username, password)
const STREAM = 'context-uint8array'
const { publicKey } = await signer.keysFor(STREAM)
const pubkeyHex = bytesToHex(publicKey)
console.log(`[ctx-exp] pubkey:      ${pubkeyHex}`)

const recaller = new Recaller('ctx-exp')
const record = new WritableStreamoRecord({ recaller, name: 'ctx-exp' })
const ws = await originSync(record, pubkeyHex, 'wss://streamo.dev:443')

await new Promise(r => setTimeout(r, 2500))
record.attachSigner(signer, STREAM)

const t0 = Date.now()
await record.update(() => ({ transcript }), {
  message: `context as uint8array: ${inputSize} input bytes`
})
const writeMs = Date.now() - t0

await new Promise(r => setTimeout(r, 3000))

if (record.pushRejected) {
  console.error(`[ctx-exp] push rejected: ${record.pushRejected.reason ?? 'unknown'}`)
  ws.close()
  process.exit(1)
}

const chainBytes = record.byteLength
const ratio = chainBytes / inputSize
console.log(`[ctx-exp] chain bytes: ${chainBytes.toLocaleString()}`)
console.log(`[ctx-exp] ratio:       ${ratio.toFixed(4)} (chain / input)`)
console.log(`[ctx-exp] delta:       ${(chainBytes - inputSize).toLocaleString()} bytes (${(ratio < 1 ? 'saved' : 'overhead')})`)
console.log(`[ctx-exp] write time:  ${writeMs}ms`)

ws.close()
