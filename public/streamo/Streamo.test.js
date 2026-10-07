import { describe } from './utils/testing.js'
import { Opaque } from './Opaque.js'
import { Streamo, changedPaths } from './Streamo.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
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
      new Signature(new Uint8Array(32), new Uint8Array(64))
    ]
    for (const value of values) {
      const decoded = s.decode(s.encode(value))
      assert.deepEqual(decoded, value, `round-trips ${Object.prototype.toString.call(value)}`)
    }
  })

  test('single-element and sparse arrays survive asRefs, get(path) and set(path)', ({ assert }) => {
    // REGRESSION, found 2026-10-07 and present since at least 6652913.
    // ARRAY has two representations: a dense multi-element array is a Duple
    // tree of VALUES, where asRefs 'all' (an address for both Duple slots) is
    // right. A single-element or sparse array is encoded as an OBJECT
    // ({...v, length}), where a Duple's slot 0 is a NAME — so 'all' handed
    // back the ADDRESS OF THE NAME STRING, and ARRAY.decode's
    // Object.assign([], inner) read that address as an index.
    //
    // asRefs([7]) came back as { addr("length"): addr(1), addr("0"): addr(7) }
    // coerced to an array of length 24. get('list','0') was undefined, and
    // set('list','0',42) wrote that shape back as the record:
    //   {"list":[42,null, ...45 entries... ],"other":"x"}
    // Full get() was always correct, so only path reads and writes bit — which
    // is what kept it quiet.
    const s = new Streamo()
    s.set({ list: [7], other: 'x' })

    const refs = s.getRefs('list')
    assert.equal(refs.length, 1, `refs for a 1-element array has one entry, got ${JSON.stringify(refs)}`)
    assert.equal(typeof refs[0], 'number', 'and that entry is an address')
    assert.equal(s.decode(refs[0]), 7, 'which resolves to the element')

    assert.equal(s.get('list', '0'), 7, 'get(path) reaches into a 1-element array')

    s.set('list', '0', 42)
    assert.deepEqual(s.get(), { list: [42], other: 'x' }, 'set(path) does not reshape the record')

    // Sparse arrays take the same representation, so they take the same path.
    const sp = new Streamo()
    sp.set({ list: [1, undefined, 3] })
    assert.equal(sp.get('list', '2'), 3, 'get(path) into a sparse array')
    sp.set('list', '0', 9)
    assert.deepEqual(sp.get('list'), [9, undefined, 3], 'set(path) preserves the holes and the length')

    // And growing a 1-element array past its representation boundary.
    const g = new Streamo()
    g.set({ list: [7] })
    g.set('list', '1', 8)
    assert.deepEqual(g.get('list'), [7, 8], '1-element array grows into the dense representation')
  })

  test('deduplication: same value always gets the same address', ({ assert }) => {
    const s = new Streamo()
    const a1 = s.encode(42)
    s.encode({ x: 42 })
    const code42 = s.resolve(s.encode(42))
    assert.equal(s.addressOf(code42), a1, 'second encode of 42 reuses the existing address')
  })

  test('set returns dedup address (and valueAddress reflects it) when encoded value already exists', ({ assert }) => {
    // Regression: a set whose encoded outermost subcode already exists in the
    // content map (toggling back to a state that's been seen before) must
    // return the existing address AND make valueAddress point at it. Pre-fix,
    // set returned byteLength-1 (= the unchanged tail) and a subsequent read
    // would see the OLD value, not the just-set one. This broke todomvc toggle.
    const s = new Streamo()
    const valueA = { todos: [{ id: 1, done: true }] }
    const valueB = { todos: [{ id: 1, done: false }] }

    // First, store both values so the content map knows about them.
    const addrA = s.set(valueA)
    assert.deepEqual(s.get(), valueA, 'after set(A): get returns A')
    assert.equal(s.valueAddress, addrA, 'valueAddress = addrA')

    const addrB = s.set(valueB)
    assert.deepEqual(s.get(), valueB, 'after set(B): get returns B')
    assert.equal(s.valueAddress, addrB, 'valueAddress = addrB')
    assert.notEqual(addrA, addrB, 'A and B have distinct addresses')

    // Now toggle BACK to A. The encoded outermost already exists at addrA.
    // byteLength-1 would point at B's tail; only addrA is the right answer.
    const addrA2 = s.set(valueA)
    assert.equal(addrA2, addrA, 'set(A) the second time returns the existing addrA')
    assert.equal(s.valueAddress, addrA, 'valueAddress is now addrA, not byteLength-1')
    assert.deepEqual(s.get(), valueA, 'get returns A — not the stale B at byteLength-1')

    // And toggle back to B one more time for good measure.
    const addrB2 = s.set(valueB)
    assert.equal(addrB2, addrB, 'set(B) again returns the existing addrB')
    assert.deepEqual(s.get(), valueB, 'get returns B after the second-toggle')
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
    const code = s.resolve(s.encode({ a: 1 }))

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
    const code = s.resolve(s.encode(refs, true))
    assert.deepEqual(s.decode(code), { a: 1, b: 'hello' })
  })

  test('encode(asRefs(addr), true) round-trips an array', ({ assert }) => {
    const s = new Streamo()
    s.set([10, 20, 30])
    const addr = s.byteLength - 1
    const refs = s.asRefs(addr)
    const code = s.resolve(s.encode(refs, true))
    assert.deepEqual(s.decode(code), [10, 20, 30])
  })

  test('encode(asRefs(addr), true) round-trips a primitive', ({ assert }) => {
    const s = new Streamo()
    s.set('hello')
    const addr = s.byteLength - 1
    const refs = s.asRefs(addr)  // returns addr itself for non-objects
    const code = s.resolve(s.encode(refs, true))  // resolves addr → string code
    assert.equal(s.decode(code), 'hello')
  })

  test('get(...path) descends lazily — agrees with full-decode walk across mixed shapes, array indices + nested primitives', ({ assert }) => {
    const s = new Streamo()
    // A shape that exercises:
    //   - Large addressed children (files map with sizable values)
    //   - Small children (mounts entry)
    //   - Arrays of mixed primitives + objects (journalists)
    //   - Nested primitives reached via path (UINT7 / strings / booleans)
    const value = {
      files: {
        'a.txt': 'unique-a-' + 'x'.repeat(200),
        'b.txt': 'unique-b-' + 'y'.repeat(200),
      },
      mounts: { 'streamo/': { key: 'a'.repeat(66) } },
      journalists: ['alice', 'bob', { name: 'carol', active: true }],
      counters: { hits: 42, misses: 7 },
      tagline: 'hello',
    }
    s.set(value)
    // For every path the existing get used to walk, the new lazy get must
    // return the same JS value. Whole tree, deep file leaf, small mount
    // leaf, array index, nested object inside array, primitive at depth.
    const paths = [
      [],
      ['files'],
      ['files', 'a.txt'],
      ['files', 'b.txt'],
      ['mounts'],
      ['mounts', 'streamo/'],
      ['mounts', 'streamo/', 'key'],
      ['journalists'],
      ['journalists', 0],
      ['journalists', 2],
      ['journalists', 2, 'name'],
      ['journalists', 2, 'active'],
      ['counters', 'hits'],
      ['counters', 'misses'],
      ['tagline'],
      ['nope'],                                 // missing key → undefined
      ['files', 'nope.txt'],                    // missing nested key
      ['journalists', 99],                      // out-of-range array index
      ['tagline', 'sub'],                       // descending into a primitive
    ]
    for (const path of paths) {
      const expected = path.reduce((v, k) => (v == null ? undefined : v[k]), value)
      assert.deepEqual(s.get(...path), expected, 'path: ' + JSON.stringify(path))
    }
  })

  test('sign and verify', async ({ assert }) => {
    const s = new WritableStreamoRecord()
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

  test('clone snapshots state at a given address', ({ assert }) => {
    const s = new Streamo()
    s.set({ v: 1 })
    const addr1 = s.byteLength - 1
    s.set({ v: 2 })

    const snap = s.clone(addr1)
    assert.equal(snap.get('v'), 1, 'clone reflects state at snapshot address')
    assert.equal(s.get('v'), 2, 'original still reflects latest state')
  })

  test('clone preserves subclass identity (new this.constructor)', ({ assert }) => {
    // clone honors its name — the returned instance is the same subclass
    // as the receiver, not a downcast to Streamo. Historical note:
    // Streamo.clone once hard-coded `new Streamo(...)` to accidentally
    // serve WritableStreamoRecord.checkout's need for a base-Streamo
    // scratch; checkout now handles that need explicitly (via _applyClone
    // into a fresh Streamo), freeing clone to be honest.
    class SubStreamo extends Streamo {}
    const s = new SubStreamo()
    s.set({ v: 1 })
    const addr = s.byteLength - 1
    const snap = s.clone(addr)
    assert.ok(snap instanceof SubStreamo, 'clone returns the subclass')
    assert.ok(snap instanceof Streamo, 'clone is still a Streamo')
    assert.equal(snap.get('v'), 1, 'clone snapshots state correctly')
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

  test('asRefs cannot mutate the streamo (nothing to materialize by construction)', async ({ assert }) => {
    // asRefs hands back an address for every child, so it never has to store
    // anything in order to answer. That is the property under test.
    //
    // The history explains the shape of the test. asRefs used to call r.append
    // for inline multi-byte children with no chunk address yet — a write
    // triggered by a read. The fix then was a second `r` without `append`, so
    // the call graph could not reach a store mutation. The fix now is that
    // there are no inline parts: every part is an address, so there is nothing
    // left to materialize. Both the read-only `r` and the inline part option
    // are gone (2026-10-05/06).
    //
    // THE PAD no longer changes which path is taken — nothing inlines at any
    // store size — but it stays, for a different reason: past ~16K an address
    // costs 2-3 bytes, so the parts below encode as option 1-2 instead of
    // option 0. It is the only coverage we have of multi-byte part addresses.
    //
    // It was load-bearing once, and that is the lesson worth keeping: without
    // it, this test asserted nothing for months. A part inlined only when its
    // code was no longer than an address, so in a small store (1-byte
    // addresses) only 1-byte codes inlined — and those took a virtual-address
    // path that returned before the guard the test existed to protect. Three
    // preconditions had to hold at once to reach it.
    const author = new Streamo()
    // TWO set() calls, still deliberate: a part's address width comes from the
    // store size at the moment that part is encoded, so inside a single set()
    // the small values would be encoded before the pad, while addresses still
    // cost one byte. Pad first, then add the candidates against a large store.
    author.set({ pad: new Opaque(new Uint8Array(1 << 16)), a: 1, b: 'hi', c: [1, 2, 3], d: new Uint8Array([42]) })
    // Byte values chosen NOT to collide with anything already here, so dedup
    // doesn't hand back an existing chunk's address: [7] or 'a' would reuse a
    // chunk that [1, 2, 3] already made.
    author.set({ ...author.get(), small1: new Uint8Array([211]), small2: new Uint8Array([212, 213]), smallStr: 'q' })
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

    // POLICY ASSERTION, flipped 2026-10-05 when encode-side inlining was
    // disabled and kept when the inline part option was removed entirely.
    // It used to require at least one part with NO address, to prove the walk
    // reached the read-only guard. That precondition is unsatisfiable now, so
    // the same three sensitive values are kept as a tripwire pointing the
    // other way: if an inline part option ever comes back, these stop being
    // addressed and this fails.
    const smallRefs = ['small1', 'small2', 'smallStr'].map(k => peer.getRefs(k))
    assert.ok(smallRefs.every(r => typeof r === 'number'),
      `every part is addressed — got ${JSON.stringify(smallRefs)}`)
    assert.equal(peer.byteLength, before, 'and reading those refs did not append either')
  })

  test('sign commits to the full chain — every appended byte covered', async ({ assert }) => {
    // The chain-hash formula:
    //   chainHash = sha256(prevChainHash || sha256(newBytes))
    // Two sha256 calls per sig regardless of chunk count. This test
    // independently reconstructs the chainHash and proves the SIG signs
    // exactly that 32-byte commitment.
    const s = new WritableStreamoRecord()
    const signer = new Signer('alice', 'hunter2', 1)
    s.set({ msg: 'hello, world' })
    const beforeSig = s.byteLength
    const sig = await s.sign(signer, 'test')

    const cryptoSubtle = (await import('crypto')).webcrypto.subtle
    const sha = async b => new Uint8Array(await cryptoSubtle.digest('SHA-256', b))
    // All bytes signed by this first sig = bytes 0..beforeSig.
    const newBytes = s.slice(0, beforeSig)
    const newBytesHash = await sha(newBytes)
    const combined = new Uint8Array(64)
    combined.set(new Uint8Array(32), 0)   // prev = 32 zeros (first sig)
    combined.set(newBytesHash, 32)
    const expectedChainHash = await sha(combined)
    assert.deepEqual([...sig.chainHash], [...expectedChainHash],
      'sig.chainHash must equal sha256(prevChainHash || sha256(newBytes))')

    // Verify must accept the sig.
    const { publicKey } = await signer.keysFor('test')
    assert.ok(await s.verify(sig, publicKey), 'verify must accept sign\'s output')
  })

  // 'makeRelayInboundStream: alignment check catches the push-in-flight
  // race' was deleted 2026-08-01 with the code it tested. Its successor is
  // registrySync.test.js's 'subscriber: incoming bytes that diverge from
  // local archive surface mirror.divergence' — same scenario, asserted on
  // the cell that now carries it.
  test('makeReadableStream({ fromOffset }) skips bytes the receiver already has + batches ready chunks', async ({ assert }) => {
    // The wire-protocol cleanup lets the receiver carry its signedLength in
    // the subscribe handshake; the sender starts from there rather than from
    // byte 0. Each emitted frame may bundle multiple length-prefixed chunks
    // (batching is a perf optimization — streamo fragments into many tiny
    // chunks and one-WS-message-per-chunk explodes the event loop).
    const signer = new Signer('alice', 'hunter2', 1)
    const name = 'from-offset-reader'
    const { publicKey: _ } = await signer.keysFor(name)

    const repo = new WritableStreamoRecord()
    repo.set({ v: 'one' })
    await repo.sign(signer, name)
    const offsetAfterFirstSig = repo.signedLength
    repo.set({ v: 'two' })
    await repo.sign(signer, name)
    const totalBytes = repo.byteLength

    // Sum chunk-content bytes across all batched frames.
    const sumChunkBytes = async (reader, expectedBytes) => {
      let sum = 0
      let frames = 0
      let chunks = 0
      while (sum < expectedBytes) {
        const { value, done } = await reader.read()
        if (done) break
        frames++
        let pos = 0
        while (pos < value.length) {
          const len = new DataView(value.buffer, value.byteOffset + pos, 4).getUint32(0, true)
          sum += len
          chunks++
          pos += 4 + len
        }
      }
      return { sum, frames, chunks }
    }

    // From-0 reader covers the whole repo.
    const r0 = repo.makeReadableStream({ fromOffset: 0 }).getReader()
    const r0result = await sumChunkBytes(r0, totalBytes)
    r0.cancel()
    assert.equal(r0result.sum, totalBytes, 'from-0 reader covers everything')

    // Batching: when chunks are all ready at stream start, they bundle into
    // far fewer frames than chunks. Concrete bound: at least 2 chunks per
    // frame on average for a populated repo.
    assert.ok(r0result.chunks > r0result.frames * 2,
      `batched: ${r0result.chunks} chunks in ${r0result.frames} frame(s)`)

    // From-after-first-sig reader skips the first commit's worth of bytes.
    const r1 = repo.makeReadableStream({ fromOffset: offsetAfterFirstSig }).getReader()
    const r1result = await sumChunkBytes(r1, totalBytes - offsetAfterFirstSig)
    r1.cancel()
    assert.equal(r1result.sum, totalBytes - offsetAfterFirstSig,
      'from-offset reader emits only the post-offset bytes')
  })

  test('signedLength is derived from the bytes — survives load via the unverified writer (archive replay)', async ({ assert }) => {
    // Production archive load uses makeWritableStream (trusted bytes from
    // disk), not the relay-inbound path. After load, signedLength should
    // reflect the most recent SIG chunk — it's a dynamic getter that walks
    // back through the bytes, so this just confirms the walking works
    // after a bulk replay.
    const signer = new Signer('alice', 'secret')
    const name = 'load-derives-signedLength'

    const original = new WritableStreamoRecord()
    original.set({ a: 1 })
    await original.sign(signer, name)
    const cursorAfterFirstSig = original.signedLength
    original.set('a', 2)
    await original.sign(signer, name)
    assert.ok(original.signedLength > cursorAfterFirstSig, 'sanity: cursor advances within one session')

    // Replay all bytes into a fresh StreamoRecord via the unverified makeWritableStream
    // (the path archiveSync uses on startup).
    const replay = new WritableStreamoRecord()
    const writer = replay.makeWritableStream().getWriter()
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
      'signedLength is derived correctly from loaded sig chunks')
  })
})
