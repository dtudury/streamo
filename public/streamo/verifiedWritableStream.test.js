import { describe } from './utils/testing.js'
import { Recaller } from './utils/Recaller.js'
import { Signer } from './Signer.js'
import { Hub } from './Hub.js'
import { StreamoRecord } from './StreamoRecord.js'
import { makeVerifiedWritableStream } from './StreamoRecordSerializer.js'
import { bytesToHex } from './utils.js'

async function signedFrames (files) {
  const signer = new Signer('user', 'pass', 1000)
  const keys = await signer.keysFor('home')
  const recaller = new Recaller('author')
  const hub = new Hub({ recaller })
  const draft = hub.checkout(bytesToHex(keys.publicKey), signer, 'home')
  const working = draft.checkout()
  working.set(files)
  draft.commit(working, 'seed')
  // Signing is scheduled, not immediate: commit appends the chunks now and the
  // SIG a tick later. Capturing before it lands hands the verifier a batch with
  // no signature, which it can neither accept nor reject.
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
  return { frames, publicKey: keys.publicKey, draft }
}

async function writeAll (stream, frames) {
  const writer = stream.getWriter()
  try {
    for (const frame of frames) await writer.write(frame)
    return null
  } catch (error) {
    return error
  }
}

describe(import.meta.url, ({ test }) => {
  test('a correctly signed batch is appended', async ({ assert }) => {
    const { frames, publicKey, draft } = await signedFrames({ 'hello.md': 'signed\n' })
    const record = new StreamoRecord({ recaller: new Recaller('good') })

    const error = await writeAll(makeVerifiedWritableStream(record, publicKey), frames)
    assert.equal(error, null)
    assert.equal(record.byteLength, draft.byteLength, 'the whole chain landed')
    assert.deepEqual(record.get(), { 'hello.md': 'signed\n' })
  })

  test('a batch signed by someone else is rejected and nothing lands', async ({ assert }) => {
    const { frames } = await signedFrames({ 'hello.md': 'signed\n' })
    const stranger = await new Signer('someone', 'else', 1000).keysFor('home')
    const record = new StreamoRecord({ recaller: new Recaller('wrong-key') })

    const error = await writeAll(makeVerifiedWritableStream(record, stranger.publicKey), frames)
    assert.ok(error, 'the write fails loudly')
    assert.ok(/verification-failed/.test(error.message), 'for the reason that matters')
    assert.equal(record.byteLength, 0, 'and the record is exactly as it was')
  })

  test('a tampered batch is rejected and nothing lands', async ({ assert }) => {
    const { frames, publicKey } = await signedFrames({ 'hello.md': 'signed\n' })
    const tampered = frames.map(frame => frame.slice())
    const target = tampered[0]
    target[Math.floor(target.length / 2)] ^= 0xff
    const record = new StreamoRecord({ recaller: new Recaller('tampered') })

    const error = await writeAll(makeVerifiedWritableStream(record, publicKey), tampered)
    assert.ok(error, 'flipping one byte is enough to fail')
    assert.equal(record.byteLength, 0, 'and nothing partial is left behind')
  })
})
