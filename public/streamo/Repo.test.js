import { describe } from './utils/testing.js'
import { Repo } from './Repo.js'

describe(import.meta.url, ({ test }) => {
  test('commit stores message, date, and a reference to the data', ({ assert }) => {
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ a: 1 })
    const commitAddr = repo.commit(working, 'first commit')
    const commit = repo.decode(commitAddr)
    assert.equal(commit.message, 'first commit')
    assert.ok(commit.date instanceof Date)
    assert.equal(typeof commit.dataAddress, 'number')
    assert.deepEqual(repo.decode(commit.dataAddress), { a: 1 })
  })

  test('checkout starts with last committed value', ({ assert }) => {
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ a: 1 })
    repo.commit(working, 'first')
    const working2 = repo.checkout()
    assert.deepEqual(working2.get(), { a: 1 })
  })

  test('checkout of empty repo returns empty stream', ({ assert }) => {
    const repo = new Repo()
    const working = repo.checkout()
    assert.equal(working.byteLength, 0)
  })

  test('working stream modifications do not affect the repository', ({ assert }) => {
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ v: 1 })
    repo.commit(working, 'first')
    const working2 = repo.checkout()
    working2.set({ v: 99 })
    // repo still has v:1 as last committed value
    assert.deepEqual(repo.decode(repo.lastCommit.dataAddress), { v: 1 })
  })

  test('multiple commits produce a linked history via parent', ({ assert }) => {
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ v: 1 })
    repo.commit(working, 'first')
    working.set('v', 2)
    repo.commit(working, 'second')
    const c2 = repo.lastCommit
    assert.equal(c2.message, 'second')
    assert.deepEqual(repo.decode(c2.dataAddress), { v: 2 })
    const c1 = repo.decode(c2.parent)
    assert.equal(c1.message, 'first')
    assert.deepEqual(repo.decode(c1.dataAddress), { v: 1 })
  })

  test('first commit has no parent', ({ assert }) => {
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ x: 1 })
    repo.commit(working, 'root')
    assert.equal(repo.lastCommit.parent, undefined)
  })

  test('unchanged data reuses the same address across commits', ({ assert }) => {
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ x: 42 })
    repo.commit(working, 'first')
    repo.commit(working, 'second')
    const c2 = repo.lastCommit
    const c1 = repo.decode(c2.parent)
    assert.equal(c1.dataAddress, c2.dataAddress, 'same data reuses the same address')
  })

  test('throws when working stream is empty', ({ assert }) => {
    const repo = new Repo()
    const working = repo.checkout()
    assert.throws(() => repo.commit(working, 'nothing here'))
  })
})
