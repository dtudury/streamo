import { WebSocketServer } from 'ws'
import { describe } from './utils/testing.js'
import { RepoRegistry } from './RepoRegistry.js'
import { attachStreamSync } from './outletSync.js'
import { registrySync } from './registrySync.js'
import { Signer } from './Signer.js'
import { bytesToHex } from './utils.js'

// Under the relay-as-authority model, the RepoSerializer at the relay gates
// every incoming batch — fake keys can no longer carry data. Each "slot"
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

/** Start a WebSocketServer on a random port backed by a registry.
 *  Pass `homeKey` to make the server announce a home repo on the handshake,
 *  causing connecting clients to auto-subscribe to it (the production shape).
 *  Omit `homeKey` for raw peer-to-peer tests where neither side has a public face. */
function startServer (registry, homeKey = null) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('listening', () => {
      const { port } = wss.address()
      const peerOptions = homeKey ? { home: homeKey } : {}
      attachStreamSync(wss, registry, 'test-outlet', peerOptions)
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
    const { repo: serverRepo, hex: keyHex } = await openWriter(serverRegistry, 1)
    serverRepo.set({ hello: 'world' })

    const { wss, port } = await startServer(serverRegistry, keyHex)
    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port)

    await waitFor(() => clientRegistry.get(keyHex)?.get('hello') === 'world')
    assert.equal(clientRegistry.get(keyHex).get('hello'), 'world')

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('changes on server after connect are synced to client', async ({ assert }) => {
    const serverRegistry = new RepoRegistry()
    const { repo: serverRepo, hex: keyHex } = await openWriter(serverRegistry, 2)
    serverRepo.set({ v: 1 })

    const { wss, port } = await startServer(serverRegistry, keyHex)
    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port)

    await waitFor(() => clientRegistry.get(keyHex)?.get('v') === 1)

    serverRepo.set({ v: 2 })
    await waitFor(() => clientRegistry.get(keyHex)?.get('v') === 2)
    assert.equal(clientRegistry.get(keyHex).get('v'), 2)

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('repos added to home.members after connect get synced', async ({ assert }) => {
    // The new shape: discovery cascades through home.value.members via `follow`.
    // When the home repo gains a new member after the client is connected, the
    // follow callback re-fires and the client subscribes to the newcomer.
    const serverRegistry = new RepoRegistry()
    const { repo: homeRepo, hex: homeKey } = await openWriter(serverRegistry, 3)
    homeRepo.set({ members: [] })

    const { wss, port } = await startServer(serverRegistry, homeKey)
    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port, {
      follow: (k, repo, subscribe) => {
        for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
      }
    })
    await waitFor(() => clientRegistry.get(homeKey)?.get('members')?.length === 0)

    // Newcomer joins: open their repo on the server and add to home.members.
    const { repo: newRepo, hex: newKey } = await openWriter(serverRegistry, 31)
    newRepo.set({ late: true })
    homeRepo.set({ members: [newKey] })

    await waitFor(() => clientRegistry.get(newKey)?.get('late') === true)
    assert.equal(clientRegistry.get(newKey).get('late'), true)

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('private repos (not in home.members) do not sync without explicit subscribe', async ({ assert }) => {
    // The security claim of obsecurity: a relay can hold private repos that
    // are NOT announced. Connecting clients receive only home + home.members;
    // private keys can still be fetched, but only when explicitly subscribed.
    const serverRegistry = new RepoRegistry()
    const { repo: homeRepo, hex: homeKey } = await openWriter(serverRegistry, 4)
    homeRepo.set({ members: [] })

    const { repo: privateRepo, hex: privateKey } = await openWriter(serverRegistry, 5)
    privateRepo.set({ name: 'secret' })

    const { wss, port } = await startServer(serverRegistry, homeKey)
    const clientRegistry = new RepoRegistry()
    const session = await registrySync(clientRegistry, 'localhost', port)

    // Home syncs (auto-subscribed via hello).
    await waitFor(() => clientRegistry.get(homeKey)?.get('members') !== undefined)

    // Private repo did NOT sync — it isn't in members and we didn't ask for it.
    await new Promise(r => setTimeout(r, 100))
    assert.equal(clientRegistry.get(privateKey), undefined, 'private repo was not announced')

    // But explicit subscribe pulls it down — privacy through obscurity, not
    // authorization. Anyone who knows the key can still sync it.
    session.subscribe(privateKey)
    await waitFor(() => clientRegistry.get(privateKey)?.get('name') === 'secret')
    assert.equal(clientRegistry.get(privateKey).get('name'), 'secret')

    session.ws.close()
    await new Promise(r => wss.close(r))
  })

  test('two peers each push their own repo via explicit subscribe', async ({ assert }) => {
    // Without a catalog mechanism, peers don't auto-broadcast their own repos —
    // each side explicitly subscribes for keys it wants to push or pull. This
    // is the p2p shape: no relay-blessed public face, just mutual consent.
    const registryA = new RepoRegistry()
    const registryB = new RepoRegistry()

    const { repo: repoA, hex: keyA } = await openWriter(registryA, 6)
    repoA.set({ owner: 'A' })
    const { repo: repoB, hex: keyB } = await openWriter(registryB, 7)
    repoB.set({ owner: 'B' })

    const { wss, port } = await startServer(registryA)
    const session = await registrySync(registryB, 'localhost', port)

    // B asks to sync both keys; subscribe is bidirectional, so each key flows
    // in whichever direction has data to share.
    session.subscribe(keyA)
    session.subscribe(keyB)

    await waitFor(() => registryA.get(keyB)?.get('owner') === 'B')
    await waitFor(() => registryB.get(keyA)?.get('owner') === 'A')

    assert.equal(registryA.get(keyB).get('owner'), 'B')
    assert.equal(registryB.get(keyA).get('owner'), 'A')

    session.ws.close()
    await new Promise(r => wss.close(r))
  })

  test('session.subscribe returns the live Repo (open + wire-plumb in one verb)', async ({ assert }) => {
    // The everyday "I want this key live" pattern: subscribe opens locally,
    // sets up the wire, and hands you the Repo. Idempotent — calling twice
    // returns the same Repo, no double-subscription side effects.
    const serverRegistry = new RepoRegistry()
    const { repo: serverRepo, hex: key } = await openWriter(serverRegistry, 20)
    serverRepo.set({ greeting: 'hi from the server' })

    const { wss, port } = await startServer(serverRegistry)
    const clientRegistry = new RepoRegistry()
    const session = await registrySync(clientRegistry, 'localhost', port)

    const repo = await session.subscribe(key)
    assert.ok(repo, 'subscribe should resolve to a Repo')
    assert.ok(repo === clientRegistry.get(key), 'returned Repo is the same instance the registry holds')

    await waitFor(() => repo.get('greeting') === 'hi from the server')
    assert.equal(repo.get('greeting'), 'hi from the server')

    // Idempotent: a second subscribe returns the same Repo without churn.
    const repo2 = await session.subscribe(key)
    assert.ok(repo === repo2, 'second subscribe returns the same Repo instance')

    session.ws.close()
    await new Promise(r => wss.close(r))
  })

  test('follow: auto-subscribes to repos referenced in the home repo\'s value', async ({ assert }) => {
    // Simulates a chat app: rootRepo lists participant keys; client connects,
    // auto-subscribes to root (via hello), follow callback walks members,
    // each participant is subscribed in turn.
    const serverRegistry = new RepoRegistry()
    const { repo: rootRepo, hex: rootKey } = await openWriter(serverRegistry, 10)
    const { repo: aliceRepo, hex: aliceKey } = await openWriter(serverRegistry, 11)
    const { repo: bobRepo, hex: bobKey } = await openWriter(serverRegistry, 12)

    aliceRepo.set({ name: 'alice', message: 'hello' })
    bobRepo.set({ name: 'bob', message: 'hey' })
    rootRepo.set({ members: [aliceKey, bobKey] })

    const { wss, port } = await startServer(serverRegistry, rootKey)
    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port, {
      follow: (keyHex, repo, subscribe) => {
        for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
      }
    })

    // Root auto-subscribes via hello; participants cascade via follow.
    await waitFor(() => clientRegistry.get(aliceKey)?.get('name') === 'alice')
    await waitFor(() => clientRegistry.get(bobKey)?.get('name') === 'bob')

    assert.equal(clientRegistry.get(aliceKey).get('name'), 'alice')
    assert.equal(clientRegistry.get(bobKey).get('name'), 'bob')

    ws.close()
    await new Promise(r => wss.close(r))
  })

  test('follow: re-runs when home changes and discovers newly added refs', async ({ assert }) => {
    const serverRegistry = new RepoRegistry()
    const { repo: rootRepo, hex: rootKey } = await openWriter(serverRegistry, 13)
    const { hex: carolKey } = await realKey(14)
    rootRepo.set({ members: [] })  // starts empty

    const { wss, port } = await startServer(serverRegistry, rootKey)
    const clientRegistry = new RepoRegistry()
    const { ws } = await registrySync(clientRegistry, 'localhost', port, {
      follow: (keyHex, repo, subscribe) => {
        for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
      }
    })

    await waitFor(() => clientRegistry.get(rootKey)?.get('members') !== undefined)

    // Carol joins: her repo is added to the server, root is updated to list her.
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

  test('late interest replays current announces (newcomer learns about prior peers)', async ({ assert }) => {
    // The closing-the-loop case: alice announces on a topic, then later bob
    // connects and expresses interest in the same topic. Without replay, bob
    // never learns about alice unless alice keeps heartbeating. With replay,
    // bob receives alice's announce immediately as part of his interest.
    const { wss, port } = await startServer(new RepoRegistry())
    const topic = fakeKey(40)
    const aliceKey = fakeKey(41)

    const sessionAlice = await registrySync(new RepoRegistry(), 'localhost', port)
    sessionAlice.announce(aliceKey, topic)

    // Give the announce time to register on the server before bob connects.
    await new Promise(r => setTimeout(r, 50))

    const received = []
    const sessionBob = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key, t) => received.push({ key, topic: t })
    })
    sessionBob.interest(topic)

    await waitFor(() => received.length === 1)
    assert.equal(received[0].key, aliceKey)
    assert.equal(received[0].topic, topic)

    sessionAlice.close()
    sessionBob.close()
    await new Promise(r => wss.close(r))
  })

  test('late interest replay does not echo the newcomer\'s own prior announces', async ({ assert }) => {
    // If the same socket announces and then expresses interest, the replay
    // should not bounce its own announces back at it.
    const { wss, port } = await startServer(new RepoRegistry())
    const topic = fakeKey(42)
    const selfKey = fakeKey(43)

    const received = []
    const session = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key) => received.push(key)
    })
    session.announce(selfKey, topic)
    await new Promise(r => setTimeout(r, 50))
    session.interest(topic)

    await new Promise(r => setTimeout(r, 100))
    assert.equal(received.length, 0, 'sender should not receive its own prior announce via replay')

    session.close()
    await new Promise(r => wss.close(r))
  })

  test('disconnected peers\' announces are dropped from replay', async ({ assert }) => {
    // Once alice disconnects, her announce is gone — a later-arriving bob
    // should not learn about her stale presence. Replay is "currently live,"
    // not "ever announced."
    const { wss, port } = await startServer(new RepoRegistry())
    const topic = fakeKey(44)
    const aliceKey = fakeKey(45)

    const sessionAlice = await registrySync(new RepoRegistry(), 'localhost', port)
    sessionAlice.announce(aliceKey, topic)
    await new Promise(r => setTimeout(r, 50))
    sessionAlice.close()
    await new Promise(r => setTimeout(r, 50))

    const received = []
    const sessionBob = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key) => received.push(key)
    })
    sessionBob.interest(topic)

    await new Promise(r => setTimeout(r, 100))
    assert.equal(received.length, 0, 'no stale replay after announcer disconnects')

    sessionBob.close()
    await new Promise(r => wss.close(r))
  })

  test('replay covers multiple existing announcers on the same topic', async ({ assert }) => {
    // Three peers already in a topic; a fourth joins and learns about all of them.
    const { wss, port } = await startServer(new RepoRegistry())
    const topic = fakeKey(46)
    const aliceKey = fakeKey(47)
    const bobKey   = fakeKey(48)
    const carolKey = fakeKey(49)

    const sessionAlice = await registrySync(new RepoRegistry(), 'localhost', port)
    const sessionBob   = await registrySync(new RepoRegistry(), 'localhost', port)
    const sessionCarol = await registrySync(new RepoRegistry(), 'localhost', port)
    sessionAlice.announce(aliceKey, topic)
    sessionBob.announce(bobKey,     topic)
    sessionCarol.announce(carolKey, topic)
    await new Promise(r => setTimeout(r, 50))

    const received = []
    const sessionDavid = await registrySync(new RepoRegistry(), 'localhost', port, {
      onAnnounce: (key) => received.push(key)
    })
    sessionDavid.interest(topic)

    await waitFor(() => received.length === 3)
    assert.equal(new Set(received).size, 3, 'all three announcers represented')
    assert.ok(received.includes(aliceKey))
    assert.ok(received.includes(bobKey))
    assert.ok(received.includes(carolKey))

    sessionAlice.close()
    sessionBob.close()
    sessionCarol.close()
    sessionDavid.close()
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

  test('relay refuses a divergent push: server top unchanged; bad client signals the divergence', async ({ assert }) => {
    // Relay has apple committed. A bad client opens a *fresh* repo with the
    // same key and writes banana locally — signed against the empty chain,
    // not against apple. When the bad client connects and the wire flows in
    // both directions, the relay's per-repo serializer must reject the
    // banana batch (chain-mismatch). Two things matter:
    //   (a) the relay's top is unchanged (banana didn't sneak in)
    //   (b) the bad client knows its chain is incompatible — either via
    //       `pushRejected` (the relay's explicit reject control message)
    //       or `conflictDetected` (the local verifier catching the
    //       diverged apple-bytes flowing back). Either flag is acceptable;
    //       both arrive asynchronously and racing them in tests is brittle.

    const serverRegistry = new RepoRegistry()
    const { repo: serverRepo, hex: keyHex } = await openWriter(serverRegistry, 60)
    serverRepo.set({ v: 'apple' })
    await waitFor(() => serverRepo.signedLength === serverRepo.byteLength, 1000)
    const tipAfterApple = serverRepo.byteLength

    const badRegistry = new RepoRegistry()
    const { repo: badRepo } = await openWriter(badRegistry, 60)
    badRepo.set({ v: 'banana' })
    await waitFor(() => badRepo.signedLength === badRepo.byteLength, 1000)

    const { wss, port } = await startServer(serverRegistry, keyHex)
    const session = await registrySync(badRegistry, 'localhost', port)

    await waitFor(
      () => badRepo.pushRejected != null || badRepo.conflictDetected,
      2000
    )

    // The bad client knows something is wrong with its chain.
    assert.ok(badRepo.pushRejected || badRepo.conflictDetected,
      'bad client must surface either pushRejected (relay said no) or conflictDetected (local verifier caught it)')

    // The relay's top is unchanged — banana never landed.
    assert.equal(serverRepo.byteLength, tipAfterApple,
      "relay's top unchanged by the rejected divergent push")
    assert.equal(serverRepo.get('v'), 'apple',
      'apple is still the canonical value at the relay')

    session.ws.close()
    await new Promise(r => wss.close(r))
  })

  test('relay accepts a clean push from an already-synced client', async ({ assert }) => {
    // The non-conflict case: a client syncs to the relay's top, then writes
    // locally and pushes. The push chains correctly off the relay's top, so
    // the serializer accepts and broadcasts.

    const serverRegistry = new RepoRegistry()
    const { repo: serverRepo, hex: keyHex } = await openWriter(serverRegistry, 61)
    serverRepo.set({ v: 'apple' })
    await waitFor(() => serverRepo.signedLength === serverRepo.byteLength, 1000)

    const { wss, port } = await startServer(serverRegistry, keyHex)
    const clientRegistry = new RepoRegistry()
    const { repo: clientRepo } = await openWriter(clientRegistry, 61)
    const session = await registrySync(clientRegistry, 'localhost', port)

    // Wait for sync to complete (client sees apple)
    await waitFor(() => clientRepo.get('v') === 'apple', 2000)
    // Now client writes banana — signed against apple, so it should chain cleanly
    clientRepo.set({ v: 'banana' })
    await waitFor(() => clientRepo.get('v') === 'banana')
    // And the relay should accept it
    await waitFor(() => serverRepo.get('v') === 'banana', 2000)
    assert.equal(serverRepo.get('v'), 'banana', 'relay accepted the chained push')
    assert.equal(clientRepo.pushRejected, null, 'no rejection on a clean push')

    session.ws.close()
    await new Promise(r => wss.close(r))
  })
})
