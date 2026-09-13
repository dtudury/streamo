import { describe } from './utils/testing.js'
import { Recaller } from './utils/Recaller.js'
import { Signer } from './Signer.js'
import { Hub } from './Hub.js'
import { StreamoRecord } from './StreamoRecord.js'
import { Downstream } from './Downstream.js'
import { loopback } from './loopback.js'
import { bytesToHex, hexToBytes } from './utils.js'

const KEY_BYTES = 33

async function signedProposal (signer, files) {
  const key = bytesToHex((await signer.keysFor('home')).publicKey)
  const recaller = new Recaller('author')
  const draft = new Hub({ recaller }).checkout(key, signer, 'home')
  const working = draft.checkout()
  working.set(files)
  draft.commit(working, 'proposal')
  await recaller.when(() => draft.byteLength > 0 && draft.signedLength === draft.byteLength)

  const frames = []
  const trusted = new StreamoRecord({ recaller: new Recaller('capture') })
  const reader = draft.makeReadableStream({ fromOffset: 0 }).getReader()
  const writer = trusted.makeWritableStream().getWriter()
  while (trusted.byteLength < draft.byteLength) {
    const { value, done } = await reader.read()
    if (done) break
    frames.push(value)
    await writer.write(value)
  }
  writer.releaseLock()
  reader.cancel().catch(() => {})
  return { key, frames, byteLength: draft.byteLength }
}

function onTheWire (keyHex, frames) {
  const keyBytes = hexToBytes(keyHex)
  return frames.map(payload => {
    const frame = new Uint8Array(KEY_BYTES + payload.length)
    frame.set(keyBytes, 0)
    frame.set(payload, KEY_BYTES)
    return frame
  })
}

describe(import.meta.url, ({ test }) => {
  test('a correctly signed proposal from below lands in canon', async ({ assert }) => {
    const { key, frames, byteLength } = await signedProposal(new Signer('user', 'pass', 1000), { 'hello.md': 'proposed\n' })
    const recaller = new Recaller('top')
    const top = new Hub({ recaller })
    const [topEnd, peerEnd] = loopback()
    // eslint-disable-next-line no-new
    new Downstream({ hub: top, connection: topEnd })

    for (const frame of onTheWire(key, frames)) peerEnd.send(frame)
    await recaller.when(() => top.getMirror(key).byteLength >= byteLength)

    assert.deepEqual(top.getMirror(key).get(), { 'hello.md': 'proposed\n' })
  })

  test('a proposal claiming a key its author does not hold is refused, and the peer is dropped', async ({ assert }) => {
    const { frames } = await signedProposal(new Signer('user', 'pass', 1000), { 'hello.md': 'forged\n' })
    const victim = bytesToHex((await new Signer('someone', 'else', 1000).keysFor('home')).publicKey)
    const recaller = new Recaller('top')
    const top = new Hub({ recaller })
    const [topEnd, peerEnd] = loopback()
    // eslint-disable-next-line no-new
    new Downstream({ hub: top, connection: topEnd })

    const dropped = new Promise(resolve => peerEnd.on('close', () => resolve('dropped')))
    const landed = recaller.when(() => top.getMirror(victim).byteLength > 0).then(() => 'landed')
    for (const frame of onTheWire(victim, frames)) peerEnd.send(frame)
    const outcome = await Promise.race([dropped, landed])

    assert.equal(outcome, 'dropped', 'the peer is dropped rather than the forgery landing')
    assert.equal(top.getMirror(victim).byteLength, 0, 'nothing signed by the wrong key reaches canon')
  })
})
