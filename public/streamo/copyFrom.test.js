import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodecRegistry } from './CodecRegistry.js'
import { Variable } from './Variable.js'

// Bit-identical-output invariant: copyFrom into a clean registry must produce
// bytes byte-for-byte identical to a fresh encode in that registry. Without
// this, copied chunks don't dedup with standard encodes and content-addressing
// silently fragments. Failure mode is silent — hence the wide sweep below.

function assertCopyFromBitIdentical (value) {
  const r1 = new CodecRegistry()
  const r2Expected = new CodecRegistry()
  const r2Actual = new CodecRegistry()

  const expectedAddr = r2Expected.encode(value).materialize(r2Expected).address
  const expectedBytes = r2Expected.resolve(expectedAddr)

  const r1Addr = r1.encode(value).materialize(r1).address
  const r1Bytes = r1.resolve(r1Addr)
  const sourceV = Variable.addressed(r1.footerToCodec[r1Bytes.at(-1)], r1Addr)
  const copied = r2Actual.copyFrom(r1, sourceV, -1)
  const actualAddr = copied.isAddressed ? copied.address : copied.materialize(r2Actual).address
  const actualBytes = r2Actual.resolve(actualAddr)

  assert.deepEqual(actualBytes, expectedBytes, 'copyFrom should be bit-identical to fresh encode')
  assert.deepEqual(r2Actual.decode(actualAddr), value)  // round-trip sanity
}

// ─── Primitives ─────────────────────────────────────────────────────────

test('copyFrom bit-identical: undefined', () => assertCopyFromBitIdentical(undefined))
test('copyFrom bit-identical: null',      () => assertCopyFromBitIdentical(null))
test('copyFrom bit-identical: true',      () => assertCopyFromBitIdentical(true))
test('copyFrom bit-identical: false',     () => assertCopyFromBitIdentical(false))
test('copyFrom bit-identical: empty string', () => assertCopyFromBitIdentical(''))
test('copyFrom bit-identical: empty array',  () => assertCopyFromBitIdentical([]))
test('copyFrom bit-identical: empty object', () => assertCopyFromBitIdentical({}))
test('copyFrom bit-identical: empty Uint8Array', () => assertCopyFromBitIdentical(new Uint8Array(0)))

// ─── UINT7 territory (small ints 0–127) ─────────────────────────────────
for (const n of [0, 1, 5, 42, 100, 127]) {
  test(`copyFrom bit-identical: int ${n} (UINT7)`, () => assertCopyFromBitIdentical(n))
}

// ─── WORD territory (ints ≥ 128) ────────────────────────────────────────
for (const n of [128, 255, 256, 1000, 65535, 1 << 20, 1 << 30]) {
  test(`copyFrom bit-identical: int ${n} (WORD)`, () => assertCopyFromBitIdentical(n))
}

// ─── Floats ──────────────────────────────────────────────────────────────
for (const f of [0.5, -1.25, 3.14159, 1e-10, 1e20]) {
  test(`copyFrom bit-identical: float ${f}`, () => assertCopyFromBitIdentical(f))
}

// ─── Strings of various sizes ───────────────────────────────────────────
for (const s of ['a', 'hi', 'hello', 'hello world', 'x'.repeat(100), 'x'.repeat(10_000)]) {
  test(`copyFrom bit-identical: string len=${s.length}`, () => assertCopyFromBitIdentical(s))
}

// ─── Dates ──────────────────────────────────────────────────────────────
test('copyFrom bit-identical: Date(0)',  () => assertCopyFromBitIdentical(new Date(0)))
test('copyFrom bit-identical: Date.now', () => assertCopyFromBitIdentical(new Date(2026, 5, 10)))

// ─── Uint8Arrays ────────────────────────────────────────────────────────
for (const n of [1, 2, 4, 8, 16, 100, 1000]) {
  test(`copyFrom bit-identical: Uint8Array len=${n}`, () => {
    const arr = new Uint8Array(n)
    for (let i = 0; i < n; i++) arr[i] = i & 0xff
    assertCopyFromBitIdentical(arr)
  })
}

// ─── Arrays — the headline test surface ─────────────────────────────────
// Small sizes densely + every split-jump boundary (N = 2^k + 1) where the
// Duple tree restructures — most likely place for bit-identity to diverge.
const arraySizes = [
  ...Array.from({ length: 20 }, (_, i) => i + 1),  // 1..20
  25, 30, 50, 100,
  9, 17, 33, 65, 129, 257, 513, 1025, 2049, 4097, 8193  // split-jump boundaries
]
for (const N of [...new Set(arraySizes)].sort((a, b) => a - b)) {
  test(`copyFrom bit-identical: array of small ints, N=${N}`, () => {
    const arr = Array.from({ length: N }, (_, i) => i % 100)  // small ints (UINT7 + repeats for dedup)
    assertCopyFromBitIdentical(arr)
  })

  // For larger arrays, also test with mixed content so we hit non-UINT7 paths.
  if (N >= 5 && N <= 100) {
    test(`copyFrom bit-identical: array mixed types, N=${N}`, () => {
      const arr = Array.from({ length: N }, (_, i) => {
        if (i % 4 === 0) return `item ${i}`
        if (i % 4 === 1) return i * 1000
        if (i % 4 === 2) return i % 2 === 0
        return null
      })
      assertCopyFromBitIdentical(arr)
    })
  }
}

// ─── Objects ────────────────────────────────────────────────────────────
for (const nKeys of [1, 2, 5, 10, 20, 50]) {
  test(`copyFrom bit-identical: object with ${nKeys} keys`, () => {
    const o = {}
    for (let i = 0; i < nKeys; i++) o[`key${i}`] = `value ${i}`
    assertCopyFromBitIdentical(o)
  })
}

// ─── Nested composites ──────────────────────────────────────────────────
test('copyFrom bit-identical: array of objects', () => {
  assertCopyFromBitIdentical([
    { name: 'a', value: 1 },
    { name: 'b', value: 2 },
    { name: 'c', value: 3 }
  ])
})

test('copyFrom bit-identical: object containing array', () => {
  assertCopyFromBitIdentical({
    title: 'demo',
    items: [10, 20, 30, 40, 50],
    meta: { created: new Date(0), enabled: true }
  })
})

test('copyFrom bit-identical: deeply nested', () => {
  assertCopyFromBitIdentical({
    a: { b: { c: { d: { e: 'deep' } } } },
    list: [[1, 2], [3, 4], [5, 6]]
  })
})

// ─── A JSONL-line-shaped value (the watcher use case) ───────────────────
test('copyFrom bit-identical: JSONL-line-shaped object', () => {
  assertCopyFromBitIdentical({
    type: 'assistant',
    uuid: 'abc-123-def',
    parentUuid: 'xyz-789',
    timestamp: '2026-06-10T12:34:56.789Z',
    message: {
      id: 'msg_01ABC',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello world from the Engineer.' },
        { type: 'thinking', thinking: 'Some reasoning here...', signature: 'sig_xyz' }
      ]
    }
  })
})

// ─── Sharing semantics: sharedThrough should return Variable as-is ──────
test('copyFrom: shared region returns Variable unchanged (no copy work)', () => {
  const r1 = new CodecRegistry()
  const r2 = new CodecRegistry()
  // Make r2 share a prefix of r1's bytes (same values encoded in same order
  // = byte-identical chunks at byte-identical addresses, by construction).
  const sharedValues = ['first', 'second', 'third']
  let lastSharedAddr
  for (const v of sharedValues) {
    r1.encode(v).materialize(r1)
    lastSharedAddr = r2.encode(v).materialize(r2).address
  }
  // Now copy a Variable pointing into the shared region.
  const code = r1.resolve(lastSharedAddr)
  const v = Variable.addressed(r1.footerToCodec[code.at(-1)], lastSharedAddr)
  const result = r1.copyFrom(r2, v, lastSharedAddr)
  assert.equal(result.isAddressed, true)
  assert.equal(result.address, lastSharedAddr)
})
