import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodecRegistry } from './CodecRegistry.js'
import { decodeParts } from './codecs.js'

// Bit-identical-output invariant: copyFrom into a clean registry must produce
// bytes byte-for-byte identical to a fresh encode in that registry. Without
// this, copied chunks don't dedup with standard encodes and content-addressing
// silently fragments. Failure mode is silent — hence the wide sweep below.

function assertCopyFromBitIdentical (value) {
  const r1 = new CodecRegistry()
  const r2Expected = new CodecRegistry()
  const r2Actual = new CodecRegistry()

  const expectedAddr = r2Expected.encode(value)
  const expectedBytes = r2Expected.resolve(expectedAddr)

  const actualAddr = r2Actual.copyFrom(r1, r1.encode(value), -1)
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

// ─── Sharing semantics: sharedThrough returns the address as-is ─────────
test('copyFrom: shared region returns the address unchanged (no copy work)', () => {
  const r1 = new CodecRegistry()
  const r2 = new CodecRegistry()
  // Make r2 share a prefix of r1's bytes (same values encoded in same order
  // = byte-identical chunks at byte-identical addresses, by construction).
  const sharedValues = ['first', 'second', 'third']
  let lastSharedAddr
  for (const v of sharedValues) {
    r1.encode(v)
    lastSharedAddr = r2.encode(v)
  }
  // Now copy an address pointing into the shared region.
  const result = r1.copyFrom(r2, lastSharedAddr, lastSharedAddr)
  assert.equal(result, lastSharedAddr)
})

// ─── The chunk graph copyFrom descends ──────────────────────────────────────
// Moved here 2026-10-07 when compose/decompose were folded into copyFrom.
// compose.test.js tested them directly; what survives is the behaviour.

// decodeParts needs the registry interface the codecs are given; the parts of
// interest (addresses) only use footerToCodec, resolve and decode.
const partsOf = (r, value) => decodeParts(
  { footerToCodec: r.footerToCodec, resolve: a => r.resolve(a), decode: (c, x) => r.decode(c, x) },
  r.resolve(r.encode(value))
)

test('every part of a composite is an address — the premise copyFrom descends on', () => {
  const r = new CodecRegistry()
  for (const value of [{ a: 1, b: 2 }, [1, 2, 3], 'long enough string to be stored', new Date(0)]) {
    const parts = partsOf(r, value)
    assert.ok(parts.length > 0, `${JSON.stringify(value)} has parts to check`)
    for (const [i, part] of parts.entries()) {
      assert.equal(typeof part.address, 'number',
        `${JSON.stringify(value)} part ${i} is an address, not embedded data (${part.type})`)
    }
  }
})

test('a leaf-data chunk has a part that is NOT an address — so copyFrom re-encodes it', () => {
  const r = new CodecRegistry()
  // WORD carries its bytes as a literal part. copyFrom cannot copy that
  // piecewise, which is exactly why it falls back to decode + re-encode.
  const parts = partsOf(r, new Uint8Array([1, 2, 3]))
  assert.ok(parts.some(part => part.address === undefined),
    `a 3-byte Uint8Array should have embedded data, got ${parts.map(p => p.type).join(', ')}`)
})

test('copyFrom: inside the shared region the address carries over untouched', () => {
  const r = new CodecRegistry()
  const addr = r.encode('shared content')
  assert.equal(r.copyFrom(r, addr, addr), addr, 'sharedThrough = addr, so no work')
})

test('copyFrom: same content already here under a different address — dedups to ours', () => {
  const r1 = new CodecRegistry()
  const r2 = new CodecRegistry()
  r2.encode('padding so the addresses differ between the two')
  const r2Addr = r2.encode('duplicate content')
  const r1Addr = r1.encode('duplicate content')
  assert.notEqual(r1Addr, r2Addr, 'sanity: the two registries disagree on the address')
  assert.equal(r2.copyFrom(r1, r1Addr, -1), r2Addr)
})

test('copyFrom: addressed-new — recurses, rebuilds the parent, and decodes equal', () => {
  const r1 = new CodecRegistry()
  const r2 = new CodecRegistry()
  const value = { x: 'hello world long string', y: 42 }
  const result = r2.copyFrom(r1, r1.encode(value), -1)
  assert.equal(typeof result, 'number')
  assert.deepEqual(r2.decode(result), value)
})

test('copyFrom rejects anything but an address', () => {
  const r = new CodecRegistry()
  assert.throws(() => r.copyFrom(r, new Uint8Array([1]), -1), /expected an address/)
})
