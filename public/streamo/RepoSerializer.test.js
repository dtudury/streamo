import { describe } from './utils/testing.js'
import { Repo } from './Repo.js'
import { RepoSerializer } from './RepoSerializer.js'
import { Signer } from './Signer.js'

// Helpers: extract a batch (chunks + sig) from a Repo's bytestream
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
    const author = new Repo()
    author.set({ v: 1 })
    await author.sign(signer, 'serializer-test')
    const batch = extractBatch(author)

    // Target relay (fresh, empty)
    const relay = new Repo()
    const serializer = new RepoSerializer(relay, publicKey)
    const result = await serializer.submit(batch)
    assert.equal(result.accepted, true, 'first batch on empty repo must be accepted')
    assert.equal(relay.byteLength, author.byteLength, 'relay now mirrors the author batch')
    assert.deepEqual(relay.get('v'), 1, 'relay can read the committed value')
  })

  test('rejects a batch whose sig does not chain off the current top', async ({ assert }) => {
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('race-test')

    // Both authors start fresh and both write commit_1 — they're racing
    const a = new Repo()
    a.set({ v: 'apple' })
    await a.sign(signer, 'race-test')
    const b = new Repo()
    b.set({ v: 'banana' })
    await b.sign(signer, 'race-test')

    const relay = new Repo()
    const serializer = new RepoSerializer(relay, publicKey)
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

    const a = new Repo()
    a.set({ v: 'apple' })
    await a.sign(signer, 'concurrent')
    const b = new Repo()
    b.set({ v: 'banana' })
    await b.sign(signer, 'concurrent')

    const relay = new Repo()
    const serializer = new RepoSerializer(relay, publicKey)

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

    const author = new Repo()
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

    const relay = new Repo()
    const serializer = new RepoSerializer(relay, publicKey)
    const [r1, r2] = await Promise.all([
      serializer.submit(batch1),
      serializer.submit(batch2)
    ])
    assert.equal(r1.accepted, true, 'batch1 accepted')
    assert.equal(r2.accepted, true, 'batch2 accepted (chains off batch1)')
    assert.deepEqual(relay.get('v'), 2, 'relay top reflects both batches')
  })

  test('rejects a batch with a forged signature (crypto failure, not chain mismatch)', async ({ assert }) => {
    const signer = new Signer('alice', 'pass', 1)
    const { publicKey } = await signer.keysFor('forge-test')

    const author = new Repo()
    author.set({ v: 1 })
    await author.sign(signer, 'forge-test')
    const batch = extractBatch(author)

    // Tamper with the SIG's signature bytes (preserves chainHash, breaks crypto)
    const badSig = new Uint8Array(batch.sig)
    badSig[40] ^= 0xff
    const badBatch = { chunks: batch.chunks, sig: badSig }

    const relay = new Repo()
    const serializer = new RepoSerializer(relay, publicKey)
    const result = await serializer.submit(badBatch)
    assert.equal(result.accepted, false)
    assert.equal(result.reason, 'verification-failed')
    assert.equal(relay.byteLength, 0, 'no bytes land in the relay on crypto failure')
  })
})
