import { describe } from './utils/testing.js'
import { liveObject } from './LiveSource.js'

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
})
