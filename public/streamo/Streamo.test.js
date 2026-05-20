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
      new Signature(new Uint8Array(32), new Uint8Array(64))
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

  test('sign commits to the full chain — every appended chunk covered', async ({ assert }) => {
    // Under the chain-hash scheme each non-sig chunk folds into a running
    // accumulator as `acc' = sha256(acc || sha256(chunk))`, and the SIG
    // chunk carries that accumulator + a signature over it. This test
    // independently reconstructs the accumulator chunk-by-chunk and
    // proves the SIG signs exactly that 32-byte commitment.
    const s = new Streamo()
    const signer = new Signer('alice', 'hunter2', 1)
    s.set({ msg: 'hello, world' })
    const beforeSig = s.byteLength
    const sig = await s.sign(signer, 'test')

    // Walk every chunk we just wrote and fold the accumulator manually.
    const cryptoSubtle = (await import('crypto')).webcrypto.subtle
    const sha = async b => new Uint8Array(await cryptoSubtle.digest('SHA-256', b))
    const chunks = []
    let addr = beforeSig - 1
    while (addr >= 0) { const c = s.resolve(addr); chunks.unshift(c); addr -= c.length }
    let expectedAcc = new Uint8Array(32)
    for (const c of chunks) {
      const combined = new Uint8Array(64)
      combined.set(expectedAcc, 0); combined.set(await sha(c), 32)
      expectedAcc = await sha(combined)
    }
    assert.deepEqual([...sig.accumulator], [...expectedAcc],
      'sig.accumulator must equal independently-folded chain over every pre-sig chunk')

    // Verify must accept the sig.
    const { publicKey } = await signer.keysFor('test')
    assert.ok(await s.verify(sig, publicKey), 'verify must accept sign\'s output')
  })

  test('makeVerifiedWritableStream rejects bytes not covered by a valid SIG', async ({ assert }) => {
    // The historical attack: a peer sends [commit_chunk, bad_sig]. The
    // commit lands in the store before the sig fails verification. With
    // staging, the commit never lands — verified write is all-or-nothing.
    const author = new Streamo()
    const signer = new Signer('alice', 'hunter2', 1)
    author.set({ a: 1 })
    await author.sign(signer, 'attack-test')
    const { publicKey } = await signer.keysFor('attack-test')

    // Get the chunks the author wrote
    const chunks = []
    let addr = author.byteLength - 1
    while (addr >= 0) { const c = author.resolve(addr); chunks.unshift(c); addr -= c.length }

    // Corrupt the SIG's signature bytes (offset 32..96 inside the 97-byte chunk)
    const sigChunk = chunks[chunks.length - 1]
    const badSig = new Uint8Array(sigChunk)
    badSig[40] ^= 0xff // flip a byte inside the signature region

    const peer = new Streamo()
    const writer = peer.makeVerifiedWritableStream(publicKey).getWriter()
    let caught = null
    try {
      for (const code of chunks.slice(0, -1)) {
        const frame = new Uint8Array(4 + code.length)
        new DataView(frame.buffer).setUint32(0, code.length, true)
        frame.set(code, 4)
        await writer.write(frame)
      }
      const badFrame = new Uint8Array(4 + badSig.length)
      new DataView(badFrame.buffer).setUint32(0, badSig.length, true)
      badFrame.set(badSig, 4)
      await writer.write(badFrame)
    } catch (e) { caught = e }
    assert.ok(caught, 'verified stream must reject a bad sig')
    assert.equal(peer.byteLength, 0,
      'no bytes may land in the peer store when the covering sig fails verification')
  })

  test('makeVerifiedWritableStream detects a fork between two devices using the same signer', async ({ assert }) => {
    // The multi-device fork: same identity (one signer), two devices write
    // divergent commits independently. Each device's stream is internally
    // self-consistent and crypto-valid — the fork is only visible when both
    // streams meet at a third peer. The verifier-gate catches it: device 2's
    // SIG carries an accumulator computed from device 2's chain (starting
    // from genesis through device 2's content only), which cannot equal the
    // verifier's pendingAcc after it has already folded device 1's divergent
    // chunks. This is the byte-stream signal that a fork has occurred.
    const signer = new Signer('alice', 'hunter2', 1)
    const name = 'fork'
    const { publicKey } = await signer.keysFor(name)

    const device1 = new Streamo()
    device1.set({ v: 'apple' })
    await device1.sign(signer, name)

    const device2 = new Streamo()
    device2.set({ v: 'banana' })
    await device2.sign(signer, name)

    const readChunks = s => {
      const out = []
      let addr = s.byteLength - 1
      while (addr >= 0) { const c = s.resolve(addr); out.unshift(c); addr -= c.length }
      return out
    }
    const frame = code => {
      const f = new Uint8Array(4 + code.length)
      new DataView(f.buffer).setUint32(0, code.length, true)
      f.set(code, 4)
      return f
    }

    const target = new Streamo()
    const writer = target.makeVerifiedWritableStream(publicKey).getWriter()

    // Device 1's full stream lands cleanly — its sig matches its own chain.
    for (const c of readChunks(device1)) await writer.write(frame(c))
    const tipAfterDevice1 = target.byteLength
    assert.ok(tipAfterDevice1 > 0, 'sanity: device 1 actually wrote bytes')

    // Now device 2's stream arrives. Its sig will carry an accumulator that
    // was computed independently — pendingAcc has device 1's chunks folded
    // into it, so the mismatch fires before any of device 2's bytes commit.
    let caught = null
    try {
      for (const c of readChunks(device2)) await writer.write(frame(c))
    } catch (e) { caught = e }

    assert.ok(caught, 'merging a divergent fork must throw at the verifying writer')
    assert.ok(/accumulator/i.test(caught.message),
      `error should name the accumulator chain mismatch (Streamo.js:512); got: ${caught.message}`)
    assert.equal(target.byteLength, tipAfterDevice1,
      'staging discards the rejected batch — no fork bytes land in the target')
    assert.equal(target.forkDetected, true,
      'forkDetected must be raised so watchers can see the fork even when the throw kills the connection')
    assert.equal(target.verificationFailed, false,
      'verificationFailed should stay false — the signature itself was crypto-valid; the chain mismatch is what failed')
  })

  test('forkDetected fires reactively — watchers see the fork before/without catching the throw', async ({ assert }) => {
    // The whole point of the flag: app code that holds a Repo doesn't have
    // to wrap every writer.write() in a try/catch. It just watches forkDetected
    // and reacts. This test proves the recaller actually fires for that path.
    const signer = new Signer('alice', 'hunter2', 1)
    const name = 'fork-reactive'
    const { publicKey } = await signer.keysFor(name)

    const device1 = new Streamo()
    device1.set({ v: 1 })
    await device1.sign(signer, name)
    const device2 = new Streamo()
    device2.set({ v: 2 })
    await device2.sign(signer, name)

    const readChunks = s => {
      const out = []
      let addr = s.byteLength - 1
      while (addr >= 0) { const c = s.resolve(addr); out.unshift(c); addr -= c.length }
      return out
    }
    const frame = code => {
      const f = new Uint8Array(4 + code.length)
      new DataView(f.buffer).setUint32(0, code.length, true)
      f.set(code, 4)
      return f
    }

    const target = new Streamo()
    let observed = []
    target.recaller.watch('fork-watcher', () => observed.push(target.forkDetected))

    const writer = target.makeVerifiedWritableStream(publicKey).getWriter()
    for (const c of readChunks(device1)) await writer.write(frame(c))
    // device1 stream is clean — no fork yet.
    assert.equal(target.forkDetected, false, 'no fork until divergent chain arrives')

    // Now device2's stream — the throw will fire AND the flag will fire.
    try { for (const c of readChunks(device2)) await writer.write(frame(c)) } catch {}

    // Allow the recaller's microtask flush to land
    await new Promise(r => setTimeout(r, 0))
    assert.ok(observed.includes(true),
      `fork-watcher must observe forkDetected becoming true; observed: ${JSON.stringify(observed)}`)
  })

  test('verificationFailed fires when a bad sig arrives — separate flag from forkDetected', async ({ assert }) => {
    // Bad sig is a different threat from a fork: the signer didn't actually
    // sign these bytes (or the bytes got corrupted in transit). The chain
    // would have to match for the crypto check to fire — so we craft a stream
    // where the accumulator IS valid but the signature bytes are tampered.
    const author = new Streamo()
    const signer = new Signer('alice', 'hunter2', 1)
    author.set({ a: 1 })
    await author.sign(signer, 'badsig-test')
    const { publicKey } = await signer.keysFor('badsig-test')

    const chunks = []
    let addr = author.byteLength - 1
    while (addr >= 0) { const c = author.resolve(addr); chunks.unshift(c); addr -= c.length }
    const sigChunk = chunks[chunks.length - 1]
    const badSig = new Uint8Array(sigChunk)
    badSig[40] ^= 0xff // flip a byte inside the signature region (offset 32..96)

    const peer = new Streamo()
    const writer = peer.makeVerifiedWritableStream(publicKey).getWriter()
    let caught = null
    try {
      for (const code of chunks.slice(0, -1)) {
        const frame = new Uint8Array(4 + code.length)
        new DataView(frame.buffer).setUint32(0, code.length, true)
        frame.set(code, 4)
        await writer.write(frame)
      }
      const badFrame = new Uint8Array(4 + badSig.length)
      new DataView(badFrame.buffer).setUint32(0, badSig.length, true)
      badFrame.set(badSig, 4)
      await writer.write(badFrame)
    } catch (e) { caught = e }

    assert.ok(caught, 'corrupted signature must still throw')
    assert.equal(peer.verificationFailed, true,
      'verificationFailed must be raised for the crypto-verify path')
    assert.equal(peer.forkDetected, false,
      'forkDetected stays false — the accumulator matched; only the signature bytes were bad')
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
