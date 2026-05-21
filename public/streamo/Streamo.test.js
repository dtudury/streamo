import { describe } from './utils/testing.js'
import { Streamo, changedPaths } from './Streamo.js'
import { Repo } from './Repo.js'
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
    const s = new Repo()
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

  test('sign commits to the full chain — every appended byte covered', async ({ assert }) => {
    // The chain-hash formula:
    //   chainHash = sha256(prevChainHash || sha256(newBytes))
    // Two sha256 calls per sig regardless of chunk count. This test
    // independently reconstructs the chainHash and proves the SIG signs
    // exactly that 32-byte commitment.
    const s = new Repo()
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

  test('makeRelayInboundStream: alignment check catches the push-in-flight race', async ({ assert }) => {
    // The client-side receive path: "what comes down is always from the
    // top, always correct" — no chain or crypto check (relay validated),
    // but the alignment check stays. It fires when the client has local
    // content past the last shared sig (typically: a push in flight,
    // unaccepted by the relay yet) and incoming relay bytes would land
    // past that local content with their refs pointing at positions the
    // local content occupies → would corrupt decodes.

    const signer = new Signer('alice', 'hunter2', 1)
    const name = 'inbound-alignment'
    const { publicKey: _ } = await signer.keysFor(name)

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

    // Set up a "shared" history: both sides agree on this prefix.
    const shared = new Repo()
    shared.set({ v: 'one' })
    await shared.sign(signer, name)
    const sharedChunks = readChunks(shared)

    // Client: has shared + local-pending (banana, signed locally, not yet
    // accepted by any relay)
    const client = new Repo()
    const inA = client.makeRelayInboundStream().getWriter()
    for (const c of sharedChunks) await inA.write(frame(c))
    client.set({ v: 'banana' })
    await client.sign(signer, name)
    const clientByteLengthBeforeMerge = client.byteLength

    // "Relay" view: extends the SAME shared base with cherry (a divergent
    // commit). To make the base truly shared at the byte level (commit
    // chunks include a date; reconstructing via set() would produce
    // different bytes), copy shared's actual chunks into the relay via the
    // unverified writer, then extend with cherry on top.
    const relay = new Repo()
    const relayLoader = relay.makeWritableStream().getWriter()
    for (const c of sharedChunks) await relayLoader.write(frame(c))
    relay.set({ v: 'cherry' })
    await relay.sign(signer, name)

    // New writer (the "second connection" simulating reconnect / new sync)
    const inB = client.makeRelayInboundStream().getWriter()
    let caught = null
    try {
      for (const c of readChunks(relay)) await inB.write(frame(c))
    } catch (e) { caught = e }

    assert.ok(caught, 'alignment failure must throw')
    assert.equal(client.conflictDetected, true, 'conflictDetected flag fires')
    assert.equal(client.byteLength, clientByteLengthBeforeMerge,
      'no remote chunks land — local store stays decode-safe')
    assert.equal(client.get('v'), 'banana', 'client can still read its local-pending value')
  })

  test('makeReadableStream({ fromOffset }) skips bytes the receiver already has', async ({ assert }) => {
    // The wire-protocol cleanup lets the receiver carry its signedLength in
    // the subscribe handshake; the sender starts from there rather than from
    // byte 0. Verifies the source-side mechanic: a reader with fromOffset = N
    // emits only chunks whose offset is >= N.
    const signer = new Signer('alice', 'hunter2', 1)
    const name = 'from-offset-reader'
    const { publicKey: _ } = await signer.keysFor(name)

    const repo = new Repo()
    repo.set({ v: 'one' })
    await repo.sign(signer, name)
    const offsetAfterFirstSig = repo.signedLength
    repo.set({ v: 'two' })
    await repo.sign(signer, name)
    const totalBytes = repo.byteLength

    // From-0 reader emits all chunks; total bytes equal repo.byteLength.
    let fromZero = 0
    const r0 = repo.makeReadableStream({ fromOffset: 0 }).getReader()
    while (fromZero < totalBytes) {
      const { value, done } = await r0.read()
      if (done) break
      // Wire format is [4-byte length][chunk bytes] — the chunk's length
      // (not including the prefix) advances the byte cursor.
      fromZero += value.length - 4
    }
    assert.equal(fromZero, totalBytes, 'from-0 reader covers everything')
    r0.cancel()

    // From-after-first-sig reader skips the first commit's worth of bytes.
    let fromAfterFirst = 0
    const r1 = repo.makeReadableStream({ fromOffset: offsetAfterFirstSig }).getReader()
    while (fromAfterFirst < totalBytes - offsetAfterFirstSig) {
      const { value, done } = await r1.read()
      if (done) break
      fromAfterFirst += value.length - 4
    }
    assert.equal(fromAfterFirst, totalBytes - offsetAfterFirstSig,
      'from-offset reader emits only the post-offset bytes')
    r1.cancel()
  })

  test('signedLength is derived from the bytes — survives load via the unverified writer (archive replay)', async ({ assert }) => {
    // Production archive load uses makeWritableStream (trusted bytes from
    // disk), not the relay-inbound path. After load, signedLength should
    // reflect the most recent SIG chunk — it's a dynamic getter that walks
    // back through the bytes, so this just confirms the walking works
    // after a bulk replay.
    const signer = new Signer('alice', 'secret')
    const name = 'load-derives-signedLength'

    const original = new Repo()
    original.set({ a: 1 })
    await original.sign(signer, name)
    const cursorAfterFirstSig = original.signedLength
    original.set('a', 2)
    await original.sign(signer, name)
    assert.ok(original.signedLength > cursorAfterFirstSig, 'sanity: cursor advances within one session')

    // Replay all bytes into a fresh Repo via the unverified makeWritableStream
    // (the path archiveSync uses on startup).
    const replay = new Repo()
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
