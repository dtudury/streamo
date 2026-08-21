import { describe } from './utils/testing.js'
import { decodeBytes, decodeFile, encodeFile, filesEqual } from './fileCodec.js'

const bytes = text => new TextEncoder().encode(text)
const roundTrip = (rel, text) => encodeFile(rel, decodeFile(rel, decodeBytes(bytes(text))))

describe(import.meta.url, ({ test }) => {
  test('an unparseable .json survives the round trip byte-identically', async ({ assert }) => {
    const halfTyped = '{ "name": "half-typ'
    assert.equal(decodeFile('config.json', halfTyped), halfTyped)
    assert.equal(roundTrip('config.json', halfTyped), halfTyped)
  })

  test('an unparseable .json does not throw on the write path', async ({ assert }) => {
    // Before 2026-08-20 this threw, and writeToFolder throws mid-loop — so one
    // half-typed .json anywhere in the tree aborted the whole repo→disk flush
    // and every other file silently failed to land with it.
    assert.equal(encodeFile('config.json', '{ not json'), '{ not json')
  })

  test('a parseable .json still normalises through the object form', async ({ assert }) => {
    assert.deepEqual(decodeFile('a.json', '{"a":1}'), { a: 1 })
    assert.equal(roundTrip('a.json', '{"a":1}'), '{\n  "a": 1\n}\n')
  })

  test('.json still refuses shapes that are neither text nor a container', async ({ assert }) => {
    for (const value of [null, undefined, 42, true]) {
      assert.throws(() => encodeFile('x.json', value), `expected .json + ${String(value)} to throw`)
    }
  })

  test('.jsonl keeps the rule .json now shares', async ({ assert }) => {
    assert.equal(roundTrip('a.jsonl', '{ nope\n'), '{ nope\n')
    assert.equal(roundTrip('a.jsonl', '{"a":1}\n'), '{"a":1}\n')
  })

  test('filesEqual compares decoded values, not references', async ({ assert }) => {
    assert.ok(filesEqual({ 'a.json': { a: 1 } }, { 'a.json': { a: 1 } }))
    assert.ok(!filesEqual({ 'a.json': { a: 1 } }, { 'a.json': { a: 2 } }))
    assert.ok(filesEqual({ b: new Uint8Array([1, 2]) }, { b: new Uint8Array([1, 2]) }))
    assert.ok(!filesEqual({ b: new Uint8Array([1, 2]) }, { b: new Uint8Array([1, 3]) }))
  })
})
