import { describe } from './utils/testing.js'
import { request } from 'node:http'
import { StreamoRecordRegistry } from './StreamoRecordRegistry.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { Recaller } from './utils/Recaller.js'
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
