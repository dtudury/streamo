import { WebSocketServer } from 'ws'
import { describe } from './utils/testing.js'
import { RepoRegistry } from './RepoRegistry.js'
import { attachStreamSync } from './outletSync.js'
import { registrySync } from './registrySync.js'
import { Signer } from './Signer.js'
import { bytesToHex } from './utils.js'

// Under the hash-chain model, makeVerifiedWritableStream stages chunks until
// a covering SIG verifies — fake keys can no longer carry data. Each "slot"
// that flows data gets a real keypair derived deterministically from the
// shared Signer and a stable name; `openWriter(registry, N)` opens the repo
// and attaches the signer so writes auto-sign.
const SIGNER = new Signer('alice', 'hunter2', 1)
const keyCache = new Map()
async function realKey (n) {
  if (!keyCache.has(n)) {
    const name = `key-${n}`
    const { publicKey } = await SIGNER.keysFor(name)
    keyCache.set(n, { name, hex: bytesToHex(publicKey) })
  }
  return keyCache.get(n)
}
async function openWriter (registry, n) {
  const { name, hex } = await realKey(n)
  const repo = await registry.open(hex)
  repo.attachSigner(SIGNER, name)
  return { repo, hex }
}
// Topics for interest/announce don't need to be valid keys (no data flows
// over them) — short hex strings keep the tests fast.  33 bytes = compressed
// pubkey size; format matches what the routing layer expects.
const fakeKey = (n = 0) => '02' + n.toString(16).padStart(2, '0').repeat(32)

/** Wait up to `ms` ms for `fn()` to return truthy, polling every 10 ms. */
function waitFor (fn, ms = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const poll = () => {
      const v = fn()
      if (v) return resolve(v)
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

/** Start a WebSocketServer on a random port backed by a registry. */
function startServer (registry) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('listening', () => {
      const { port } = wss.address()
      attachStreamSync(wss, registry, 'test-outlet')
      resolve({ wss, port })
    })
    wss.on('error', reject)
  })
}

describe(import.meta.url, ({ test }) => {
  test('onOpen fires after registry.open resolves', async ({ assert }) => {
    const registry = new RepoRegistry()
    const calls = []
    registry.onOpen((key, repo) => calls.push({ key, repo }))
    const repo = await registry.open('abc')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].key, 'abc')
    assert.ok(calls[0].repo === repo)
  })

  test('offOpen removes the callback', async ({ assert }) => {
    const registry = new RepoRegistry()
    let count = 0
    const cb = () => count++
    registry.onOpen(cb)
    await registry.open('x')
    registry.offOpen(cb)
    await registry.open('y')
    assert.equal(count, 1)
  })

  test('onOpen not called for already-open key (concurrent open)', async ({ assert }) => {
    const registry = new RepoRegistry()
    let count = 0
    registry.onOpen(() => count++)
    await Promise.all([registry.open('k'), registry.open('k'), registry.open('k')])
    assert.equal(count, 1)
  })

  test('two registries sync an existing repo via registrySync', async ({ assert }) => {
    const serverRegistry = new RepoRegistry()
    const { wss, port } = await startServer(serverRegistry)

    const { repo: serverRepo, hex: keyHex } = await openWriter(serverRegistry, 1)
    serverRepo.set({ hello: 'world' })

    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port, { filter: k => k === keyHex })

    await waitFor(() => clientRegistry.get(keyHex)?.get('hello') === 'world')
    assert.equal(clientRegistry.get(keyHex).get('hello'), 'world')

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('changes on server after connect are synced to client', async ({ assert }) => {
    const serverRegistry = new RepoRegistry()
    const { wss, port } = await startServer(serverRegistry)

    const { repo: serverRepo, hex: keyHex } = await openWriter(serverRegistry, 2)
    serverRepo.set({ v: 1 })

    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port, { filter: k => k === keyHex })

    await waitFor(() => clientRegistry.get(keyHex)?.get('v') === 1)

    serverRepo.set({ v: 2 })
    await waitFor(() => clientRegistry.get(keyHex)?.get('v') === 2)
    assert.equal(clientRegistry.get(keyHex).get('v'), 2)

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('newly opened server repos are announced and synced', async ({ assert }) => {
    const serverRegistry = new RepoRegistry()
    const { wss, port } = await startServer(serverRegistry)

    const { hex: keyHex } = await realKey(3)
    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port)

    const { repo: serverRepo } = await openWriter(serverRegistry, 3)
    serverRepo.set({ late: true })

    await waitFor(() => clientRegistry.get(keyHex)?.get('late') === true)
    assert.equal(clientRegistry.get(keyHex).get('late'), true)

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('filter prevents unwanted repos from syncing', async ({ assert }) => {
    const serverRegistry = new RepoRegistry()
    const { wss, port } = await startServer(serverRegistry)

    const { repo: repoA, hex: keyA } = await openWriter(serverRegistry, 4)
    repoA.set({ name: 'a' })
    const { repo: repoB, hex: keyB } = await openWriter(serverRegistry, 5)
    repoB.set({ name: 'b' })

    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port, { filter: k => k === keyA })

    await waitFor(() => clientRegistry.get(keyA)?.get('name') === 'a')
    assert.equal(clientRegistry.get(keyA).get('name'), 'a')

    await new Promise(r => setTimeout(r, 100))
    assert.equal(clientRegistry.get(keyB), undefined, 'keyB was filtered out')

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('two peers with different repos each sync both after connecting', async ({ assert }) => {
    const registryA = new RepoRegistry()
    const registryB = new RepoRegistry()

    const { repo: repoA, hex: keyA } = await openWriter(registryA, 6)
    repoA.set({ owner: 'A' })
    const { repo: repoB, hex: keyB } = await openWriter(registryB, 7)
    repoB.set({ owner: 'B' })

    const { wss, port } = await startServer(registryA)
    const { ws } = await registrySync(registryB, 'localhost', port)

    await waitFor(() => registryA.get(keyB)?.get('owner') === 'B')
    await waitFor(() => registryB.get(keyA)?.get('owner') === 'A')

    assert.equal(registryA.get(keyB).get('owner'), 'B')
    assert.equal(registryB.get(keyA).get('owner'), 'A')

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('follow: auto-subscribes to repos referenced in a synced repo\'s value', async ({ assert }) => {
    // Simulates a chat app: rootRepo lists participant keys; client follows the
    // root and should automatically discover and sync all participant repos.
    const serverRegistry = new RepoRegistry()
    const { wss, port } = await startServer(serverRegistry)

    const { repo: rootRepo, hex: rootKey } = await openWriter(serverRegistry, 10)
    const { repo: aliceRepo, hex: aliceKey } = await openWriter(serverRegistry, 11)
    const { repo: bobRepo, hex: bobKey } = await openWriter(serverRegistry, 12)

    aliceRepo.set({ name: 'alice', message: 'hello' })
    bobRepo.set({ name: 'bob', message: 'hey' })
    rootRepo.set({ members: [aliceKey, bobKey] })

    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port, {
      filter: k => k === rootKey,  // only explicitly subscribe to root
      follow: (keyHex, repo, subscribe) => {
        // extract participant keys from the chat repo
        for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
      }
    })

    // Root syncs via filter; participants sync via follow
    await waitFor(() => clientRegistry.get(aliceKey)?.get('name') === 'alice')
    await waitFor(() => clientRegistry.get(bobKey)?.get('name') === 'bob')

    assert.equal(clientRegistry.get(aliceKey).get('name'), 'alice')
    assert.equal(clientRegistry.get(bobKey).get('name'), 'bob')

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('follow: re-runs when a repo changes and discovers newly added refs', async ({ assert }) => {
    const serverRegistry = new RepoRegistry()
    const { wss, port } = await startServer(serverRegistry)

    const { repo: rootRepo, hex: rootKey } = await openWriter(serverRegistry, 13)
    const { hex: carolKey } = await realKey(14)
    rootRepo.set({ members: [] })  // starts empty

    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port, {
      filter: k => k === rootKey,
      follow: (keyHex, repo, subscribe) => {
        for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
      }
    })

    await waitFor(() => clientRegistry.get(rootKey)?.get('members') !== undefined)

    // Carol joins: her repo is added to the server, root is updated to list her
    const { repo: carolRepo } = await openWriter(serverRegistry, 14)
    carolRepo.set({ name: 'carol' })
    rootRepo.set({ members: [carolKey] })

    await waitFor(() => clientRegistry.get(carolKey)?.get('name') === 'carol')
    assert.equal(clientRegistry.get(carolKey).get('name'), 'carol')

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('announce is routed to interested peers', async ({ assert }) => {
    const { wss, port } = await startServer(new RepoRegistry())
    const topic = fakeKey(20)
    const announced = fakeKey(21)

    const received = []
    const sessionA = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key, t) => received.push({ key, topic: t })
    })
    sessionA.interest(topic)

    const sessionB = await registrySync(new RepoRegistry(), 'localhost', port)

    // Give the interest message time to reach the server
    await new Promise(r => setTimeout(r, 50))
    sessionB.announce(announced, topic)

    await waitFor(() => received.length === 1)
    assert.equal(received[0].key, announced)
    assert.equal(received[0].topic, topic)

    sessionA.close()
    sessionB.close()
    await new Promise(r => wss.close(r))
  })

  test('announce is not received without interest', async ({ assert }) => {
    const { wss, port } = await startServer(new RepoRegistry())
    const topic = fakeKey(22)
    const announced = fakeKey(23)

    const received = []
    const sessionA = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key) => received.push(key)
    })
    // sessionA does NOT call interest(topic)

    const sessionB = await registrySync(new RepoRegistry(), 'localhost', port)
    await new Promise(r => setTimeout(r, 50))
    sessionB.announce(announced, topic)

    await new Promise(r => setTimeout(r, 100))
    assert.equal(received.length, 0, 'no announcements without interest')

    sessionA.close()
    sessionB.close()
    await new Promise(r => wss.close(r))
  })

  test('announce reaches multiple interested peers', async ({ assert }) => {
    const { wss, port } = await startServer(new RepoRegistry())
    const topic = fakeKey(24)
    const announced = fakeKey(25)

    const receivedA = [], receivedB = []
    const sessionA = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key) => receivedA.push(key)
    })
    const sessionB = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key) => receivedB.push(key)
    })
    sessionA.interest(topic)
    sessionB.interest(topic)

    const sessionC = await registrySync(new RepoRegistry(), 'localhost', port)
    await new Promise(r => setTimeout(r, 50))
    sessionC.announce(announced, topic)

    await waitFor(() => receivedA.length === 1 && receivedB.length === 1)
    assert.equal(receivedA[0], announced)
    assert.equal(receivedB[0], announced)

    sessionA.close()
    sessionB.close()
    sessionC.close()
    await new Promise(r => wss.close(r))
  })

  test('announce is not echoed back to the sender', async ({ assert }) => {
    const { wss, port } = await startServer(new RepoRegistry())
    const topic = fakeKey(26)
    const announced = fakeKey(27)

    const received = []
    const session = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key) => received.push(key)
    })
    session.interest(topic)

    await new Promise(r => setTimeout(r, 50))
    session.announce(announced, topic)  // sender declares interest and announces

    await new Promise(r => setTimeout(r, 100))
    assert.equal(received.length, 0, 'sender should not receive its own announcement')

    session.close()
    await new Promise(r => wss.close(r))
  })

  test('after disconnect, interest is cleaned up and announcements stop', async ({ assert }) => {
    const { wss, port } = await startServer(new RepoRegistry())
    const topic = fakeKey(28)
    const announced = fakeKey(29)

    const received = []
    const sessionA = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key) => received.push(key)
    })
    sessionA.interest(topic)

    const sessionB = await registrySync(new RepoRegistry(), 'localhost', port)

    // Confirm routing works before disconnect
    await new Promise(r => setTimeout(r, 50))
    sessionB.announce(announced, topic)
    await waitFor(() => received.length === 1)

    // Disconnect A, then announce again
    sessionA.close()
    await new Promise(r => setTimeout(r, 50))
    sessionB.announce(announced, topic)

    await new Promise(r => setTimeout(r, 100))
    assert.equal(received.length, 1, 'no more announcements after disconnect')

    sessionB.close()
    await new Promise(r => wss.close(r))
  })
})
