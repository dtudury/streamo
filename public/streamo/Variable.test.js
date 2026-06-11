import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Variable } from './Variable.js'
import { CodecRegistry } from './CodecRegistry.js'

test('Variable.inline carries bytes; isInline true, isAddressed false', () => {
  const fakeCodec = { type: 'TEST' }
  const v = Variable.inline(fakeCodec, new Uint8Array([1, 2, 3]))
  assert.equal(v.isInline, true)
  assert.equal(v.isAddressed, false)
  assert.equal(v.codec, fakeCodec)
  assert.deepEqual(v.bytes, new Uint8Array([1, 2, 3]))
  assert.equal(v.address, undefined)
})

test('Variable.addressed carries address; isAddressed true, isInline false', () => {
  const fakeCodec = { type: 'TEST' }
  const v = Variable.addressed(fakeCodec, 42)
  assert.equal(v.isAddressed, true)
  assert.equal(v.isInline, false)
  assert.equal(v.codec, fakeCodec)
  assert.equal(v.address, 42)
  assert.equal(v.bytes, undefined)
})

test('Variable.resolve returns inline bytes for inline; resolves via r for addressed', () => {
  const r = new CodecRegistry()
  const variable = r.encode('hello')
  const code = variable.resolve(r)
  const addr = variable.materialize(r).address
  const inline = Variable.inline({ type: 'X' }, code)
  const addressed = Variable.addressed({ type: 'X' }, addr)
  assert.deepEqual(inline.resolve(r), code)
  assert.deepEqual(addressed.resolve(r), code)
})

test('Variable.materialize: inline → addressed via r.append', () => {
  const r = new CodecRegistry()
  const variable = r.encode('hello world — repeated')
  const code = variable.resolve(r)
  const inline = Variable.inline({ type: 'X' }, code)
  const materialized = inline.materialize(r)
  assert.equal(materialized.isAddressed, true)
  assert.equal(typeof materialized.address, 'number')
  // Idempotent for already-addressed
  const again = materialized.materialize(r)
  assert.equal(again.address, materialized.address)
})

test('Variable.materialize dedups against existing chunks via addressOf', () => {
  const r = new CodecRegistry()
  const variable = r.encode('hello world — repeated')
  const firstAppendAddr = variable.materialize(r).address
  const code = r.resolve(firstAppendAddr)
  const inline = Variable.inline({ type: 'X' }, code)
  const m = inline.materialize(r)
  // Existing chunk should be reused, not re-appended.
  assert.equal(m.address, firstAppendAddr)
})

test('decompose(compose(codec, children)) returns equivalent children', () => {
  const r = new CodecRegistry()
  // Build a string chunk via the existing path so we have a real composite.
  const variable = r.encode('hello world — long enough to address')
  const stringAddr = variable.materialize(r).address
  const stringCode = r.resolve(stringAddr)
  const stringV = Variable.addressed(r.footerToCodec[stringCode.at(-1)], stringAddr)

  const { codec, children } = r.decompose(stringV)
  const recomposed = r.compose(codec, children)
  const { codec: codec2, children: children2 } = r.decompose(recomposed)
  assert.equal(codec2, codec)
  assert.equal(children2.length, children.length)
  for (let i = 0; i < children.length; i++) {
    assert.equal(children2[i].isInline, children[i].isInline)
    assert.equal(children2[i].isAddressed, children[i].isAddressed)
    if (children[i].isAddressed) assert.equal(children2[i].address, children[i].address)
  }
})

test('compose then resolve produces bit-identical bytes to original encode', () => {
  const r = new CodecRegistry()
  const variable = r.encode({ a: 1, b: 'hello world', c: [1, 2, 3, 4, 5] })
  const addr = variable.materialize(r).address
  const original = r.resolve(addr)
  const codec = r.footerToCodec[original.at(-1)]
  const sourceV = Variable.addressed(codec, addr)
  const { codec: c2, children } = r.decompose(sourceV)
  const recomposed = r.compose(c2, children)
  assert.deepEqual(recomposed.bytes, original)
})

test('decompose handles primitive Variables (no children)', () => {
  const r = new CodecRegistry()
  const variable = r.encode(true) // TRUE primitive, 1 byte
  const code = variable.resolve(r)
  const v = Variable.inline(r.footerToCodec[code.at(-1)], code)
  const { codec, children } = r.decompose(v)
  assert.equal(codec.type, 'TRUE')
  assert.deepEqual(children, [])
})

test('decompose handles addressed Variable (resolves via r)', () => {
  const r = new CodecRegistry()
  const variable = r.encode('long enough string to be stored')
  const addr = variable.materialize(r).address
  const code = r.resolve(addr)
  const v = Variable.addressed(r.footerToCodec[code.at(-1)], addr)
  const { codec, children } = r.decompose(v)
  // STRING has one child (the UINT8ARRAY of bytes)
  assert.equal(codec.type, 'STRING')
  assert.equal(children.length, 1)
})

test('compose returns inline Variable; caller opts into materialize', () => {
  const r = new CodecRegistry()
  const variable = r.encode([1, 2, 3])
  const addr = variable.materialize(r).address
  const code = r.resolve(addr)
  const v = Variable.addressed(r.footerToCodec[code.at(-1)], addr)
  const { codec, children } = r.decompose(v)
  const composed = r.compose(codec, children)
  assert.equal(composed.isInline, true)
  assert.equal(composed.isAddressed, false)
})

test('copyFrom: shared region — returns Variable unchanged', () => {
  const r = new CodecRegistry()
  const variable = r.encode('shared content')
  const addr = variable.materialize(r).address
  const code = r.resolve(addr)
  // Pretend we have two registries with shared content up through `addr`.
  // Within the shared region the Variable's address is universal.
  const v = Variable.addressed(r.footerToCodec[code.at(-1)], addr)
  const result = r.copyFrom(r, v, addr) // sharedThrough = addr
  assert.equal(result.isAddressed, true)
  assert.equal(result.address, addr)
})

test('copyFrom: address already in this (dedup) — returns existing address', () => {
  const r1 = new CodecRegistry()
  const r2 = new CodecRegistry()
  // Pre-populate r2 with the same content under a different address
  const r2Variable = r2.encode('duplicate content')
  const r2Addr = r2Variable.materialize(r2).address
  // Encode in r1 too
  const r1Variable = r1.encode('duplicate content')
  const r1Addr = r1Variable.materialize(r1).address
  const r1Code = r1.resolve(r1Addr)
  // Now copy r1's Variable into r2 — should dedup to r2Addr
  const v = Variable.addressed(r1.footerToCodec[r1Code.at(-1)], r1Addr)
  const result = r2.copyFrom(r1, v, -1)
  assert.equal(result.isAddressed, true)
  assert.equal(result.address, r2Addr)
})

test('copyFrom: inline child — re-encodes in this context', () => {
  const r1 = new CodecRegistry()
  const r2 = new CodecRegistry()
  // r1: small value that gets inlined when wrapped
  // We force this by constructing an inline Variable directly.
  const variable = r1.encode('hi') // small enough to be inlineable
  const code = variable.resolve(r1)
  const v = Variable.inline(r1.footerToCodec[code.at(-1)], code)
  const result = r2.copyFrom(r1, v, -1)
  // Should produce a Variable in r2 (inline or addressed; codec decides)
  assert.equal(result.codec.type, 'STRING')
  // The bytes (if inline) or resolved chunk (if addressed) should round-trip
  const finalBytes = result.isInline ? result.bytes : r2.resolve(result.address)
  assert.deepEqual(finalBytes, code) // string-of-2-chars re-encodes identically
})

test('copyFrom: addressed-new — recursive copyFrom + compose parent', () => {
  const r1 = new CodecRegistry()
  const r2 = new CodecRegistry()
  // r1 has a composite (object), r2 doesn't.
  const value = { x: 'hello world long string', y: 42 }
  const variable = r1.encode(value)
  const r1Addr = variable.materialize(r1).address
  const code = r1.resolve(r1Addr)
  const v = Variable.addressed(r1.footerToCodec[code.at(-1)], r1Addr)
  const result = r2.copyFrom(r1, v, -1)
  assert.equal(result.isAddressed, true)
  // Round-trip via decode in r2
  assert.deepEqual(r2.decode(result.address), value)
})

// ─── The throw discipline ────────────────────────────────────────────────
test('CodecRegistry.append throws when given a Variable', () => {
  const r = new CodecRegistry()
  const v = r.encode('hi')
  // Until append is updated to throw, this test will FAIL — that's the
  // signal to wire in the guard.
  assert.throws(() => r.append(v), /Variable/)
})
