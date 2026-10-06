import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodecRegistry } from './CodecRegistry.js'

// Was Variable.test.js until 2026-10-06. Variable is gone — encode appends and
// returns an address — so what is left to test here is the decompose/compose
// pair and copyFrom's branches, all of which now speak in addresses.

test('decompose(compose(codec, children)) returns equivalent children', () => {
  const r = new CodecRegistry()
  const stringAddr = r.encode('hello world — long enough to address')

  const { codec, children } = r.decompose(stringAddr)
  const recomposed = r.compose(codec, children)
  const { codec: codec2, children: children2 } = r.decompose(recomposed)
  assert.equal(codec2, codec)
  assert.deepEqual(children2, children, 'children are addresses and survive the round trip')
})

test('compose reproduces bit-identical bytes, and dedups back to the same address', () => {
  const r = new CodecRegistry()
  const addr = r.encode({ a: 1, b: 'hello world', c: [1, 2, 3, 4, 5] })
  const original = r.resolve(addr)
  const { codec: c2, children } = r.decompose(addr)
  const recomposed = r.compose(c2, children)
  assert.deepEqual(r.resolve(recomposed), original, 'same bytes')
  assert.equal(recomposed, addr, 'and so it dedups to the address it came from')
})

test('decompose of a primitive has no children', () => {
  const r = new CodecRegistry()
  const { codec, children } = r.decompose(r.encode(true))
  assert.equal(codec.type, 'TRUE')
  assert.deepEqual(children, [])
})

test('decompose of a STRING gives one addressed child', () => {
  const r = new CodecRegistry()
  const { codec, children } = r.decompose(r.encode('long enough string to be stored'))
  assert.equal(codec.type, 'STRING')
  assert.equal(children.length, 1)
  assert.equal(typeof children[0], 'number', 'every part is an address')
})

test('compose stores what it composes — there is nothing to materialize', () => {
  const r = new CodecRegistry()
  const { codec, children } = r.decompose(r.encode([1, 2, 3]))
  const before = r.byteLength
  const composed = r.compose(codec, children)
  assert.equal(typeof composed, 'number', 'compose hands back an address')
  assert.equal(r.addressOf(r.resolve(composed)), composed, 'and the bytes are in the store')
  assert.equal(r.byteLength, before, 'this one deduped, so nothing grew')
})

test('compose refuses a child that is not an address', () => {
  const r = new CodecRegistry()
  const { codec, children } = r.decompose(r.encode('a string to decompose'))
  assert.throws(() => r.compose(codec, [new Uint8Array([1, 2])]), /must be an address/)
  assert.equal(children.length, 1, 'sanity: there was a child to replace')
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

test('copyFrom: addressed-new — recurses, composes the parent, and decodes equal', () => {
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
