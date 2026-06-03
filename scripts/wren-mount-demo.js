#!/usr/bin/env node
/**
 * wren-mount-demo — verify FolderRecord-based --cat follows mounts.json
 * end-to-end through the wire.
 *
 * Creates two Records under an ephemeral session identity:
 *   parent  — value.files = { 'mounts.json': { mounts: { 'sub/': { key: child } } } }
 *   child   — value.files = { 'index.html': '<from mounted child>' }
 *
 * Then prints the verification command. Running it should pull the
 * child's index.html via the parent's mount, both bytes-on-the-wire.
 *
 * Run: node scripts/wren-mount-demo.js
 */
import { randomBytes } from 'node:crypto'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'
import { bytesToHex } from '../public/streamo/utils.js'

const username = 'wren-mount-demo'
const password = randomBytes(32).toString('hex')
const host = 'streamo.dev'
const port = 443
const protocol = 'wss'

const signer = new Signer(username, password)

const PARENT_STREAM = 'mount-demo/parent'
const CHILD_STREAM  = 'mount-demo/child'

const { publicKey: parentPk } = await signer.keysFor(PARENT_STREAM)
const { publicKey: childPk }  = await signer.keysFor(CHILD_STREAM)
const parentHex = bytesToHex(parentPk)
const childHex  = bytesToHex(childPk)

console.log(`[wren-mount-demo] parent pubkey: ${parentHex}`)
console.log(`[wren-mount-demo] child  pubkey: ${childHex}`)

async function publish (streamName, valueFn, message) {
  const { publicKey } = await signer.keysFor(streamName)
  const publicKeyHex = bytesToHex(publicKey)
  const recaller = new Recaller(`publish-${streamName}`)
  const record = new WritableStreamoRecord({ recaller, name: `publish-${streamName}` })
  const ws = await originSync(record, publicKeyHex, `${protocol}://${host}:${port}`)
  await new Promise(r => setTimeout(r, 2500))
  record.attachSigner(signer, streamName)
  await record.update(valueFn, { message })
  await new Promise(r => setTimeout(r, 3000))
  if (record.pushRejected) {
    console.error(`[wren-mount-demo] push rejected for ${streamName}: ${record.pushRejected.reason ?? 'unknown'}`)
    ws.close()
    return false
  }
  ws.close()
  return true
}

const childOk = await publish(
  CHILD_STREAM,
  () => ({ files: { 'index.html': '<from mounted child>\n' } }),
  'wren-mount-demo: child created with index.html'
)
if (!childOk) process.exit(1)
console.log('[wren-mount-demo] child pushed.')

const parentOk = await publish(
  PARENT_STREAM,
  () => ({
    files: {
      'mounts.json': { mounts: { 'sub/': { key: childHex } } }
    }
  }),
  'wren-mount-demo: parent created with mounts.json pointing at child'
)
if (!parentOk) process.exit(1)
console.log('[wren-mount-demo] parent pushed.')

console.log('')
console.log('=== VERIFY: ===')
console.log(`node bin/streamo.js \\`)
console.log(`  --home-key ${parentHex} \\`)
console.log(`  --feed wss://streamo.dev \\`)
console.log(`  --cat sub/index.html \\`)
console.log(`  --data-dir false`)
console.log('')
console.log('Expected output: <from mounted child>')
