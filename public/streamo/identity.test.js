import { describe } from './utils/testing.js'
import { identity } from './identity.js'
import { Signer } from './Signer.js'
import { bytesToHex } from './utils.js'
import { mkdtemp, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe(import.meta.url, ({ test }) => {
  async function tmpDir () {
    return mkdtemp(join(tmpdir(), 'streamo-identity-test-'))
  }

  test('identity.new generates a fresh keypair + writes env file + returns derived info', async ({ assert }) => {
    const dir = await tmpDir()
    const result = await identity.new('streamo-fresh', { dir, iterations: 1 })
    assert.equal(result.name, 'streamo-fresh')
    assert.equal(typeof result.pubkeyHex, 'string')
    assert.equal(result.pubkeyHex.length, 66, '33-byte compressed pubkey = 66 hex chars')
    assert.equal(typeof result.password, 'string')
    assert.equal(result.password.length, 64, '32 random bytes = 64 hex chars')
    assert.equal(result.envPath, join(dir, 'streamo-fresh.env'))
    // env file landed
    const env = await readFile(result.envPath, 'utf8')
    assert.ok(env.includes('STREAMO_NAME=streamo-fresh'))
    assert.ok(env.includes('STREAMO_PASSWORD=' + result.password))
    assert.ok(env.includes('Pubkey: ' + result.pubkeyHex))
  })

  test('identity.new derivation is reproducible — same name+password → same pubkey', async ({ assert }) => {
    const dir = await tmpDir()
    const r = await identity.new('streamo-reprod', { dir, iterations: 1 })
    // Re-derive manually with the same creds; pubkey should match.
    const signer = new Signer('streamo-reprod', r.password, 1)
    const { publicKey } = await signer.keysFor('streamo-reprod')
    assert.equal(bytesToHex(publicKey), r.pubkeyHex)
  })

  test('identity.new throws when env file exists (no overwrite by default)', async ({ assert }) => {
    const dir = await tmpDir()
    await identity.new('streamo-collide', { dir, iterations: 1 })
    await assert.rejects(
      () => identity.new('streamo-collide', { dir, iterations: 1 }),
      /already exists.*force.*overwrite/
    )
  })

  test('identity.new with force:true overwrites + generates a NEW identity', async ({ assert }) => {
    const dir = await tmpDir()
    const a = await identity.new('streamo-force', { dir, iterations: 1 })
    const b = await identity.new('streamo-force', { dir, iterations: 1, force: true })
    assert.notEqual(a.password, b.password, 'fresh password')
    assert.notEqual(a.pubkeyHex, b.pubkeyHex, 'fresh pubkey')
  })

  test('identity.new with dryRun:true derives without writing the env file', async ({ assert }) => {
    const dir = await tmpDir()
    const r = await identity.new('streamo-dry', { dir, iterations: 1, dryRun: true })
    assert.equal(typeof r.pubkeyHex, 'string')
    let exists = false
    try { await access(r.envPath); exists = true } catch {}
    assert.equal(exists, false, 'env file NOT written on dry run')
  })

  test('identity.new throws on missing/invalid name', async ({ assert }) => {
    await assert.rejects(() => identity.new(), /name is required/)
    await assert.rejects(() => identity.new(''), /name is required/)
    await assert.rejects(() => identity.new(null), /name is required/)
  })
})
