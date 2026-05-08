// Codec contract tests.
//
// codecs.js is the largest source file in streamo and was the most-fixed file
// in the predecessor project (turtb's CompositeCodec.js had 10+ commits).
// These tests exist to PIN the codec contract — both for round-trip correctness
// and for the surprising-but-deliberate behaviors a future reader might be
// tempted to "fix."
//
// Two real fixes also live here:
//   1. Empty Uint8Array (`new Uint8Array(0)`) used to throw "no codec for value"
//      because WORD requires v.length >= 1 and UINT8ARRAY requires v.length > 4.
//      Now handled by EMPTY_UINT8ARRAY (appended at the END of the registration
//      list so existing footer values don't shift — backwards-compatible).
//   2. Empty class instance (`new (class {})()`) used to throw because
//      EMPTY_OBJECT rejected non-Object.prototype objects but OBJECT didn't.
//      Now consistent — both accept class instances; type info is lost on
//      round-trip in either case.

import { describe } from './utils/testing.js'
import { Streamo } from './Streamo.js'

describe(import.meta.url, ({ test }) => {
  // ── Helper: round-trip via encodeVariable + decode ────────────────────────
  const rt = (value) => {
    const s = new Streamo()
    return s.decode(s.encodeVariable(value))
  }

  // ── Regression: bugs that used to throw "no codec for value" ──────────────

  test('empty Uint8Array round-trips', ({ assert }) => {
    const decoded = rt(new Uint8Array(0))
    assert.ok(decoded instanceof Uint8Array, 'must decode to a Uint8Array')
    assert.equal(decoded.length, 0, 'must be empty')
  })

  test('empty class instance round-trips (as plain {})', ({ assert }) => {
    class Foo {}
    const decoded = rt(new Foo())
    assert.deepEqual(decoded, {}, 'class instance decodes as plain {} — type info lost (consistent with non-empty class instances)')
  })

  test('non-empty class instance round-trips (as plain object) — pins existing behavior', ({ assert }) => {
    class Foo { constructor () { this.x = 1; this.y = 'hi' } }
    const decoded = rt(new Foo())
    assert.deepEqual(decoded, { x: 1, y: 'hi' })
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype, 'prototype is lost on round-trip')
  })

  // ── Pin: deliberate quirks that are NOT bugs ──────────────────────────────

  test('-0 decodes as 0 (UINT7 path)', ({ assert }) => {
    // -0 is Number.isInteger(-0) === true, and 0 <= -0 < 128, so it goes
    // through UINT7 which encodes by index. Object.is(-0, 0) is false but
    // we pin the lossy round-trip here so future-me knows it's deliberate.
    const decoded = rt(-0)
    assert.equal(decoded, 0)
    assert.ok(!Object.is(-0, decoded), 'sign of zero is lost — pinned as deliberate')
  })

  test('NaN round-trips', ({ assert }) => {
    assert.ok(Number.isNaN(rt(NaN)), 'NaN survives through FLOAT64')
  })

  test('Infinity / -Infinity round-trip', ({ assert }) => {
    assert.equal(rt(Infinity), Infinity)
    assert.equal(rt(-Infinity), -Infinity)
  })

  test('object key insertion order matters for dedup', ({ assert }) => {
    // Same content, different key order = different bytes = different addresses.
    // Dedup is by bytes, not semantics. This is intrinsic to the design.
    const s = new Streamo()
    const a = s.encodeVariable({ x: 1, y: 2 })
    const b = s.encodeVariable({ y: 2, x: 1 })
    const same = a.length === b.length && a.every((v, i) => v === b[i])
    assert.ok(!same, 'different key orders produce different bytes (pinned as deliberate)')
  })

  // ── Boundary tests: the cliff edges between codecs ────────────────────────

  test('UINT7 / FLOAT64 boundary (127 vs 128)', ({ assert }) => {
    assert.equal(rt(127), 127, '127 is the largest UINT7 — fits in one byte')
    assert.equal(rt(128), 128, '128 falls through to FLOAT64 — encoded as 8 bytes')
  })

  test('WORD / UINT8ARRAY boundary (4 vs 5 bytes)', ({ assert }) => {
    const four = new Uint8Array([1, 2, 3, 4])
    const five = new Uint8Array([1, 2, 3, 4, 5])
    assert.deepEqual([...rt(four)], [1, 2, 3, 4], 'WORD covers exactly 4 bytes')
    assert.deepEqual([...rt(five)], [1, 2, 3, 4, 5], 'UINT8ARRAY takes over at 5+ bytes')
  })

  // ── Composite: arrays and objects of various shapes ───────────────────────

  test('single-element array', ({ assert }) => {
    // Encoded via the object-with-length-key form, not the Duple-tree form
    assert.deepEqual(rt([42]), [42])
  })

  test('three-element array (asymmetric Duple tree)', ({ assert }) => {
    // For length 3, the Duple tree is unbalanced: Duple([Duple([v0, v1]), v2]).
    // Pinned because the asymmetry was a turtb bug class.
    assert.deepEqual(rt([1, 2, 3]), [1, 2, 3])
  })

  test('sparse array round-trips as sparse', ({ assert }) => {
    const a = [1, 2, 3]
    delete a[1]
    const decoded = rt(a)
    assert.equal(decoded.length, 3)
    assert.equal(decoded[0], 1)
    assert.equal(decoded[2], 3)
    assert.ok(!(1 in decoded), 'index 1 stays empty after round-trip')
  })

  test('nested arrays', ({ assert }) => {
    const nested = [[1, 2], [3, [4, 5, 6]], []]
    assert.deepEqual(rt(nested), nested)
  })

  test('single-key object', ({ assert }) => {
    assert.deepEqual(rt({ only: 42 }), { only: 42 })
  })

  test('object with a "length" key', ({ assert }) => {
    // This used to be a turtb bug class — array-vs-object disambiguation.
    // Objects with a `length` key should still decode as objects.
    assert.deepEqual(rt({ items: 5, length: 'short' }), { items: 5, length: 'short' })
  })

  test('deeply nested mixed structure', ({ assert }) => {
    const v = {
      users: [
        { name: 'alice', score: 100, tags: ['a', 'b', 'c'] },
        { name: 'bob', score: 0, tags: [] }
      ],
      meta: { created: new Date('2026-05-08T00:00:00Z'), count: 2 }
    }
    const out = rt(v)
    assert.equal(out.users[0].name, 'alice')
    assert.equal(out.users[0].score, 100)
    assert.deepEqual(out.users[0].tags, ['a', 'b', 'c'])
    assert.deepEqual(out.users[1].tags, [])
    assert.equal(out.meta.count, 2)
    assert.ok(out.meta.created instanceof Date)
    assert.equal(out.meta.created.toISOString(), '2026-05-08T00:00:00.000Z')
  })

  // ── Dedup: identical content lands at identical addresses ─────────────────

  test('identical strings dedup to the same address', ({ assert }) => {
    const s = new Streamo()
    const a = s.encodeVariable('hello, world — repeated')
    const b = s.encodeVariable('hello, world — repeated')
    // VARIABLE wrappers may differ at the top level, but the inner string
    // chunk should be at the same address. We test indirectly: total
    // byteLength after the second encode shouldn't grow by the full string
    // length again.
    const beforeSecond = s.byteLength
    s.append(a)
    const afterFirst = s.byteLength
    // (b was constructed but not appended — we'd be re-appending duplicates.)
    // Instead: append a string twice via a fresh streamo and observe.
    const s2 = new Streamo()
    s2.set('hello, world — this is long enough to need a separate chunk')
    const len1 = s2.byteLength
    s2.set('hello, world — this is long enough to need a separate chunk')
    const len2 = s2.byteLength
    assert.ok(len2 - len1 < 20, 'second identical set adds only a small wrapper, not the full string again')
  })
})
