import { describe } from './utils/testing.js'
import { identity } from './identity.js'
import { Signer } from './Signer.js'
import { bytesToHex } from './utils.js'

describe(import.meta.url, ({ test }) => {
  test('identity.new generates a fresh keypair + returns env content (pure — no fs)', async ({ assert }) => {
    const r = await identity.new('streamo-fresh', { iterations: 1 })
    assert.equal(r.name, 'streamo-fresh')
    assert.equal(typeof r.pubkeyHex, 'string')
    assert.equal(r.pubkeyHex.length, 66, '33-byte compressed pubkey = 66 hex chars')
    assert.equal(typeof r.password, 'string')
    assert.equal(r.password.length, 64, '32 random bytes = 64 hex chars')
    assert.equal(typeof r.envContent, 'string')
    assert.ok(r.envContent.includes('STREAMO_NAME=streamo-fresh'))
    assert.ok(r.envContent.includes('STREAMO_USERNAME=streamo-fresh'))
    assert.ok(r.envContent.includes('STREAMO_PASSWORD=' + r.password))
    assert.ok(r.envContent.includes('STREAMO_KEY_ITERATIONS=1'))
    assert.ok(r.envContent.includes('Pubkey: ' + r.pubkeyHex))
  })

  test('identity.new derivation is reproducible — same name+password+iters → same pubkey', async ({ assert }) => {
    const r = await identity.new('streamo-reprod', { iterations: 1 })
    const signer = new Signer('streamo-reprod', r.password, 1)
    const { publicKey } = await signer.keysFor('streamo-reprod')
    assert.equal(bytesToHex(publicKey), r.pubkeyHex)
  })

  test('identity.new is pure — two calls with same name produce DIFFERENT passwords/keys', async ({ assert }) => {
    // (No "already exists" check; the caller decides what to do with the
    // result — overwrite, refuse, append-as-new, etc. The verb is pure
    // generation.)
    const a = await identity.new('streamo-twice', { iterations: 1 })
    const b = await identity.new('streamo-twice', { iterations: 1 })
    assert.notEqual(a.password, b.password)
    assert.notEqual(a.pubkeyHex, b.pubkeyHex)
  })

  test('identity.new defaults iterations to 100000', async ({ assert }) => {
    // Don't actually run 100k iters in the test (slow); just verify the
    // envContent advertises the default. Reproducibility checks above use
    // iterations: 1 to stay fast.
    const r = await identity.new('streamo-iter-default')
    assert.ok(r.envContent.includes('STREAMO_KEY_ITERATIONS=100000'))
  })

  test('identity.new throws on missing/invalid name', async ({ assert }) => {
    await assert.rejects(() => identity.new(), /name is required/)
    await assert.rejects(() => identity.new(''), /name is required/)
    await assert.rejects(() => identity.new(null), /name is required/)
  })
})
