import { describe } from './utils/testing.js'
import { liveObject, liveValue, isLiveSource } from './LiveSource.js'
import { Recaller } from './utils/Recaller.js'

describe(import.meta.url, ({ test }) => {
  test('liveObject reads at top-level path', ({ assert }) => {
    const s = liveObject({ a: 1, b: 'two' })
    assert.equal(s.get('a'), 1)
    assert.equal(s.get('b'), 'two')
  })

  test('liveObject writes at top-level path', ({ assert }) => {
    const s = liveObject({})
    s.set('a', 42)
    assert.equal(s.target.a, 42)
    assert.equal(s.get('a'), 42)
  })

  test('liveObject walks nested paths on read', ({ assert }) => {
    const s = liveObject({ a: { b: { c: 7 } } })
    assert.equal(s.get('a', 'b', 'c'), 7)
  })

  test('liveObject creates intermediate objects on nested write', ({ assert }) => {
    const s = liveObject({})
    s.set('a', 'b', 'c', 42)
    assert.equal(s.target.a.b.c, 42)
    assert.equal(s.get('a', 'b', 'c'), 42)
  })

  test('liveObject get() with no path returns the whole target', ({ assert }) => {
    const target = { x: 1 }
    const s = liveObject(target)
    assert.equal(s.get(), target)
  })

  test('liveObject set() with no path replaces the value in place', ({ assert }) => {
    const s = liveObject({ a: 1, b: 2 })
    s.set({ c: 3 })
    assert.equal(s.target.a, undefined)
    assert.equal(s.target.c, 3)
  })

  test('liveObject set fires recaller watchers reading that path', async ({ assert }) => {
    const s = liveObject({ count: 0 })
    const seen = []
    s.recaller.watch('test', () => {
      seen.push(s.get('count'))
    })
    // first run subscribes synchronously
    assert.equal(seen.length, 1)
    assert.equal(seen[0], 0)
    s.set('count', 1)
    // Recaller flushes on the next tick
    await new Promise(r => setTimeout(r, 0))
    assert.equal(seen[seen.length - 1], 1, 'watcher re-ran with the new value')
  })

  test('liveObject get returns undefined for paths that miss', ({ assert }) => {
    const s = liveObject({ a: 1 })
    assert.equal(s.get('nope'), undefined)
    assert.equal(s.get('a', 'b', 'c'), undefined)
  })

  test('liveObject accepts an external recaller via options', ({ assert }) => {
    const shared = new Recaller('shared')
    const a = liveObject({ x: 1 }, { recaller: shared })
    const b = liveObject({ y: 2 }, { recaller: shared })
    assert.equal(a.recaller, shared)
    assert.equal(b.recaller, shared)
  })

  test('liveObjects sharing a recaller trigger each other’s watchers', async ({ assert }) => {
    const shared = new Recaller('shared')
    const a = liveObject({ x: 1 }, { recaller: shared })
    const b = liveObject({ y: 2 }, { recaller: shared })
    const seen = []
    shared.watch('cross', () => {
      seen.push([a.get('x'), b.get('y')])
    })
    assert.deepEqual(seen[0], [1, 2], 'initial run sees both')
    b.set('y', 20)
    await new Promise(r => setTimeout(r, 0))
    assert.deepEqual(seen[seen.length - 1], [1, 20], 'b.set fired the watcher, both values read')
    a.set('x', 10)
    await new Promise(r => setTimeout(r, 0))
    assert.deepEqual(seen[seen.length - 1], [10, 20], 'a.set fires the same watcher')
  })

  test('isLiveSource structural check', ({ assert }) => {
    const s = liveObject({})
    assert.ok(isLiveSource(s))
    assert.ok(!isLiveSource(null))
    assert.ok(!isLiveSource({}))
    assert.ok(!isLiveSource({ recaller: 'nope', get: () => {}, set: () => {} }))
    assert.ok(!isLiveSource({ recaller: new Recaller('r'), get: () => {} }))  // missing set
  })

  test('liveObject still accepts legacy string-name as second arg', ({ assert }) => {
    const s = liveObject({}, 'legacy-name')
    assert.ok(s.recaller instanceof Recaller)
  })

  test('liveValue holds a single value with no path', ({ assert }) => {
    const v = liveValue(null)
    assert.equal(v.get(), null)
    v.set(42)
    assert.equal(v.get(), 42)
    v.set('hello')
    assert.equal(v.get(), 'hello')
    assert.ok(isLiveSource(v))
  })

  test('liveValue fires its recaller on set', async ({ assert }) => {
    const r = new Recaller('test')
    const v = liveValue(0, { recaller: r })
    const seen = []
    r.watch('w', () => { seen.push(v.get()) })
    assert.deepEqual(seen, [0], 'initial run sees initial')
    v.set(7)
    await new Promise(r => setTimeout(r, 0))
    assert.deepEqual(seen, [0, 7], 'set fires the watcher')
  })
})
