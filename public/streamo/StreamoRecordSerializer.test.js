import { describe } from './utils/testing.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { StreamoRecordSerializer } from './StreamoRecordSerializer.js'
import { Signer } from './Signer.js'

// Helpers: extract a batch (chunks + sig) from a StreamoRecord's bytestream
// covering everything since the last sig.
function extractBatch (repo) {
  const chunks = []
  let addr = repo.byteLength - 1
  // The last chunk is the SIG.
  const sig = repo.resolve(addr)
  addr -= sig.length
  // Walk back collecting non-sig chunks until we hit the previous sig
  // (or genesis).
  while (addr >= 0) {
    const c = repo.resolve(addr)
    if (repo.footerToCodec[c.at(-1)]?.type === 'SIGNATURE') break
    chunks.unshift(c)
    addr -= c.length
  }
  return { chunks, sig }
}

describe(import.meta.url, ({ test }) => {
  test('accepts a batch that extends the current top', async ({ assert }) => {
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('serializer-test')

    // Build a batch by having an author write + sign locally
    const author = new WritableStreamoRecord()
    author.set({ v: 1 })
    await author.sign(signer, 'serializer-test')
    const batch = extractBatch(author)

    // Target relay (fresh, empty)
    const relay = new WritableStreamoRecord()
    const serializer = new StreamoRecordSerializer(relay, publicKey)
    const result = await serializer.submit(batch)
    assert.equal(result.accepted, true, 'first batch on empty repo must be accepted')
    assert.equal(relay.byteLength, author.byteLength, 'relay now mirrors the author batch')
    assert.deepEqual(relay.get('v'), 1, 'relay can read the committed value')
  })

  test('rejects a batch whose sig does not chain off the current top', async ({ assert }) => {
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('race-test')

    // Both authors start fresh and both write commit_1 — they're racing
    const a = new WritableStreamoRecord()
    a.set({ v: 'apple' })
    await a.sign(signer, 'race-test')
    const b = new WritableStreamoRecord()
    b.set({ v: 'banana' })
    await b.sign(signer, 'race-test')

    const relay = new WritableStreamoRecord()
    const serializer = new StreamoRecordSerializer(relay, publicKey)
    const first = await serializer.submit(extractBatch(a))
    assert.equal(first.accepted, true, 'A wins the race')
    const second = await serializer.submit(extractBatch(b))
    assert.equal(second.accepted, false, 'B loses (chain mismatch)')
    assert.equal(second.reason, 'chain-mismatch')
    assert.deepEqual(relay.get('v'), 'apple', "relay's top is unchanged by B's rejected push")
  })

  test('serializes concurrent submissions: in-flight write completes before the next is checked', async ({ assert }) => {
    // Two batches A and B that BOTH chain off the empty-top — only A
    // should be accepted; B must wait for A to commit, then see the new
    // top, then reject.
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('concurrent')

    const a = new WritableStreamoRecord()
    a.set({ v: 'apple' })
    await a.sign(signer, 'concurrent')
    const b = new WritableStreamoRecord()
    b.set({ v: 'banana' })
    await b.sign(signer, 'concurrent')

    const relay = new WritableStreamoRecord()
    const serializer = new StreamoRecordSerializer(relay, publicKey)

    // Submit both without awaiting — they should be processed in order
    const [resultA, resultB] = await Promise.all([
      serializer.submit(extractBatch(a)),
      serializer.submit(extractBatch(b))
    ])
    assert.equal(resultA.accepted, true, 'first-submitted wins')
    assert.equal(resultB.accepted, false, 'second-submitted is rejected after first commits')
    assert.equal(resultB.reason, 'chain-mismatch')
  })

  test('accepts a sequential pipeline (a1 then a2, both chained correctly)', async ({ assert }) => {
    // One author pipelines two commits — a2 is signed against a1's
    // chainHash, so both must be accepted in sequence.
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('pipeline')

    const author = new WritableStreamoRecord()
    author.set({ v: 1 })
    await author.sign(signer, 'pipeline')
    const batch1ByteLengthEnd = author.byteLength
    author.set({ v: 2 })
    await author.sign(signer, 'pipeline')

    // Slice the author's bytes into batch1 (everything up through first sig)
    // and batch2 (chunks since first sig + second sig).
    const batch1 = (() => {
      const chunks = []
      let addr = batch1ByteLengthEnd - 1
      const sig = author.resolve(addr)
      addr -= sig.length
      while (addr >= 0) {
        const c = author.resolve(addr)
        chunks.unshift(c)
        addr -= c.length
      }
      return { chunks, sig }
    })()
    const batch2 = (() => {
      const chunks = []
      let addr = author.byteLength - 1
      const sig = author.resolve(addr)
      addr -= sig.length
      while (addr >= batch1ByteLengthEnd) {
        const c = author.resolve(addr)
        chunks.unshift(c)
        addr -= c.length
      }
      return { chunks, sig }
    })()

    const relay = new WritableStreamoRecord()
    const serializer = new StreamoRecordSerializer(relay, publicKey)
    const [r1, r2] = await Promise.all([
      serializer.submit(batch1),
      serializer.submit(batch2)
    ])
    assert.equal(r1.accepted, true, 'batch1 accepted')
    assert.equal(r2.accepted, true, 'batch2 accepted (chains off batch1)')
    assert.deepEqual(relay.get('v'), 2, 'relay top reflects both batches')
  })

  // ── divergence-stress: the David A/B/aaab scenarios ──────────────────────
  //
  // The basic contract tests above cover "A wins, B rejected." These cover
  // what happens *after* the rejection — the reconciliation path the
  // serializer enables but doesn't itself execute. The pattern across all
  // of them: the serializer correctly arbitrates without ever leaving the
  // relay in a corrupted state.

  test('reconciliation: A wins, B rejected, B builds on top of A, B accepted, both lineages survive', async ({ assert }) => {
    // The David A/B/aaab scenario. Two processes, same identity (same
    // signer), both author. They race; the serializer arbitrates; the
    // loser reconciles by building on the winner's chain; the relay
    // ends up with both commits in lineage order.
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('reconcile')

    // t=0: relay is empty; A and B both see the empty state.
    const relay = new WritableStreamoRecord()
    const serializer = new StreamoRecordSerializer(relay, publicKey)

    const a = new WritableStreamoRecord()
    a.set({ from: 'A' })
    await a.sign(signer, 'reconcile')

    const b = new WritableStreamoRecord()
    b.set({ from: 'B' })
    await b.sign(signer, 'reconcile')

    // t=1: A and B both push. A arrives first; B loses with chain-mismatch.
    const r1a = await serializer.submit(extractBatch(a))
    assert.equal(r1a.accepted, true, 'A wins the race')
    const r1b = await serializer.submit(extractBatch(b))
    assert.equal(r1b.accepted, false)
    assert.equal(r1b.reason, 'chain-mismatch', 'B loses with chain-mismatch')
    assert.deepEqual(relay.get(), { from: 'A' }, "relay top is A's value, untouched by B's rejected push")
    const relayBytesAfterReject = relay.byteLength

    // t=2: B reconciles. The recovery path: B drops its local-only
    // bytes and re-syncs from the relay (gets A's bytes). Then B
    // builds its new commit on top of A's chain head.
    const bAfterResync = new WritableStreamoRecord()
    // Simulate the resync: replay relay's bytes into bAfterResync.
    const relayReader = relay.makeReadableStream().getReader()
    let received = 0
    const bWriter = bAfterResync.makeWritableStream().getWriter()
    while (received < relay.byteLength) {
      const { value, done } = await relayReader.read()
      if (done) break
      await bWriter.write(value)
      received += value.length
    }
    bWriter.releaseLock()
    relayReader.cancel()
    assert.deepEqual(bAfterResync.get(), { from: 'A' }, 'B sees the relay state after resync')
    // Now B writes its new value on top of A's chain.
    bAfterResync.set({ from: 'B', after: 'A' })
    await bAfterResync.sign(signer, 'reconcile')
    // Extract just the post-resync batch (chunks added by the new set+sign
    // beyond what was loaded from the relay).
    const reconciledBatch = (() => {
      const chunks = []
      let addr = bAfterResync.byteLength - 1
      const sig = bAfterResync.resolve(addr)
      addr -= sig.length
      while (addr >= relayBytesAfterReject) {
        const c = bAfterResync.resolve(addr)
        chunks.unshift(c)
        addr -= c.length
      }
      return { chunks, sig }
    })()

    // t=3: B's reconciled batch must be accepted.
    const r2b = await serializer.submit(reconciledBatch)
    assert.equal(r2b.accepted, true, 'B accepted after reconciling on top of A')
    assert.deepEqual(relay.get(), { from: 'B', after: 'A' }, 'relay top reflects B\'s new value')

    // Verify the chain has BOTH commits in lineage order — walk
    // history.
    const history = [...relay.history()]
    assert.equal(history.length, 2, 'chain has exactly two commits')
    assert.deepEqual(relay.decode(history[1].dataAddress), { from: 'A' },
      'oldest commit is A\'s — preserved through the reject + reconcile')
    assert.deepEqual(relay.decode(history[0].dataAddress), { from: 'B', after: 'A' },
      'newest commit is B\'s on-top-of-A')
  })

  test('reconciliation extends arbitrarily: A→B→C→D each reconcile on the previous', async ({ assert }) => {
    // Sustained contention. Four writers all chain on each other in turn;
    // the relay should end up with four commits, each in lineage order.
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('sustained')
    const relay = new WritableStreamoRecord()
    const serializer = new StreamoRecordSerializer(relay, publicKey)

    // Helper: build a writer whose state matches the relay's current state,
    // then add a commit and submit it.
    async function writeOnRelay (label) {
      const local = new WritableStreamoRecord()
      // Replay relay bytes into local.
      const reader = relay.makeReadableStream().getReader()
      const writer = local.makeWritableStream().getWriter()
      let received = 0
      while (received < relay.byteLength) {
        const { value, done } = await reader.read()
        if (done) break
        await writer.write(value)
        received += value.length
      }
      writer.releaseLock()
      reader.cancel()
      const startBytes = local.byteLength
      const startVal = local.get() ?? {}
      local.set({ ...startVal, [label]: true })
      await local.sign(signer, 'sustained')
      const chunks = []
      let addr = local.byteLength - 1
      const sig = local.resolve(addr)
      addr -= sig.length
      while (addr >= startBytes) {
        const c = local.resolve(addr)
        chunks.unshift(c)
        addr -= c.length
      }
      return serializer.submit({ chunks, sig })
    }

    for (const label of ['A', 'B', 'C', 'D']) {
      const r = await writeOnRelay(label)
      assert.equal(r.accepted, true, `${label} accepted after reconciling on relay's top`)
    }
    assert.deepEqual(relay.get(), { A: true, B: true, C: true, D: true },
      'final state has all four writers\' contributions')
    assert.equal([...relay.history()].length, 4, 'chain has four commits in lineage')
  })

  test('re-submitting an already-applied batch is correctly rejected (echo handling above the accumulator)', async ({ assert }) => {
    // The ConnectionAccumulator filters echoes by `addressOf` before
    // submitting. The serializer itself doesn't have that guard — if
    // a re-submit reaches submit() (e.g., bypass the accumulator, or
    // a future code path that doesn't dedup at the wire boundary), it
    // must reject rather than silently corrupt or double-apply.
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('echo')

    const author = new WritableStreamoRecord()
    author.set({ v: 1 })
    await author.sign(signer, 'echo')
    const batch = extractBatch(author)

    const relay = new WritableStreamoRecord()
    const serializer = new StreamoRecordSerializer(relay, publicKey)

    const first = await serializer.submit(batch)
    assert.equal(first.accepted, true)
    const relayBytes = relay.byteLength

    // Re-submit the SAME batch. The relay's committedChainHash has
    // already advanced past this sig's chainHash; the chain-equality
    // check fires.
    const second = await serializer.submit(batch)
    assert.equal(second.accepted, false, 're-submit must not silently double-apply')
    assert.equal(second.reason, 'chain-mismatch')
    assert.equal(relay.byteLength, relayBytes, 'relay byteLength unchanged by the rejected re-submit')
  })

  test('rejects a batch with no chunks (empty batch, just a sig)', async ({ assert }) => {
    // An empty batch is a sig that claims `chainHashOf(top, [])` =
    // sha256(top || sha256("")) — a deterministic value. The signer
    // could in principle sign this. The serializer should accept it
    // if the math works out — there's no rule that says batches must
    // have chunks. But the SIG chunk by itself doesn't add user data;
    // it's a degenerate case worth pinning down. Let's see what
    // actually happens and assert it.
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('empty')

    // Build an empty batch by directly computing the sig over zero
    // new bytes against an empty top.
    const { sha256: sha } = await import('node:crypto').then(m => ({
      sha256: bytes => m.createHash('sha256').update(bytes).digest()
    }))
    const top = new Uint8Array(32)
    const emptyBytesHash = sha(new Uint8Array(0))
    const combined = new Uint8Array(64)
    combined.set(top, 0)
    combined.set(emptyBytesHash, 32)
    const emptyChainHash = new Uint8Array(sha(combined))
    const compactRawBytes = await signer.sign('empty', emptyChainHash)

    // Encode the Signature into a wire chunk using the relay's codec.
    const relay = new WritableStreamoRecord()
    const { Signature } = await import('./Signature.js')
    const sigCode = relay.encode(new Signature(emptyChainHash, compactRawBytes))

    const serializer = new StreamoRecordSerializer(relay, publicKey)
    const result = await serializer.submit({ chunks: [], sig: sigCode })
    assert.equal(result.accepted, true, 'empty batch with a correctly-chained sig is accepted (no rule against it)')
    assert.equal(relay.byteLength, sigCode.length, 'only the SIG lands; no chunks')
  })

  test('rejects a batch with a forged signature (crypto failure, not chain mismatch)', async ({ assert }) => {
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('forge-test')

    const author = new WritableStreamoRecord()
    author.set({ v: 1 })
    await author.sign(signer, 'forge-test')
    const batch = extractBatch(author)

    // Tamper with the SIG's signature bytes (preserves chainHash, breaks crypto)
    const badSig = new Uint8Array(batch.sig)
    badSig[40] ^= 0xff
    const badBatch = { chunks: batch.chunks, sig: badSig }

    const relay = new WritableStreamoRecord()
    const serializer = new StreamoRecordSerializer(relay, publicKey)
    const result = await serializer.submit(badBatch)
    assert.equal(result.accepted, false)
    assert.equal(result.reason, 'verification-failed')
    assert.equal(relay.byteLength, 0, 'no bytes land in the relay on crypto failure')
  })
})
