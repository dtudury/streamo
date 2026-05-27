import { describe } from './utils/testing.js'
import { request } from 'node:http'
import { StreamoRecord } from './StreamoRecord.js'
import { StreamoRecordRegistry } from './StreamoRecordRegistry.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { Recaller } from './utils/Recaller.js'
import { Signer } from './Signer.js'
import { bytesToHex } from './utils.js'
import { registrySync } from './registrySync.js'
import { webSync } from './webSync.js'

/**
 * Seed a registry with a writable record holding `value` at `keyHex`.
 * Uses _writableKeys so the factory creates a WritableStreamoRecord.
 */
async function seedRecord (registry, keyHex, value) {
  registry._writableKeys ??= new Set()
  registry._writableKeys.add(keyHex)
  const repo = /** @type {WritableStreamoRecord} */ (await registry._materialize(keyHex))
  const working = repo.checkout()
  working.set(value)
  repo.commit(working, 'seed')
  return repo
}

/**
 * Make an HTTP request to 127.0.0.1:port with an explicit Host header.
 * Returns { status, body }. Uses node:http directly because the built-in
 * `fetch` silently overrides Host from the URL (correct for normal use,
 * wrong for testing host-aware routing).
 */
function fetchWithHost (port, path, host) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Host: host }
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body = null
        try { body = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, body, raw })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe(import.meta.url, ({ test }) => {
  test('host-aware routing: GET / returns the right record per host', async ({ assert }) => {
    const recaller = new Recaller('host-routing-test')
    const registry = new StreamoRecordRegistry({
      recaller,
      name: 'host-routing-test',
      factory: key => {
        if (registry._writableKeys?.has(key)) return new WritableStreamoRecord({ recaller, name: key })
        throw new Error(`unexpected non-writable key in test: ${key}`)
      }
    })

    const primaryKey = '02' + '11'.repeat(32)
    const hostAKey   = '02' + '22'.repeat(32)
    const hostBKey   = '02' + '33'.repeat(32)

    await seedRecord(registry, primaryKey, { who: 'primary' })
    await seedRecord(registry, hostAKey,   { who: 'host-a' })
    await seedRecord(registry, hostBKey,   { who: 'host-b' })

    const server = await webSync(registry, primaryKey, 0, 'host-test', 100000, {
      hostMap: {
        'foo.example.com': hostAKey,
        'bar.example.com': hostBKey
      }
    })
    const port = server.address().port

    try {
      // Mapped hosts get their respective Records.
      const a = await fetchWithHost(port, '/', 'foo.example.com')
      assert.equal(a.status, 200)
      assert.equal(a.body?.who, 'host-a', 'foo.example.com → host-a Record')

      const b = await fetchWithHost(port, '/', 'bar.example.com')
      assert.equal(b.status, 200)
      assert.equal(b.body?.who, 'host-b', 'bar.example.com → host-b Record')

      // Unmapped host falls back to primary.
      const p = await fetchWithHost(port, '/', 'unmapped.example.com')
      assert.equal(p.status, 200)
      assert.equal(p.body?.who, 'primary', 'unmapped host → primary fallback')

      // Host with port suffix matches the hostname-only key.
      const aWithPort = await fetchWithHost(port, '/', `foo.example.com:${port}`)
      assert.equal(aWithPort.body?.who, 'host-a', 'host:port matches hostname-only key')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  test('host-aware /api/info returns the host-resolved primaryKeyHex', async ({ assert }) => {
    const recaller = new Recaller('host-info-test')
    const registry = new StreamoRecordRegistry({
      recaller,
      name: 'host-info-test',
      factory: key => {
        if (registry._writableKeys?.has(key)) return new WritableStreamoRecord({ recaller, name: key })
        throw new Error(`unexpected non-writable key in test: ${key}`)
      }
    })

    const primaryKey = '02' + 'aa'.repeat(32)
    const hostAKey   = '02' + 'bb'.repeat(32)

    await seedRecord(registry, primaryKey, { who: 'primary' })
    await seedRecord(registry, hostAKey,   { who: 'host-a' })

    const server = await webSync(registry, primaryKey, 0, 'info-test', 100000, {
      hostMap: { 'foo.example.com': hostAKey }
    })
    const port = server.address().port

    try {
      const a = await fetchWithHost(port, '/api/info', 'foo.example.com')
      assert.equal(a.body?.primaryKeyHex, hostAKey, '/api/info resolves to host-mapped key')

      const p = await fetchWithHost(port, '/api/info', 'unmapped.example.com')
      assert.equal(p.body?.primaryKeyHex, primaryKey, 'unmapped /api/info falls back to primary')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  test('federation: relay B subscribes to relay A and serves A\'s record', async ({ assert }) => {
    // Set up relay A: holds a Writable record with distinctive content.
    // Federation REQUIRES signed records — `relayInboundStream` stages
    // chunks pending a covering SIG; without a SIG, bytes arrive but
    // never land in the receiver's Record. So we use a real Signer
    // here (low iterations for test speed) and derive sharedKey from
    // it. This makes the test honest about substrate guarantees: only
    // signed records travel.
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('federation-test')
    const sharedKey = bytesToHex(publicKey)

    const recallerA = new Recaller('fed-A')
    const registryA = new StreamoRecordRegistry({
      recaller: recallerA,
      name: 'fed-A',
      factory: key => {
        if (registryA._writableKeys?.has(key)) return new WritableStreamoRecord({ recaller: recallerA, name: key })
        return new StreamoRecord({ recaller: recallerA, name: key })
      }
    })
    registryA._writableKeys = new Set([sharedKey])
    const repoA = /** @type {WritableStreamoRecord} */ (await registryA._materialize(sharedKey))
    repoA.attachSigner(signer, 'federation-test')
    const working = repoA.checkout()
    working.set({ from: 'relay-A', payload: 'federated' })
    repoA.commit(working, 'seed')
    // Wait for the schedule-sign to land a SIG chunk; without this,
    // A's record has bytes but no signature, and the wire-out path
    // sends bytes that B's relayInboundStream stages indefinitely.
    const signDeadline = Date.now() + 2000
    while (repoA.signedLength < repoA.byteLength && Date.now() < signDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(repoA.signedLength, repoA.byteLength, 'A: sign completed before federation step')

    const serverA = await webSync(registryA, sharedKey, 0, 'fed-A', 100000, {})
    const portA = serverA.address().port

    // Set up relay B: a separate registry with NO writable keys; it'll
    // receive records over the wire as slim StreamoRecords. Its factory
    // creates slim records for everything (the realistic federation
    // shape — B doesn't author anyone else's records).
    const recallerB = new Recaller('fed-B')
    const registryB = new StreamoRecordRegistry({
      recaller: recallerB,
      name: 'fed-B',
      factory: key => {
        // B's own primary is writable; everything else (subscribed records
        // from peers) is slim — the realistic federation shape.
        if (registryB._writableKeys?.has(key)) return new WritableStreamoRecord({ recaller: recallerB, name: key })
        return new StreamoRecord({ recaller: recallerB, name: key })
      }
    })
    // B's own primary — a distinct, empty record so webSync has something
    // to anchor on. In a real deployment this'd be B's home Record.
    const primaryB = '02' + 'cd'.repeat(32)
    await seedRecord(registryB, primaryB, { from: 'relay-B' })

    const serverB = await webSync(registryB, primaryB, 0, 'fed-B', 100000, {})
    const portB = serverB.address().port

    // The federation step: B opens a registrySync session to A. The
    // hello-handshake auto-subscribes B to A's home (sharedKey).
    const peerSession = await registrySync(registryB, '127.0.0.1', portA, {
      protocol: 'ws',
      followMounts: true
    })

    try {
      // Poll for B's local Record at sharedKey to have bytes,
      // bounded so the test fails fast if federation is broken.
      const sharedRepoOnB = await registryB._materialize(sharedKey)
      const deadline = Date.now() + 3000
      while (sharedRepoOnB.byteLength === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.ok(sharedRepoOnB.byteLength > 0, `federation: B received bytes from A within 3s (byteLength=${sharedRepoOnB.byteLength})`)

      // B should now serve A's record via /streams/<sharedKey>.
      const r = await fetchWithHost(portB, `/streams/${sharedKey}`, 'localhost')
      assert.equal(r.status, 200, 'federation: B serves A\'s record over HTTP')
      assert.equal(r.body?.from, 'relay-A', `federation: value matches what A authored (got: ${JSON.stringify(r.body)})`)
      assert.equal(r.body?.payload, 'federated', 'federation: full value present')
    } finally {
      // Cleanup order matters: close the peer session FIRST (so the
      // WS connection from B to A's WebSocketServer tears down), then
      // force any remaining WS connections closed (registrySync's
      // attachStreamSync may hold sockets that http.Server.close()
      // would otherwise wait forever for), then close the http
      // servers. Without the force-close, the test hangs because
      // server.close() awaits all live connections.
      peerSession.close?.()
      await new Promise(resolve => setTimeout(resolve, 50))
      serverA.closeAllConnections?.()
      serverB.closeAllConnections?.()
      await new Promise(resolve => serverA.close(resolve))
      await new Promise(resolve => serverB.close(resolve))
    }
  })

  test('no hostMap: existing single-primary behavior is preserved', async ({ assert }) => {
    const recaller = new Recaller('no-host-map-test')
    const registry = new StreamoRecordRegistry({
      recaller,
      name: 'no-host-map-test',
      factory: key => {
        if (registry._writableKeys?.has(key)) return new WritableStreamoRecord({ recaller, name: key })
        throw new Error(`unexpected non-writable key in test: ${key}`)
      }
    })

    const primaryKey = '02' + 'cc'.repeat(32)
    await seedRecord(registry, primaryKey, { who: 'primary-only' })

    // No hostMap option — should behave as before this change.
    const server = await webSync(registry, primaryKey, 0, 'no-map-test', 100000, {})
    const port = server.address().port

    try {
      const r = await fetchWithHost(port, '/', 'anything.example.com')
      assert.equal(r.status, 200)
      assert.equal(r.body?.who, 'primary-only', 'no hostMap → always primary')

      const info = await fetchWithHost(port, '/api/info', 'anything.example.com')
      assert.equal(info.body?.primaryKeyHex, primaryKey, '/api/info returns primary')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
