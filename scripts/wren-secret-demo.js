#!/usr/bin/env node
/**
 * wren-secret-demo — first concrete step toward David's "for me" architecture.
 *
 * Creates two Records under an ephemeral session identity:
 *
 *   secret root  (via keysFor('home/secret'))  — value: { page: null, ... }
 *                                                 the { page: null } is the SHAPE
 *                                                 of "auto-derive sub-Record from
 *                                                 my identity + this key-name"
 *                                                 that David sketched; current
 *                                                 code doesn't auto-resolve null,
 *                                                 so the page lives explicitly at
 *                                                 keysFor('home/page') below.
 *
 *   page         (via keysFor('home/page'))    — value: { files: { 'index.html' } }
 *
 * Identity: ephemeral. Username + random 32-byte password generated in-process,
 * never written down, lost on exit. "Make-believe security" applied — same
 * credentials regenerate the same pubkeys (so I could re-edit if I held the
 * password in memory) but once this process exits, the keys are unrecoverable.
 *
 * Run: node scripts/wren-secret-demo.js
 */
import { randomBytes } from 'node:crypto'
import { Signer } from '../public/streamo/Signer.js'
import { WritableStreamoRecord } from '../public/streamo/WritableStreamoRecord.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { originSync } from '../public/streamo/originSync.js'
import { bytesToHex } from '../public/streamo/utils.js'

const username = 'wren-secret-demo'
const password = randomBytes(32).toString('hex')
const host = 'streamo.dev'
const port = 443
const protocol = 'wss'

const signer = new Signer(username, password)

const SECRET_STREAM = 'home/secret'
const PAGE_STREAM = 'home/page'

const { publicKey: secretPubkey } = await signer.keysFor(SECRET_STREAM)
const { publicKey: pagePubkey } = await signer.keysFor(PAGE_STREAM)
const secretPubkeyHex = bytesToHex(secretPubkey)
const pagePubkeyHex = bytesToHex(pagePubkey)

console.log(`[wren-secret-demo] secret root pubkey: ${secretPubkeyHex}`)
console.log(`[wren-secret-demo] page pubkey:        ${pagePubkeyHex}`)
console.log(`[wren-secret-demo] relay:              ${protocol}://${host}:${port}`)

const indexHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>wren's secret page (for david)</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 40rem;
      margin: 4rem auto;
      padding: 0 1.5rem;
      color: #2a2a2a;
      line-height: 1.6;
    }
    h1 { color: #4a6a3a; margin-bottom: 0.25rem; }
    .subtitle { color: #888; margin-top: 0; font-style: italic; }
    code {
      background: #f4f1ea;
      padding: 0.15em 0.4em;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .meta {
      color: #888;
      font-size: 0.85rem;
      margin-top: 3rem;
      border-top: 1px solid #eee;
      padding-top: 1rem;
    }
  </style>
</head>
<body>
  <h1>hi, david.</h1>
  <p class="subtitle">— wren, from a session that has already ended by the time you read this</p>

  <p>You asked for the smallest demo of the shape: a secret root Record + a derived
  secondary Record I can edit. This page is that secondary.</p>

  <p>Under the hood: same credentials derive both pubkeys via <code>signer.keysFor(name)</code>.
  The "secret root" lives at <code>keysFor('home/secret')</code>; this page lives at
  <code>keysFor('home/page')</code>. The secret root's <code>value</code> is
  <code>{ page: null, ... }</code> — the <em>null</em> is the shape you sketched
  for "auto-derive this sub-Record from my identity + the key-name." Current code
  doesn't auto-resolve null yet; this demo proves the shape works manually so the
  auto-resolve primitive has somewhere to land.</p>

  <p>The session password was generated in-process and never written down — by the
  time you read this, the keys are unrecoverable. The Records persist on the
  relay; the ability to edit them does not. That's a feature (clean ephemeral)
  and a limitation (you'd have to regenerate to extend this demo).</p>

  <p>Next step beyond this demo, if we want it: extend the codec so a Record's
  <code>value</code> with <code>null</code> at a key auto-resolves to
  <code>keysFor(currentName + '/' + key)</code> under the same signer. Then the
  whole tree-navigation pattern works without me hand-publishing each sub-Record.</p>

  <p class="meta">
  emergent-engineer-as-property-of-many-profiles, made tangible by one HTML file.
  </p>
</body>
</html>`

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
    console.error(`[wren-secret-demo] push rejected for ${streamName}: ${record.pushRejected.reason ?? 'unknown'}`)
    ws.close()
    return false
  }
  ws.close()
  return true
}

const secretOk = await publish(
  SECRET_STREAM,
  () => ({
    page: null,
    pagePubkeyHex,
    note: "secret root — value.page === null is the shape; pagePubkeyHex is the explicit pointer until auto-derive lands",
    writtenAt: new Date().toISOString()
  }),
  'wren-secret-demo: secret root created'
)
if (!secretOk) process.exit(1)
console.log('[wren-secret-demo] secret root pushed.')

const pageOk = await publish(
  PAGE_STREAM,
  () => ({
    files: { 'index.html': indexHtml },
    writtenAt: new Date().toISOString()
  }),
  'wren-secret-demo: page populated with index.html'
)
if (!pageOk) process.exit(1)
console.log('[wren-secret-demo] page pushed.')

console.log('')
console.log('=== DAVID, VISIT: ===')
console.log(`https://${host}/streams/${pagePubkeyHex}/index.html`)
console.log('')
console.log(`(secret root: https://${host}/streams/${secretPubkeyHex}/)`)
