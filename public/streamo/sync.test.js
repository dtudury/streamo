import { describe } from './utils/testing.js'
import { RepoRegistry as StreamRegistry } from './RepoRegistry.js'
import { outletSync } from './outletSync.js'
import { originSync } from './originSync.js'

const KEY = 'aabbccddeeff0011'

// Wait until predicate(stream) returns true.
// Accesses stream.byteLength explicitly so the watcher re-runs on every append,
// regardless of whether the predicate itself touches a reactive path.
function waitFor (stream, predicate, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeout)
    let done = false
    stream.watch('waitFor', () => {
      if (!done && predicate(stream)) {
        done = true
        clearTimeout(t)
        resolve()
      }
    })
  })
}

describe(import.meta.url, ({ test }) => {
  test('outlet syncs existing stream data to a new origin', async ({ assert }) => {
    const serverRegistry = new StreamRegistry()
    const serverStream = await serverRegistry.open(KEY)
    serverStream.set({ hello: 'world' })

    const wss = outletSync(serverRegistry, 0)
    await new Promise(resolve => wss.on('listening', resolve))
    const { port } = wss.address()

    const clientRegistry = new StreamRegistry()
    const clientStream = await clientRegistry.open(KEY)
    const ws = await originSync(clientStream, KEY, 'localhost', port)

    await waitFor(clientStream, s => s.get('hello') === 'world')
    assert.equal(clientStream.get('hello'), 'world', 'client received server data')

    ws.close()
    for (const c of wss.clients) c.terminate()
    wss.close()
  })

  test('origin syncs local data up to the outlet', async ({ assert }) => {
    const serverRegistry = new StreamRegistry()
    const wss = outletSync(serverRegistry, 0)
    await new Promise(resolve => wss.on('listening', resolve))
    const { port } = wss.address()

    const clientRegistry = new StreamRegistry()
    const clientStream = await clientRegistry.open(KEY)
    clientStream.set({ from: 'client' })

    const ws = await originSync(clientStream, KEY, 'localhost', port)
    const serverStream = await serverRegistry.open(KEY)

    await waitFor(serverStream, s => s.get('from') === 'client')
    assert.equal(serverStream.get('from'), 'client', 'server received client data')

    ws.close()
    for (const c of wss.clients) c.terminate()
    wss.close()
  })

  test('two origins converge on the same state', async ({ assert }) => {
    const serverRegistry = new StreamRegistry()
    const wss = outletSync(serverRegistry, 0)
    await new Promise(resolve => wss.on('listening', resolve))
    const { port } = wss.address()

    const r1 = new StreamRegistry()
    const r2 = new StreamRegistry()
    const s1 = await r1.open(KEY)
    const s2 = await r2.open(KEY)

    s1.set({ x: 1 })
    s2.set({ x: 2 })  // will be a conflict at the streamo level, but both chunks land

    const ws1 = await originSync(s1, KEY, 'localhost', port)
    const ws2 = await originSync(s2, KEY, 'localhost', port)

    // Both clients should end up with the same byteLength once chunks propagate
    const serverStream = await serverRegistry.open(KEY)
    await waitFor(serverStream, s => s.byteLength >= s1.byteLength && s.byteLength >= s2.byteLength)
    await waitFor(s1, s => s.byteLength >= serverStream.byteLength)
    await waitFor(s2, s => s.byteLength >= serverStream.byteLength)

    assert.equal(s1.byteLength, s2.byteLength, 'both clients converged to same byteLength')
    assert.equal(s1.byteLength, serverStream.byteLength, 'clients match server')

    ws1.close(); ws2.close()
    for (const c of wss.clients) c.terminate()
    wss.close()
  })
})
