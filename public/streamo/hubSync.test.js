import { describe } from './utils/testing.js'
import { Recaller } from './utils/Recaller.js'
import { Signer } from './Signer.js'
import { Hub } from './Hub.js'
import { Upstream } from './Upstream.js'
import { Downstream } from './Downstream.js'
import { loopback } from './loopback.js'
import { bytesToHex } from './utils.js'

const settle = () => new Promise(resolve => setTimeout(resolve, 200))

async function aTopHubHolding (files) {
  const signer = new Signer('user', 'pass', 1000)
  const key = bytesToHex((await signer.keysFor('home')).publicKey)
  const hub = new Hub({ recaller: new Recaller('top') })
  const draft = hub.checkout(key, signer, 'home')
  const working = draft.checkout()
  working.set(files)
  draft.commit(working, 'seed')

  const canon = hub.getMirror(key)
  const reader = draft.makeReadableStream({ fromOffset: 0 }).getReader()
  const writer = canon.makeWritableStream().getWriter()
  while (canon.byteLength < draft.byteLength) {
    const { value, done } = await reader.read()
    if (done) break
    await writer.write(value)
  }
  writer.releaseLock()
  return { hub, key, canon }
}

function countingLoopback () {
  const [a, b] = loopback()
  const counted = { frames: 0, payloadBytes: 0 }
  const send = a.send.bind(a)
  a.send = data => {
    if (typeof data !== 'string') { counted.frames++; counted.payloadBytes += data.length - 33 }
    send(data)
  }
  return [a, b, counted]
}

describe(import.meta.url, ({ test }) => {
  test('canon crosses from one Hub to another, as bytes', async ({ assert }) => {
    const { hub, key, canon } = await aTopHubHolding({ 'hello.md': 'canon from the top\n' })
    const [serverEnd, clientEnd, wire] = countingLoopback()
    // eslint-disable-next-line no-new
    new Downstream({ hub, connection: serverEnd })
    const upstream = new Upstream({ recaller: new Recaller('client'), connection: clientEnd })

    upstream.hub.getMirror(key)
    await settle()

    const theirs = upstream.hub.getMirror(key)
    assert.equal(theirs.byteLength, canon.byteLength, 'the same chain arrived')
    assert.deepEqual(theirs.get(), canon.get(), 'and decodes to the same value')
    assert.notEqual(theirs, canon, 'two Hubs, two records — nothing is shared')

    assert.ok(wire.frames > 0, 'and it got there over the connection')
    assert.ok(wire.payloadBytes >= canon.byteLength,
      'carrying at least the chain — a test that can pass with no wire is testing nothing')
  })

  test('with nothing serving the other end, the client stays empty', async ({ assert }) => {
    const { key, canon } = await aTopHubHolding({ 'hello.md': 'canon from the top\n' })
    const [, clientEnd] = loopback()
    const upstream = new Upstream({ recaller: new Recaller('lonely'), connection: clientEnd })

    upstream.hub.getMirror(key)
    await settle()

    assert.ok(canon.byteLength > 0, 'the top has canon')
    assert.equal(upstream.hub.getMirror(key).byteLength, 0, 'the client has none of it')
    assert.equal(upstream.hub.getMirror(key).lastCommit, null, 'wanted, never reported')
  })
})
