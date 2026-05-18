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

  test('Repo.set toggling between two values via Repo.set persists each one', ({ assert }) => {
    // Regression: when Repo.set encodes a value whose outermost subcode
    // already exists in working's content map (toggling back to a state the
    // repo has previously held), copyFrom must use working.valueAddress
    // (which Streamo.set updates explicitly) — NOT working.byteLength-1,
    // which would be unchanged in the dedup case and cite the wrong data.
    // This was the bug that broke todomvc toggle.
    const repo = new Repo()
    const valueA = { items: [{ id: 1, done: true }] }
    const valueB = { items: [{ id: 1, done: false }] }

    repo.set(valueA)
    assert.deepEqual(repo.get(), valueA, 'after set(A): get returns A')

    repo.set(valueB)
    assert.deepEqual(repo.get(), valueB, 'after set(B): get returns B')

    // Toggle BACK to A — encoded outermost already exists in working's content
    // map. With the bug, dataAddress would point at B's tail; with the fix,
    // dataAddress is A's existing address and get() returns A.
    repo.set(valueA)
    assert.deepEqual(repo.get(), valueA, 'after toggle back to A: get returns A')

    // And once more to B.
    repo.set(valueB)
    assert.deepEqual(repo.get(), valueB, 'after toggle back to B: get returns B')
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

  test('commit accepts a custom date via options (back-stamping for history replay)', ({ assert }) => {
    const oldDate = new Date('2020-01-15T12:00:00Z')
    const repo = new Repo()
    const working = repo.checkout()
    working.set({ x: 1 })
    repo.commit(working, 'recovered', { date: oldDate })
    assert.equal(+repo.lastCommit.date, +oldDate)
  })

  // ── merge: replace-policy (Mode A) ────────────────────────────────────

  test('merge into empty target: pure-copy fork — no parent, has remoteParent', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ files: { 'index.html': '<h1>upstream</h1>' } })
    source.commit(sw, 'upstream content')

    const target = new Repo()
    await target.merge(source, {
      remoteParent: { host: 'upstream.test', repo: '03aaaaaaaabbbbbbbbcccc' }
    })
    const c = target.lastCommit
    assert.equal(c.parent, undefined)
    assert.equal(c.remoteParent.host, 'upstream.test')
    assert.equal(c.remoteParent.repo, '03aaaaaaaabbbbbbbbcccc')
    assert.equal(c.remoteParent.dataAddress, source.lastCommit.dataAddress)
    assert.equal(c.message, 'fork from upstream.test')
    assert.deepEqual(target.get(), { files: { 'index.html': '<h1>upstream</h1>' } })
  })

  test('merge into non-empty target: mixed — both parent and remoteParent set', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ files: { 'a.html': '<a>' } })
    source.commit(sw, 'src')

    const target = new Repo()
    const tw = target.checkout()
    tw.set({ existing: 'value' })
    target.commit(tw, 'initial')

    await target.merge(source, {
      from: ['files'],
      remoteParent: { host: 'h', repo: 'r' }
    })
    const c = target.lastCommit
    assert.notEqual(c.parent, undefined)
    assert.deepEqual(c.remoteParent, { host: 'h', repo: 'r', dataAddress: source.lastCommit.dataAddress })
    assert.equal(c.message, 'merge from h')
    assert.equal(target.get('existing'), 'value')   // sibling preserved
    assert.deepEqual(target.get('files'), { 'a.html': '<a>' })
  })

  test('merge with from path slices source', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ files: { 'index.html': '<x>' }, members: ['alice'] })
    source.commit(sw, 'src')

    const target = new Repo()
    await target.merge(source, {
      from: ['files'],
      remoteParent: { host: 'h', repo: 'r' }
    })
    assert.deepEqual(target.get(), { files: { 'index.html': '<x>' } })  // only files
    assert.equal(target.get('members'), undefined)                       // not pulled in
  })

  test('merge with from and into differing paths', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ original_files: { 'a.html': '<a>' } })
    source.commit(sw, 'src')

    const target = new Repo()
    await target.merge(source, {
      from: ['original_files'],
      into: ['my_files'],
      remoteParent: { host: 'h', repo: 'r' }
    })
    assert.deepEqual(target.get('my_files'), { 'a.html': '<a>' })
  })

  test('merge with from=[] takes the whole value', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ a: 1, b: 2 })
    source.commit(sw, 'src')

    const target = new Repo()
    await target.merge(source, { remoteParent: { host: 'h', repo: 'r' } })
    assert.deepEqual(target.get(), { a: 1, b: 2 })
  })

  test('merge accepts string shorthand for from/into', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ files: { 'x': 'y' } })
    source.commit(sw, 'src')

    const target = new Repo()
    await target.merge(source, {
      from: 'files',
      into: 'files',
      remoteParent: { host: 'h', repo: 'r' }
    })
    assert.deepEqual(target.get('files'), { 'x': 'y' })
  })

  test('merge with explicit remoteParent.dataAddress cites a historical address', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ v: 1 })
    source.commit(sw, 'first')
    const firstAddr = source.lastCommit.dataAddress

    sw.set('v', 2)
    source.commit(sw, 'second')

    const target = new Repo()
    await target.merge(source, {
      remoteParent: { host: 'h', repo: 'r', dataAddress: firstAddr }
    })
    // We cited the FIRST commit's address, so the value we got is v: 1
    assert.deepEqual(target.get(), { v: 1 })
    assert.equal(target.lastCommit.remoteParent.dataAddress, firstAddr)
  })

  test('merge requires options.remoteParent', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ x: 1 })
    source.commit(sw, 's')

    const target = new Repo()
    await assert.rejects(() => target.merge(source, {}))
  })

  test('merge requires source to have commits (when dataAddress is not given)', async ({ assert }) => {
    const source = new Repo()
    const target = new Repo()
    await assert.rejects(() => target.merge(source, {
      remoteParent: { host: 'h', repo: 'r' }
    }))
  })

  test('merge throws clearly for not-yet-implemented policies', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ x: 1 })
    source.commit(sw, 's')

    const target = new Repo()
    await assert.rejects(() => target.merge(source, {
      remoteParent: { host: 'h', repo: 'r' },
      policy: 'theirs'
    }))
    await assert.rejects(() => target.merge(source, {
      remoteParent: { host: 'h', repo: 'r' },
      policy: 'ours'
    }))
    await assert.rejects(() => target.merge(source, {
      remoteParent: { host: 'h', repo: 'r' },
      policy: 'throw'
    }))
  })

  test('merge throws when source path does not exist', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ a: 1 })
    source.commit(sw, 's')

    const target = new Repo()
    await assert.rejects(() => target.merge(source, {
      from: ['nonexistent'],
      remoteParent: { host: 'h', repo: 'r' }
    }))
  })

  test('merge accepts a custom message', async ({ assert }) => {
    const source = new Repo()
    const sw = source.checkout()
    sw.set({ x: 1 })
    source.commit(sw, 's')

    const target = new Repo()
    await target.merge(source, {
      remoteParent: { host: 'h', repo: 'r' },
      message: 'because I said so'
    })
    assert.equal(target.lastCommit.message, 'because I said so')
  })
})
