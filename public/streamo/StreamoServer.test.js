import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe } from './utils/testing.js'
import { StreamoServer } from './StreamoServer.js'
import { parseOrigin } from './utils.js'

describe(import.meta.url, ({ test }) => {
  // ── URL-shape (explicit protocol) ──────────────────────────────────────

  test('ws:// URL with port', ({ assert }) => {
    assert.deepEqual(parseOrigin('ws://localhost:8080'),
      { host: 'localhost', port: 8080, protocol: 'ws' })
  })

  test('wss:// URL with port', ({ assert }) => {
    assert.deepEqual(parseOrigin('wss://streamo.dev:8443'),
      { host: 'streamo.dev', port: 8443, protocol: 'wss' })
  })

  test('wss:// URL without port → defaults to 443', ({ assert }) => {
    assert.deepEqual(parseOrigin('wss://streamo.dev'),
      { host: 'streamo.dev', port: 443, protocol: 'wss' })
  })

  test('ws:// URL without port → defaults to 80', ({ assert }) => {
    assert.deepEqual(parseOrigin('ws://example.test'),
      { host: 'example.test', port: 80, protocol: 'ws' })
  })

  // ── shorthand (no protocol) ────────────────────────────────────────────

  test('shorthand host:port (non-443) → ws', ({ assert }) => {
    assert.deepEqual(parseOrigin('localhost:8080'),
      { host: 'localhost', port: 8080, protocol: 'ws' })
  })

  test('shorthand host:443 → wss (TLS conventional port)', ({ assert }) => {
    assert.deepEqual(parseOrigin('streamo.dev:443'),
      { host: 'streamo.dev', port: 443, protocol: 'wss' })
  })

  test('shorthand bare host (no port) → wss + 443 (production default)', ({ assert }) => {
    assert.deepEqual(parseOrigin('streamo.dev'),
      { host: 'streamo.dev', port: 443, protocol: 'wss' })
  })

  // ── relay-only mode (StreamoServer.create with publicKeyHex) ───────────

  // A valid compressed secp256k1 pubkey (0x02 or 0x03 prefix + 32-byte x).
  // Doesn't need to match a real private key — the relay-only path never
  // signs anything, so any well-formed pubkey is fine for these tests.
  const HOMEKEY = '02' + 'ab'.repeat(32)

  test('relay-only: create with publicKeyHex skips signer derivation', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-relay-'))
    try {
      const server = await StreamoServer.create({ publicKeyHex: HOMEKEY, dataDir: dir, keyIterations: 1 })
      assert.equal(server.signer, null, 'no signer in relay-only mode')
      assert.equal(server.publicKeyHex, HOMEKEY, 'publicKeyHex propagates')
      assert.ok(server.streamo, 'streamo is opened')
      assert.equal(server.streamo.byteLength, 0, 'empty archive on fresh dir')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('relay-only: files() throws (signing required)', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-relay-'))
    try {
      const server = await StreamoServer.create({ publicKeyHex: HOMEKEY, dataDir: dir, keyIterations: 1 })
      await assert.rejects(() => server.files('/tmp'), 'files() rejects without a signer')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('relay-only: rejects mixing publicKeyHex with credentials', async ({ assert }) => {
    await assert.rejects(
      () => StreamoServer.create({ publicKeyHex: HOMEKEY, username: 'alice', password: 'x', keyIterations: 1 }),
      'rejects publicKeyHex + credentials together'
    )
  })

  test('relay-only: rejects malformed publicKeyHex', async ({ assert }) => {
    await assert.rejects(
      () => StreamoServer.create({ publicKeyHex: 'not-a-key', keyIterations: 1 }),
      'rejects non-66-hex pubkey'
    )
  })

  test('credentials mode: still works (no regression)', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-author-'))
    try {
      const server = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        dataDir: dir, keyIterations: 1
      })
      assert.ok(server.signer, 'signer present in credentials mode')
      assert.ok(/^[0-9a-f]{66}$/.test(server.publicKeyHex), 'derived publicKeyHex looks valid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('archive flat mode (default): preserved keys → <dataDir>/preserved/, non-preserved → <dataDir>/', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-flat-'))
    try {
      const probe = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        dataDir: false, keyIterations: 1
      })
      const key = probe.publicKeyHex

      const preservedServer = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        dataDir: dir, keyIterations: 1,
        preserved: [key]
      })
      preservedServer.streamo.set({ hello: 'preserved' })
      await preservedServer.close()

      assert.ok(existsSync(join(dir, 'preserved', `${key}.bin`)),
        'preserved key wrote to <dataDir>/preserved/<key>.bin')
      assert.ok(!existsSync(join(dir, `${key}.bin`)),
        'preserved key did NOT also write to <dataDir>/<key>.bin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('archive flat mode: non-preserved keys still go to <dataDir>/ (no regression)', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-flat-'))
    try {
      const server = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        dataDir: dir, keyIterations: 1,
        preserved: ['00'.repeat(33)]  // a key that's NOT this server's
      })
      server.streamo.set({ hello: 'not preserved' })
      await server.close()
      const key = server.publicKeyHex

      assert.ok(existsSync(join(dir, `${key}.bin`)),
        'non-preserved key wrote to <dataDir>/<key>.bin')
      assert.ok(!existsSync(join(dir, 'preserved', `${key}.bin`)),
        'non-preserved key did NOT route to preserved/')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('archive tiered mode: non-preserved → <dataDir>/cache/, preserved → <dataDir>/preserved/', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-tiered-'))
    try {
      const probe = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        dataDir: false, keyIterations: 1
      })
      const key = probe.publicKeyHex

      // Preserved primary in tiered mode.
      const preservedServer = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        dataDir: dir, keyIterations: 1,
        preserved: [key], archiveMode: 'tiered'
      })
      preservedServer.streamo.set({ hello: 'preserved tier' })
      await preservedServer.close()

      assert.ok(existsSync(join(dir, 'preserved', `${key}.bin`)),
        'preserved key → preserved/')
      assert.ok(!existsSync(join(dir, 'cache', `${key}.bin`)),
        'preserved key did NOT go to cache/')

      // Non-preserved primary in tiered mode.
      const dir2 = mkdtempSync(join(tmpdir(), 'streamo-tiered-'))
      try {
        const cacheServer = await StreamoServer.create({
          name: 'test', username: 'alice', password: 'hunter2',
          dataDir: dir2, keyIterations: 1,
          archiveMode: 'tiered'
        })
        cacheServer.streamo.set({ hello: 'cache tier' })
        await cacheServer.close()
        const cacheKey = cacheServer.publicKeyHex

        assert.ok(existsSync(join(dir2, 'cache', `${cacheKey}.bin`)),
          'non-preserved key → cache/')
        assert.ok(!existsSync(join(dir2, `${cacheKey}.bin`)),
          'non-preserved key did NOT go to dataDir root')
      } finally {
        rmSync(dir2, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('archive preserved-only mode: non-preserved keys stay in-memory (no archive)', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-preserved-only-'))
    try {
      const server = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        dataDir: dir, keyIterations: 1,
        archiveMode: 'preserved-only'
        // no preserved list — every key is non-preserved
      })
      server.streamo.set({ hello: 'in memory only' })
      await server.close()
      const key = server.publicKeyHex

      assert.ok(!existsSync(join(dir, `${key}.bin`)),
        'non-preserved key in preserved-only mode wrote NOTHING to disk')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('archive preserved-only mode: preserved keys archive at <dataDir>/<key>.bin', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-preserved-only-'))
    try {
      const probe = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        dataDir: false, keyIterations: 1
      })
      const key = probe.publicKeyHex

      const server = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        dataDir: dir, keyIterations: 1,
        preserved: [key], archiveMode: 'preserved-only'
      })
      server.streamo.set({ hello: 'dedicated backup' })
      await server.close()

      assert.ok(existsSync(join(dir, `${key}.bin`)),
        'preserved key in preserved-only mode → <dataDir>/<key>.bin (root)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
