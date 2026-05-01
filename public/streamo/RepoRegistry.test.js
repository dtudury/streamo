import { describe } from './utils/testing.js'
import { Streamo } from './Streamo.js'
import { Repo } from './Repo.js'
import { RepoRegistry } from './RepoRegistry.js'
import { archiveSync } from './archiveSync.js'

function archiveRegistry (dir) {
  return new RepoRegistry(async key => {
    const repo = new Repo()
    await archiveSync(repo, dir, key)
    return repo
  })
}

describe(import.meta.url, ({ test }) => {
  test('plain registry creates in-memory repositories with no factory', async ({ assert }) => {
    const registry = new RepoRegistry()
    const s = await registry.open('anykey')
    assert.ok(s instanceof Repo)
    s.set({ x: 1 })
    assert.equal(s.get('x'), 1)
  })

  test('open creates a repository and returns the same instance on repeat calls', async ({ assert }) => {
    const registry = new RepoRegistry()
    const s1 = await registry.open('aabbcc')
    const s2 = await registry.open('aabbcc')
    assert.ok(s1 === s2, 'same instance returned')
    assert.equal(registry.size, 1)
  })

  test('open creates independent repositories for different keys', async ({ assert }) => {
    const registry = new RepoRegistry()
    const s1 = await registry.open('key1')
    const s2 = await registry.open('key2')
    assert.ok(s1 !== s2)
    assert.equal(registry.size, 2)
    s1.set({ from: 'key1' })
    s2.set({ from: 'key2' })
    assert.equal(s1.get('from'), 'key1')
    assert.equal(s2.get('from'), 'key2')
  })

  test('concurrent open() calls return the same instance', async ({ assert }) => {
    let created = 0
    const registry = new RepoRegistry(async () => {
      created++
      await new Promise(r => setTimeout(r, 10))
      return new Repo()
    })
    const [s1, s2, s3] = await Promise.all([
      registry.open('k'),
      registry.open('k'),
      registry.open('k')
    ])
    assert.equal(created, 1, 'factory called only once')
    assert.ok(s1 === s2 && s2 === s3, 'all calls return same instance')
  })

  test('get returns undefined for unopened or still-opening keys', async ({ assert }) => {
    const registry = new RepoRegistry()
    assert.equal(registry.get('nope'), undefined)
    await registry.open('exists')
    assert.ok(registry.get('exists') instanceof Streamo)
  })

  test('iterates over fully-opened repositories only', async ({ assert }) => {
    const registry = new RepoRegistry()
    await registry.open('a')
    await registry.open('b')
    const entries = [...registry]
    assert.equal(entries.length, 2)
    assert.deepEqual(entries.map(([k]) => k).sort(), ['a', 'b'])
  })

  test('archive factory persists and reloads repository data', async ({ assert }) => {
    const dir = '/tmp/repository-registry-persist-test-' + Date.now()
    const r1 = archiveRegistry(dir)
    const s1 = await r1.open('testkey')
    s1.set({ saved: true })
    await new Promise(r => setTimeout(r, 50))

    const r2 = archiveRegistry(dir)
    const s2 = await r2.open('testkey')
    assert.equal(s2.get('saved'), true, 'data survived registry reload')
  })
})
