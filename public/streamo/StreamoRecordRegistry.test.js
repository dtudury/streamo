import { describe } from './utils/testing.js'
import { Streamo } from './Streamo.js'
import { StreamoRecord } from './StreamoRecord.js'
import { StreamoRecordRegistry } from './StreamoRecordRegistry.js'
import { Recaller } from './utils/Recaller.js'
import { archiveSync } from './archiveSync.js'

const newRegistry = (factory) => new StreamoRecordRegistry({ recaller: new Recaller('test'), factory })

function archiveRegistry (dir) {
  return newRegistry(async key => {
    const repo = new StreamoRecord()
    await archiveSync(repo, dir, key)
    return repo
  })
}

describe(import.meta.url, ({ test }) => {
  test('rejects construction without a recaller', ({ assert }) => {
    assert.throws(() => new StreamoRecordRegistry(), /recaller.*required/)
    assert.throws(() => new StreamoRecordRegistry({}), /recaller.*required/)
    assert.throws(() => new StreamoRecordRegistry({ name: 'oops' }), /recaller.*required/)
  })

  test('plain registry creates in-memory repositories with no factory', async ({ assert }) => {
    const registry = newRegistry()
    const s = await registry._materialize('anykey')
    assert.ok(s instanceof StreamoRecord)
    s.set({ x: 1 })
    assert.equal(s.get('x'), 1)
  })

  test('_materialize creates a repository and returns the same instance on repeat calls', async ({ assert }) => {
    const registry = newRegistry()
    const s1 = await registry._materialize('aabbcc')
    const s2 = await registry._materialize('aabbcc')
    assert.ok(s1 === s2, 'same instance returned')
    assert.equal(registry.size, 1)
  })

  test('_materialize creates independent repositories for different keys', async ({ assert }) => {
    const registry = newRegistry()
    const s1 = await registry._materialize('key1')
    const s2 = await registry._materialize('key2')
    assert.ok(s1 !== s2)
    assert.equal(registry.size, 2)
    s1.set({ from: 'key1' })
    s2.set({ from: 'key2' })
    assert.equal(s1.get('from'), 'key1')
    assert.equal(s2.get('from'), 'key2')
  })

  test('concurrent _materialize calls return the same instance', async ({ assert }) => {
    let created = 0
    const registry = newRegistry(async () => {
      created++
      await new Promise(r => setTimeout(r, 10))
      return new StreamoRecord()
    })
    const [s1, s2, s3] = await Promise.all([
      registry._materialize('k'),
      registry._materialize('k'),
      registry._materialize('k')
    ])
    assert.equal(created, 1, 'factory called only once')
    assert.ok(s1 === s2 && s2 === s3, 'all calls return same instance')
  })

  test('get returns undefined for unopened or still-opening keys', async ({ assert }) => {
    const registry = newRegistry()
    assert.equal(registry.get('nope'), undefined)
    await registry._materialize('exists')
    assert.ok(registry.get('exists') instanceof Streamo)
  })

  test('iterates over fully-opened repositories only', async ({ assert }) => {
    const registry = newRegistry()
    await registry._materialize('a')
    await registry._materialize('b')
    const entries = [...registry]
    assert.equal(entries.length, 2)
    assert.deepEqual(entries.map(([k]) => k).sort(), ['a', 'b'])
  })

  test('archive factory persists and reloads repository data', async ({ assert }) => {
    const dir = '/tmp/repository-registry-persist-test-' + Date.now()
    const r1 = archiveRegistry(dir)
    const s1 = await r1._materialize('testkey')
    s1.set({ saved: true })
    await new Promise(r => setTimeout(r, 50))

    const r2 = archiveRegistry(dir)
    const s2 = await r2._materialize('testkey')
    assert.equal(s2.get('saved'), true, 'data survived registry reload')
  })
})
