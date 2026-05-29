import { describe } from './utils/testing.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { StreamoRecordRegistry } from './StreamoRecordRegistry.js'
import { Recaller } from './utils/Recaller.js'
import { outletSync } from './outletSync.js'
import { originSync } from './originSync.js'
import { Signer } from './Signer.js'
import { bytesToHex } from './utils.js'

// Per-registry writable-keys set: openSigned adds its key before the
// factory materializes it, so the produced Record is Writable and
// supports attachSigner. Foreign keys (e.g., the relay-side mirror in
// the dumb-pipe test) stay slim.
const writableKeysFor = new WeakMap()
const newRegistry = () => {
  const recaller = new Recaller('sync-test')
  const writableKeys = new Set()
  const registry = new StreamoRecordRegistry({
    recaller,
    factory: key => writableKeys.has(key)
      ? new WritableStreamoRecord({ recaller })
      : new StreamoRecord({ recaller })
  })
  writableKeysFor.set(registry, writableKeys)
  return registry
}

// Under the relay-as-authority model, the relay's StreamoRecordSerializer gates every
// incoming batch via chain + crypto checks — so these end-to-end sync tests
// need a real keypair whose hex matches the repo's KEY, and a signer attached
// so the writer's set() auto-emits a signature that the relay can verify.
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
  writableKeysFor.get(registry).add(key)
  const repo = await registry._materialize(key)
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
    const serverRegistry = newRegistry()
    const serverStream = await openSigned(serverRegistry)
    serverStream.set({ hello: 'world' })

    const wss = outletSync(serverRegistry, 0)
    await new Promise(resolve => wss.on('listening', resolve))
    const { port } = wss.address()

    const clientRegistry = newRegistry()
    const clientStream = await clientRegistry._materialize(await ensureKey())
    const ws = await originSync(clientStream, KEY, 'localhost', port)

    await waitFor(clientStream, s => s.get('hello') === 'world')
    assert.equal(clientStream.get('hello'), 'world', 'client received server data')

    ws.close()
    for (const c of wss.clients) c.terminate()
    wss.close()
  })

  test('origin syncs local data up to the outlet', async ({ assert }) => {
    const serverRegistry = newRegistry()
    const wss = outletSync(serverRegistry, 0)
    await new Promise(resolve => wss.on('listening', resolve))
    const { port } = wss.address()

    const clientRegistry = newRegistry()
    const clientStream = await openSigned(clientRegistry)
    clientStream.set({ from: 'client' })

    const ws = await originSync(clientStream, KEY, 'localhost', port)
    const serverStream = await serverRegistry._materialize(KEY)

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
    const serverRegistry = newRegistry()
    const wss = outletSync(serverRegistry, 0)
    await new Promise(resolve => wss.on('listening', resolve))
    const { port } = wss.address()

    const r1 = newRegistry()
    const r2 = newRegistry()
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

    const serverStream = await serverRegistry._materialize(KEY)
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
    const serverRegistry = newRegistry()
    const serverStream = await openSigned(serverRegistry)
    serverStream.set({ hello: 'from-server' })
    const serverWss = outletSync(serverRegistry, 0)
    await new Promise(resolve => serverWss.on('listening', resolve))
    const serverPort = serverWss.address().port

    // Relay: originSync upstream to server, outletSync downstream for clients.
    // The relay never calls set() or commit() — it only accumulates and re-serves
    // the byte stream it receives.
    const relayRegistry = newRegistry()
    const relayStream = await relayRegistry._materialize(await ensureKey())
    await originSync(relayStream, KEY, 'localhost', serverPort)
    const relayWss = outletSync(relayRegistry, 0)
    await new Promise(resolve => relayWss.on('listening', resolve))
    const relayPort = relayWss.address().port

    // Client connects to relay only — no direct server connection. Client owns
    // the keypair so it can write back through the relay.
    const clientRegistry = newRegistry()
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

  test('originSync retries first-connect until the upstream comes up (spoke before hub)', async ({ assert }) => {
    // Spoke-before-hub: the client (spoke) is launched before the server
    // (hub). The substrate's job is "be connected to canonical" — that
    // works whether the host was already up or comes up later. This
    // test verifies that the first-connect retry loop succeeds when
    // the upstream becomes available.
    //
    // We grab a free port by binding a temp server and closing it, then
    // start the client connecting to that port. Brief window of "no
    // server on this port" — the client should fail-then-retry instead
    // of rejecting. Then we bring the real server up; the next retry
    // attempt connects.
    const { createServer } = await import('net')
    const port = await new Promise(resolve => {
      const tmp = createServer()
      tmp.listen(0, () => {
        const p = tmp.address().port
        tmp.close(() => resolve(p))
      })
    })

    const clientRegistry = newRegistry()
    const clientStream = await openSigned(clientRegistry)
    clientStream.set({ from: 'spoke-before-hub' })

    // Start the client connecting to a port nobody's listening on.
    // retryBaseMs: 20 keeps the test fast (retries every ~20ms with jitter).
    const wsPromise = originSync(clientStream, KEY, 'localhost', port, { retryBaseMs: 20 })

    // Let the client miss at least once before the server comes up.
    await new Promise(r => setTimeout(r, 50))

    // Bring up the hub. The client's retry loop should pick it up.
    const serverRegistry = newRegistry()
    const wss = outletSync(serverRegistry, port)
    await new Promise(resolve => wss.on('listening', resolve))

    const ws = await wsPromise
    const serverStream = await serverRegistry._materialize(KEY)
    await waitFor(serverStream, s => s.get('from') === 'spoke-before-hub', 3000)
    assert.equal(serverStream.get('from'), 'spoke-before-hub',
      'spoke that started before hub eventually synced')

    ws.close()
    for (const c of wss.clients) c.terminate()
    wss.close()
  })

  test('originSync respects retryFirstConnect: false (fail-fast opt-out)', async ({ assert }) => {
    // Opt-out: callers who want a definitive "is this reachable?" answer
    // (tests, ping-style verbs) keep the old fail-fast behavior.
    const { createServer } = await import('net')
    const port = await new Promise(resolve => {
      const tmp = createServer()
      tmp.listen(0, () => {
        const p = tmp.address().port
        tmp.close(() => resolve(p))
      })
    })

    const clientRegistry = newRegistry()
    const clientStream = await openSigned(clientRegistry)

    let rejected = false
    try {
      await originSync(clientStream, KEY, 'localhost', port, { retryFirstConnect: false })
    } catch (e) {
      rejected = true
    }
    assert.ok(rejected, 'retryFirstConnect: false rejects on first-connect failure')
  })
})
