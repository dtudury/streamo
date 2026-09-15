import { WebSocketServer } from 'ws'

import { describe } from '../utils/testing.js'
import { Recaller } from '../utils/Recaller.js'
import { Signer } from '../Signer.js'
import { bytesToHex } from '../utils.js'
import { Hub } from './Hub.js'
import { Upstream } from './Upstream.js'
import { Downstream } from './Downstream.js'
import { wsConnection, connectWs } from './wsConnection.js'

async function listening (onConnection) {
  const server = new WebSocketServer({ port: 0 })
  server.on('connection', ws => onConnection(wsConnection(ws)))
  await new Promise(resolve => server.once('listening', resolve))
  return { server, url: `ws://localhost:${server.address().port}` }
}

describe(import.meta.url, ({ test }) => {
  test('strings stay strings and bytes stay bytes, both directions', async ({ assert }) => {
    let serverSide
    const { server, url } = await listening(connection => { serverSide = connection })
    try {
      const client = await connectWs(url)
      const heardByServer = []
      const heardByClient = []
      await new Promise(resolve => setTimeout(resolve, 20))
      serverSide.on('message', data => heardByServer.push(data))
      client.on('message', data => heardByClient.push(data))

      client.send('{"type":"want"}')
      client.send(new Uint8Array([1, 2, 3]))
      serverSide.send(new Uint8Array([4, 5]))
      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(heardByServer[0], '{"type":"want"}')
      assert.ok(heardByServer[1] instanceof Uint8Array)
      assert.deepEqual([...heardByServer[1]], [1, 2, 3])
      assert.ok(heardByClient[0] instanceof Uint8Array, 'a Buffer would also work, but Uint8Array is the contract')
      assert.deepEqual([...heardByClient[0]], [4, 5])

      const closed = new Promise(resolve => serverSide.on('close', resolve))
      client.close()
      await closed
    } finally {
      server.close()
    }
  })

  test('canon crosses a real WebSocket from one Hub to another', async ({ assert }) => {
    const signer = new Signer('user', 'pass', 1000)
    const key = bytesToHex((await signer.keysFor('home')).publicKey)
    const recaller = new Recaller('top')
    const top = new Hub({ recaller })
    const draft = top.checkout(key, signer, 'home')
    const working = draft.checkout()
    working.set({ 'hello.md': 'over a real socket\n' })
    draft.commit(working, 'seed')
    await recaller.when(() => draft.byteLength > 0 && draft.signedLength === draft.byteLength)
    const canon = top.getMirror(key)
    const reader = draft.makeReadableStream({ fromOffset: 0 }).getReader()
    const writer = canon.makeWritableStream().getWriter()
    while (canon.byteLength < draft.byteLength) {
      const { value, done } = await reader.read()
      if (done) break
      await writer.write(value)
    }
    writer.releaseLock()
    reader.cancel().catch(() => {})

    // eslint-disable-next-line no-new
    const { server, url } = await listening(connection => { new Downstream({ hub: top, connection }) })
    try {
      const clientRecaller = new Recaller('client')
      const upstream = new Upstream({ recaller: clientRecaller, connection: await connectWs(url) })
      upstream.hub.getMirror(key)
      await clientRecaller.when(() => upstream.hub.getMirror(key).byteLength >= canon.byteLength)

      assert.deepEqual(upstream.hub.getMirror(key).get(), { 'hello.md': 'over a real socket\n' })
      assert.notEqual(upstream.hub.getMirror(key), canon, 'two Hubs, two records')
      upstream.close()
    } finally {
      server.close()
    }
  })
})
