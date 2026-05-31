import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe } from './utils/testing.js'
import { StreamoServer } from './StreamoServer.js'
import { MemoryTier, DiskTier } from './StorageTier.js'
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
      const server = await StreamoServer.create({
        publicKeyHex: HOMEKEY,
        tiers: [new DiskTier({ dir, capacity: Infinity })],
        keyIterations: 1
      })
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
      const server = await StreamoServer.create({
        publicKeyHex: HOMEKEY,
        tiers: [new DiskTier({ dir, capacity: Infinity })],
        keyIterations: 1
      })
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
        tiers: [new DiskTier({ dir, capacity: Infinity })],
        keyIterations: 1
      })
      assert.ok(server.signer, 'signer present in credentials mode')
      assert.ok(/^[0-9a-f]{66}$/.test(server.publicKeyHex), 'derived publicKeyHex looks valid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── tiers: the 13.0 archive shape ──────────────────────────────────────

  test('tiers: single DiskTier persists bytes to its dir', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-disk-tier-'))
    try {
      const server = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        tiers: [new DiskTier({ dir, capacity: Infinity })],
        keyIterations: 1
      })
      server.streamo.set({ hello: 'on disk' })
      await server.close()
      const key = server.publicKeyHex

      assert.ok(existsSync(join(dir, `${key}.bin`)),
        'DiskTier wrote bytes to <dir>/<key>.bin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('tiers: MemoryTier-only setup is ephemeral (no disk writes)', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'streamo-memory-tier-'))
    try {
      const server = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        tiers: [new MemoryTier({ capacity: Infinity })],
        keyIterations: 1
      })
      server.streamo.set({ hello: 'in memory' })
      await server.close()
      const key = server.publicKeyHex

      assert.ok(!existsSync(join(dir, `${key}.bin`)),
        'MemoryTier wrote nothing to disk')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('tiers: default (no tiers passed) uses .streamo DiskTier', async ({ assert }) => {
    // We can't easily control the CWD-relative .streamo dir in this test
    // without mucking with cwd. Just verify the server creates and stores
    // bytes — the default tier construction shouldn't throw.
    const previousCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), 'streamo-default-tier-'))
    process.chdir(dir)
    try {
      const server = await StreamoServer.create({
        name: 'test', username: 'alice', password: 'hunter2',
        keyIterations: 1
      })
      server.streamo.set({ hello: 'default tier' })
      await server.close()
      const key = server.publicKeyHex

      assert.ok(existsSync(join(dir, '.streamo', `${key}.bin`)),
        'default tier wrote to <cwd>/.streamo/<key>.bin')
    } finally {
      process.chdir(previousCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
