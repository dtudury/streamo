import { describe } from './utils/testing.js'
import { RepoRegistry as StreamRegistry } from './RepoRegistry.js'
import { outletSync } from './outletSync.js'
import { originSync } from './originSync.js'
import { Signer } from './Signer.js'
import { bytesToHex } from './utils.js'

// Under the hash-chain model, makeVerifiedWritableStream stages every chunk
// until a covering SIG verifies — so these end-to-end sync tests need a real
// keypair whose hex matches the repo's KEY, and a signer attached so the
// writer's set() auto-emits a signature that the receiver can verify.
const SIGNER = new Signer('alice', 'hunter2', 1)
const NAME = 'sync-test'
let KEY
async function ensureKey () {
  if (KEY) return KEY
  const { publicKey } = await SIGNER.keysFor(NAME)
  KEY = bytesToHex(publicKey)
  return KEY
}

async function openSigned (registry) {
  const key = await ensureKey()
  const repo = await registry.open(key)
  repo.attachSigner(SIGNER, NAME)
  return repo
}

// Wait until predicate(stream) returns true.
// Accesses stream.byteLength explicitly so the watcher re-runs on every append,
// regardless of whether the predicate itself touches a reactive path.
function waitFor (stream, predicate, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeout)
    let done = false
    stream.recaller.watch('waitFor', () => {
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
    const serverStream = await openSigned(serverRegistry)
    serverStream.set({ hello: 'world' })

    const wss = outletSync(serverRegistry, 0)
    await new Promise(resolve => wss.on('listening', resolve))
    const { port } = wss.address()

    const clientRegistry = new StreamRegistry()
    const clientStream = await clientRegistry.open(await ensureKey())
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
    const clientStream = await openSigned(clientRegistry)
    clientStream.set({ from: 'client' })

    const ws = await originSync(clientStream, KEY, 'localhost', port)
    const serverStream = await serverRegistry.open(KEY)

    await waitFor(serverStream, s => s.get('from') === 'client')
    assert.equal(serverStream.get('from'), 'client', 'server received client data')

    ws.close()
    for (const c of wss.clients) c.terminate()
    wss.close()
  })

  test('two origins converge on the same byte stream', async ({ assert }) => {
    // Two devices sharing the same identity (same Signer / keypair) — under
    // single-author-signed-chain, both writers must own the private key to
    // contribute. This models "alice on her phone and her laptop."
    const serverRegistry = new StreamRegistry()
    const wss = outletSync(serverRegistry, 0)
    await new Promise(resolve => wss.on('listening', resolve))
    const { port } = wss.address()

    const r1 = new StreamRegistry()
    const r2 = new StreamRegistry()
    const s1 = await openSigned(r1)
    const s2 = await openSigned(r2)

    s1.set({ x: 1 })
    s2.set({ x: 2 })

    // Conflicting commits at the same byte offsets; both arrive at the server
    // and each other via dedup-append.  byteLength convergence is all we can
    // assert here (the merged stream contains all unique chunks from both
    // writers but the second writer's value address is no longer valid in the
    // merged layout — known limitation; see ROADMAP "multi-device write
    // conflict detection").
    const ws1 = await originSync(s1, KEY, 'localhost', port)
    const ws2 = await originSync(s2, KEY, 'localhost', port)

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

  test('relay forwards data between server and client without writing its own commits', async ({ assert }) => {
    // Server
    const serverRegistry = new StreamRegistry()
    const serverStream = await openSigned(serverRegistry)
    serverStream.set({ hello: 'from-server' })
    const serverWss = outletSync(serverRegistry, 0)
    await new Promise(resolve => serverWss.on('listening', resolve))
    const serverPort = serverWss.address().port

    // Relay: originSync upstream to server, outletSync downstream for clients.
    // The relay never calls set() or commit() — it only accumulates and re-serves
    // the byte stream it receives.
    const relayRegistry = new StreamRegistry()
    const relayStream = await relayRegistry.open(await ensureKey())
    await originSync(relayStream, KEY, 'localhost', serverPort)
    const relayWss = outletSync(relayRegistry, 0)
    await new Promise(resolve => relayWss.on('listening', resolve))
    const relayPort = relayWss.address().port

    // Client connects to relay only — no direct server connection. Client owns
    // the keypair so it can write back through the relay.
    const clientRegistry = new StreamRegistry()
    const clientStream = await openSigned(clientRegistry)
    const clientWs = await originSync(clientStream, KEY, 'localhost', relayPort)

    // Server data reaches client via relay
    await waitFor(clientStream, s => s.get('hello') === 'from-server')
    assert.equal(clientStream.get('hello'), 'from-server', 'relay forwarded server data to client')

    // Client data propagates back through relay to server
    clientStream.set({ hello: 'from-client' })
    await waitFor(serverStream, s => s.get('hello') === 'from-client')
    assert.equal(serverStream.get('hello'), 'from-client', 'relay forwarded client data to server')

    clientWs.close()
    for (const c of relayWss.clients) c.terminate()
    relayWss.close()
    for (const c of serverWss.clients) c.terminate()
    serverWss.close()
  })
})
