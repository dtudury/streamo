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

  // ── remoteParent: citing another author's value ────────────────────────

  test('commit without options has no remoteParent (backward compat)', ({ assert }) => {
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ a: 1 })
    repo.commit(working, 'unmarked')
    assert.equal(repo.lastCommit.remoteParent, undefined)
  })

  test('pure-copy commit: empty repo + remoteParent → no parent, has remoteParent', ({ assert }) => {
    // The fork-start shape: my chain begins with someone else's value.
    const remote = { host: 'streamo.dev', repo: 'aabbccdd', dataAddress: 42 }
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ forked: 'value' })
    repo.commit(working, 'fork', { remoteParent: remote })
    const c = repo.lastCommit
    assert.equal(c.parent, undefined)
    assert.deepEqual(c.remoteParent, remote)
    assert.deepEqual(repo.decode(c.dataAddress), { forked: 'value' })
  })

  test('mixed commit: existing repo + remoteParent → both parent and remoteParent set', ({ assert }) => {
    // The pull-from-upstream shape: chain continues, footnoting a remote citation.
    const remote = { host: 'streamo.dev', repo: 'aabbccdd', dataAddress: 87 }
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ v: 1 })
    repo.commit(working, 'first')
    working.set('v', 2)
    repo.commit(working, 'pulled', { remoteParent: remote })
    const c = repo.lastCommit
    assert.equal(c.message, 'pulled')
    assert.notEqual(c.parent, undefined)
    assert.deepEqual(c.remoteParent, remote)
  })

  test('remoteParent survives history() iteration', ({ assert }) => {
    const remote = { host: 'streamo.dev', repo: 'deadbeef', dataAddress: 13 }
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ v: 1 })
    repo.commit(working, 'plain')
    working.set('v', 2)
    repo.commit(working, 'with-citation', { remoteParent: remote })
    const all = [...repo.history()]
    assert.equal(all.length, 2)
    assert.deepEqual(all[0].remoteParent, remote)
    assert.equal(all[1].remoteParent, undefined)
  })

  test('commit without remoteParent omits the key entirely (not just undefined)', ({ assert }) => {
    // OBJECT encodes only present keys, so a plain commit's decoded record
    // should not even have a `remoteParent` property — old chunks stay
    // bit-identical and the field doesn't pollute every commit.
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ x: 1 })
    repo.commit(working, 'plain')
    const record = repo.lastCommit
    assert.ok(!('remoteParent' in record))
  })
})
