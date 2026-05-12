import { describe } from './utils/testing.js'
import { Streamo, ConflictError, changedPaths } from './Streamo.js'
import { Signer } from './Signer.js'
import { Signature } from './Signature.js'

describe(import.meta.url, ({ test }) => {
  test('encodes and decodes primitive values', ({ assert }) => {
    const s = new Streamo()
    const values = [
      undefined, null, false, true,
      0, 1, 127,
      128, -1, 3.14, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6, 7]),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      'hello',
      'a longer string that definitely does not fit in four bytes',
      new Date('1969-07-21T22:56:15Z'),
      { a: 1, b: 2, c: 3 },
      { x: 'hello' },
      {},
      [1, 2, 3],
      [],
      ['a', 'b'],
      new Signature(0, new Uint8Array(64))
    ]
    for (const value of values) {
      const code = s.encodeVariable(value)
      const decoded = s.decode(code)
      assert.deepEqual(decoded, value, `round-trips ${Object.prototype.toString.call(value)}`)
    }
  })

  test('negative addresses for single-byte primitives', ({ assert }) => {
    const s = new Streamo()
    for (const v of [undefined, null, false, true, 0, 1, 127]) {
      const code = s.encode(v)
      assert.equal(code.length, 1, `${String(v)} encodes to 1 byte`)
      const addr = -(code[0] + 1)
      assert.ok(addr < 0, `${String(v)} has a negative address`)
      assert.deepEqual(s.decode(addr), v, `negative address resolves back to ${String(v)}`)
    }
  })

  test('deduplication: same value always gets the same address', ({ assert }) => {
    const s = new Streamo()
    const a1 = s.append(s.encode(42))
    s.append(s.encode({ x: 42 }))
    const code42 = s.encode(42)
    assert.equal(s.addressOf(code42), a1, 'second encode of 42 reuses the existing address')
  })

  test('reactive get/set/watch', async ({ assert }) => {
    const s = new Streamo()
    let callCount = 0
    let lastValue

    s.recaller.watch('test', () => {
      lastValue = s.get('greeting')
      callCount++
    })
    assert.equal(callCount, 1, 'watch runs immediately')
    assert.equal(lastValue, undefined, 'no value yet')

    s.set({ greeting: 'hello' })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(callCount, 2, 'watch re-ran after set')
    assert.equal(lastValue, 'hello', 'updated value seen')

    s.set('greeting', 'world')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(callCount, 3, 'watch re-ran after path set')
    assert.equal(lastValue, 'world', 'path update seen')
  })

  test('asRefs returns addresses for object values and names', ({ assert }) => {
    const s = new Streamo()
    const code = s.encode({ a: 1 })

    // asRefs=true: values become addresses, names stay as strings
    const withTrue = s.decode(code, true)
    assert.deepEqual(Object.keys(withTrue), ['a'])
    assert.equal(typeof withTrue.a, 'number', 'value is an address')
    assert.equal(s.decode(withTrue.a), 1, 'address decodes to original value')

    // asRefs=[true, false]: same — value is address, name is string
    const withValueRef = s.decode(code, [true, false])
    assert.equal(typeof withValueRef.a, 'number')
    assert.equal(s.decode(withValueRef.a), 1)

    // asRefs=[false, true]: value decoded, name is address
    const withNameRef = s.decode(code, [false, true])
    assert.deepEqual(Object.values(withNameRef), [1])
    const nameAddr = Number(Object.keys(withNameRef)[0])
    assert.equal(s.decode(nameAddr), 'a', 'key address decodes to the name string')
  })

  test('asRefs: object returns name/address map', ({ assert }) => {
    const s = new Streamo()
    s.set({ x: 1, y: 2 })
    const refs = s.asRefs(s.byteLength - 1)
    assert.deepEqual(Object.keys(refs), ['x', 'y'])
    assert.equal(typeof refs.x, 'number')
    assert.equal(typeof refs.y, 'number')
    assert.equal(s.decode(refs.x), 1)
    assert.equal(s.decode(refs.y), 2)
  })

  test('asRefs: array returns element addresses', ({ assert }) => {
    const s = new Streamo()
    s.set(['a', 'b', 'c'])
    const refs = s.asRefs(s.byteLength - 1)
    assert.ok(Array.isArray(refs))
    assert.equal(refs.length, 3)
    refs.forEach(addr => assert.equal(typeof addr, 'number'))
    assert.equal(s.decode(refs[0]), 'a')
    assert.equal(s.decode(refs[1]), 'b')
    assert.equal(s.decode(refs[2]), 'c')
  })

  test('asRefs: non-object returns the address itself', ({ assert }) => {
    const s = new Streamo()
    s.set('hello')
    const address = s.byteLength - 1
    assert.equal(s.asRefs(address), address)
  })

  test('encode(asRefs(addr), true) round-trips an object', ({ assert }) => {
    const s = new Streamo()
    s.set({ a: 1, b: 'hello' })
    const addr = s.byteLength - 1
    const refs = s.asRefs(addr)
    const code = s.encode(refs, true)
    assert.deepEqual(s.decode(code), { a: 1, b: 'hello' })
  })

  test('encode(asRefs(addr), true) round-trips an array', ({ assert }) => {
    const s = new Streamo()
    s.set([10, 20, 30])
    const addr = s.byteLength - 1
    const refs = s.asRefs(addr)
    const code = s.encode(refs, true)
    assert.deepEqual(s.decode(code), [10, 20, 30])
  })

  test('encode(asRefs(addr), true) round-trips a primitive', ({ assert }) => {
    const s = new Streamo()
    s.set('hello')
    const addr = s.byteLength - 1
    const refs = s.asRefs(addr)  // returns addr itself for non-objects
    const code = s.encode(refs, true)  // resolves addr → string code
    assert.equal(s.decode(code), 'hello')
  })

  test('sign and verify', async ({ assert }) => {
    const s = new Streamo()
    s.set({ hello: 'world' })
    s.set('hello', 'signed')

    const signer = new Signer('alice', 'secret')
    const name = 'my-streamo'
    const keys = await signer.keysFor(name)
    const sig = await s.sign(signer, name)

    assert.ok(sig instanceof Signature)
    assert.ok(await s.verify(sig, keys.publicKey), 'signature verifies with correct key')

    const other = new Signer('bob', 'different')
    const otherKeys = await other.keysFor(name)
    assert.ok(!(await s.verify(sig, otherKeys.publicKey)), 'wrong key does not verify')
  })

  test('conditionalSet rejects stale edits and accepts fresh ones', ({ assert }) => {
    const s = new Streamo()
    s.set({ x: 1 })
    const tip = s.byteLength

    // A concurrent write advances the streamo past tip
    s.set({ x: 2 })

    // Stale edit is rejected
    let caught
    try { s.conditionalSet(tip, { x: 3 }) } catch (e) { caught = e }
    assert.ok(caught instanceof ConflictError, 'throws ConflictError')
    assert.equal(caught.expectedTip, tip)
    assert.equal(caught.actualTip, s.byteLength)
    assert.equal(s.get('x'), 2, 'streamo unchanged after rejection')

    // Fresh edit at current tip succeeds
    const freshTip = s.byteLength
    s.conditionalSet(freshTip, { x: 3 })
    assert.equal(s.get('x'), 3, 'fresh conditional set applied')
  })

  test('clone snapshots state at a given address', ({ assert }) => {
    const s = new Streamo()
    s.set({ v: 1 })
    const addr1 = s.byteLength - 1
    s.set({ v: 2 })

    const snap = s.clone(addr1)
    assert.equal(snap.get('v'), 1, 'clone reflects state at snapshot address')
    assert.equal(s.get('v'), 2, 'original still reflects latest state')
  })

  test('changedPaths fires on array.length when arrays differ in length', ({ assert }) => {
    // Watchers that read arr.length register a dep on [...path, 'length'],
    // which is not in Object.keys(arr). changedPaths must yield it explicitly
    // so length-watchers wake when an array grows or shrinks.
    const s = new Streamo()
    const addrA = s.set({ items: [1, 2, 3] })
    const addrB = s.set({ items: [1, 2, 3, 4] })
    const paths = [...changedPaths(s, addrA, addrB)].map(p => p.join('.'))
    assert.ok(paths.includes('items.length'),
      `expected items.length in paths; got: ${JSON.stringify(paths)}`)
  })

  test('changedPaths does not fire .length when length is unchanged', ({ assert }) => {
    const s = new Streamo()
    const addrA = s.set({ items: [1, 2, 3] })
    const addrB = s.set({ items: [1, 2, 99] })  // index 2 changed; length same
    const paths = [...changedPaths(s, addrA, addrB)].map(p => p.join('.'))
    assert.ok(!paths.includes('items.length'),
      `did not expect items.length; got: ${JSON.stringify(paths)}`)
    assert.ok(paths.includes('items.2'),
      `expected items.2 (the changed index); got: ${JSON.stringify(paths)}`)
  })

  test('asRefs cannot mutate the streamo (math-impossible by construction)', async ({ assert }) => {
    // Earlier versions of asRefs would silently call r.append for inline
    // multi-byte children that didn't have their own chunk address yet —
    // a write triggered by a read. CodecRegistry now dispatches asRefs
    // through a separate `#readOnlyR` interface that has no `append`;
    // getPartAddress in codecs.js checks `if (!r.append) return
    // undefined` and yields rather than mutating. Mutation is removed
    // from the call graph by construction, not by caller discipline.

    const author = new Streamo()
    author.set({ a: 1, b: 'hi', c: [1, 2, 3], d: new Uint8Array([42]) })
    const expectedLen = author.byteLength

    // Receive author's bytes raw via makeWritableStream — so the peer's
    // streamo is built *only* from incoming chunks, with no internal
    // set() calls on the peer side that would have pre-materialized
    // anything.
    const peer = new Streamo()
    const writer = peer.makeWritableStream().getWriter()
    const reader = author.makeReadableStream().getReader()
    while (peer.byteLength < expectedLen) {
      const { value, done } = await reader.read()
      if (done) break
      await writer.write(value)
    }
    assert.equal(peer.byteLength, expectedLen, 'peer received all author bytes')

    // Walk every navigable address from the top, calling asRefs everywhere.
    // None of these calls is allowed to grow the peer's stream.
    const before = peer.byteLength
    function walk (addr, seen = new Set()) {
      if (typeof addr !== 'number' || addr < 0 || seen.has(addr)) return
      seen.add(addr)
      const refs = peer.asRefs(addr)
      if (refs && typeof refs === 'object') {
        const vals = Array.isArray(refs) ? refs : Object.values(refs)
        for (const v of vals) walk(v, seen)
      }
    }
    walk(peer.valueAddress)
    assert.equal(peer.byteLength, before, 'asRefs walk must not change byteLength on the peer')
  })

  test('sign covers the FULL pre-signature byte range — no off-by-one', async ({ assert }) => {
    // Earlier versions sliced (signedLength, before - 1), dropping the footer
    // byte of the last pre-sig chunk from coverage. Both sign and verify used
    // the same broken slice so signatures still validated, but a flipped
    // footer byte at that index wouldn't be caught.
    //
    // This test proves coverage spans [signedLength, before): we independently
    // sign the full byte range (using the same Signer, which uses RFC 6979
    // deterministic ECDSA via noble-secp256k1) and compare bytes. If sign
    // covered fewer bytes, the signatures would differ.
    const s = new Streamo()
    const signer = new Signer('alice', 'hunter2', 1)
    s.set({ msg: 'hello, world' })
    const before = s.byteLength
    const sig = await s.sign(signer, 'test')

    const fullRangeBytes = s.slice(0, before)
    const expectedSig = await signer.sign('test', fullRangeBytes)
    assert.deepEqual([...sig.compactRawBytes], [...expectedSig],
      'streamo signature must equal a fresh sig over [0, before) — covering every pre-sig byte')

    // And verify must round-trip cleanly under the new slice.
    const { publicKey } = await signer.keysFor('test')
    assert.ok(await s.verify(sig, publicKey), 'verify must accept sign\'s output')
  })

  test('signedLength advances when sig chunks are appended via load (not just sign)', async ({ assert }) => {
    // Before this fix, loading a streamo from bytes left signedLength=0 even
    // though the loaded data already contained signatures. The next sign()
    // would then re-sign all of history with signedFrom=0 — wasteful and
    // visually random in the explorer ("why does every sig start at 0?").
    const signer = new Signer('alice', 'secret')
    const name = 'load-resumes-signed-cursor'
    const keys = await signer.keysFor(name)

    const original = new Streamo()
    original.set({ a: 1 })
    await original.sign(signer, name)
    const cursorAfterFirstSig = original.signedLength
    original.set('a', 2)
    await original.sign(signer, name)
    assert.ok(original.signedLength > cursorAfterFirstSig, 'sanity: cursor advances within one session')

    // Replay the bytes into a fresh Streamo via the public writable stream —
    // mirrors how archiveSync/registrySync deliver data on load.
    const replay = new Streamo()
    const writer = replay.makeVerifiedWritableStream(keys.publicKey).getWriter()
    const bytes = original.slice(0, original.byteLength)
    const framed = new Uint8Array(4 + bytes.length)
    new DataView(framed.buffer).setUint32(0, bytes.length, true)
    framed.set(bytes, 4)
    // Reframe per chunk — makeVerifiedWritableStream parses one frame at a
    // time. Walk chunks from the source to drive the loader correctly.
    let addr = original.byteLength - 1
    const chunks = []
    while (addr >= 0) {
      const code = original.resolve(addr)
      chunks.unshift(code)
      addr -= code.length
    }
    for (const code of chunks) {
      const frame = new Uint8Array(4 + code.length)
      new DataView(frame.buffer).setUint32(0, code.length, true)
      frame.set(code, 4)
      await writer.write(frame)
    }
    await writer.close()

    assert.equal(replay.signedLength, original.signedLength,
      'signedLength must be reconstructed from the loaded sig chunks')
  })
})
