import { readFile, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe } from './utils/testing.js'
import { Recaller } from './utils/Recaller.js'
import { Streamo } from './Streamo.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { archiveSync } from './archiveSync.js'
import { Signer } from './Signer.js'
import { Opaque } from './Opaque.js'
import { bytesToHex } from './utils.js'

const chunkCount = record => (record.wireByteLength - record.byteLength) / 4
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])
const pattern = n => new Uint8Array(n).map((_, i) => (i * 13 + 5) % 251)

describe(import.meta.url, ({ test }) => {
  test('opaque bytes round-trip at every length-width boundary', async ({ assert }) => {
    for (const n of [0, 1, 5, 255, 256, 65535, 65536, 16777215, 16777216]) {
      const bytes = pattern(n)
      const streamo = new Streamo({ recaller: new Recaller('rt') })
      streamo.set({ blob: new Opaque(bytes) })
      const back = streamo.get('blob')
      assert.ok(back instanceof Opaque, `${n} bytes decode back to an Opaque, not a bare Uint8Array`)
      assert.ok(sameBytes(back.value, bytes), `${n} bytes round-trip`)
    }
  })

  test('wrapping is what chooses the codec — the same bytes go two ways', async ({ assert }) => {
    const bytes = pattern(4096)
    const tree = new Streamo({ recaller: new Recaller('tree') })
    tree.set({ blob: bytes })
    const opaque = new Streamo({ recaller: new Recaller('opaque') })
    opaque.set({ blob: new Opaque(bytes) })

    assert.ok(chunkCount(tree) > 500, `unwrapped bytes still decompose (got ${chunkCount(tree)})`)
    assert.ok(chunkCount(opaque) < 10, `wrapped bytes are one chunk plus scaffolding (got ${chunkCount(opaque)})`)
    assert.ok(opaque.byteLength < tree.byteLength, `and smaller stored once (${opaque.byteLength} vs ${tree.byteLength})`)
  })

  test('the trade is editability: appending is cheap in a tree and total in an opaque', async ({ assert }) => {
    const doc = 'line of text\n'.repeat(1500)
    const longer = doc + 'one more line\n'
    const encode = text => new TextEncoder().encode(text)

    const tree = new Streamo({ recaller: new Recaller('t') })
    tree.set({ f: encode(doc) })
    const treeBefore = tree.byteLength
    tree.set({ f: encode(longer) })
    const treeGrowth = tree.byteLength - treeBefore

    const opaque = new Streamo({ recaller: new Recaller('o') })
    opaque.set({ f: new Opaque(encode(doc)) })
    const opaqueBefore = opaque.byteLength
    opaque.set({ f: new Opaque(encode(longer)) })
    const opaqueGrowth = opaque.byteLength - opaqueBefore

    assert.ok(treeGrowth < doc.length / 10,
      `appending to a tree reuses untouched subtrees (grew ${treeGrowth} of ${doc.length})`)
    assert.ok(opaqueGrowth > doc.length,
      `appending to an opaque rewrites the whole payload (grew ${opaqueGrowth} of ${doc.length})`)
    assert.ok(opaqueGrowth > treeGrowth * 10,
      'which is why Opaque is opt-in and not the default')
  })

  test('identical opaque values are stored once', async ({ assert }) => {
    const streamo = new Streamo({ recaller: new Recaller('dedup') })
    const blob = pattern(1000)
    streamo.set({ x: new Opaque(blob), y: new Opaque(blob) })
    assert.ok(streamo.byteLength < 1500, `stored once, not twice (got ${streamo.byteLength})`)
  })

  test('a payload past 16MB uses the widest length and still round-trips', async ({ assert }) => {
    // 1..4 length bytes means the last reachable width starts just past 16MB.
    const streamo = new Streamo({ recaller: new Recaller('wide') })
    const bytes = pattern(0x1000000 + 1)
    streamo.set({ blob: new Opaque(bytes) })
    const back = streamo.get('blob')
    assert.ok(back instanceof Opaque)
    assert.equal(back.value.length, bytes.length, 'a 4-byte length round-trips')
    assert.ok(chunkCount(streamo) < 10, 'and it is still one chunk plus scaffolding')
  })

  test('a payload past what a 4-byte length can say throws instead of corrupting', async ({ assert }) => {
    // Checked without allocating: numberToVar uses >>> and truncates at 32
    // bits, so 2**32 encodes as a ONE-byte zero — and V8 will allocate an
    // array that big. Without the guard the chunk would claim length 0 and
    // decode as garbage, silently.
    const streamo = new Streamo({ recaller: new Recaller('too-big') })
    const pretendsToBeHuge = Object.create(Opaque.prototype)
    pretendsToBeHuge.value = { length: 0x100000000 }
    assert.throws(() => streamo.encode(pretendsToBeHuge))
  })

  test('an opaque payload survives an archive round trip (Buffer.slice is a view)', async ({ assert }) => {
    // archiveSync loads with readFile, so reloaded chunks are Buffer-backed and
    // .slice() would hand back a view into the whole file. Anything that reads
    // a payload as a typed array needs its own aligned copy.
    const signer = new Signer('user', 'pass', 1000)
    const key = bytesToHex((await signer.keysFor('peer-record')).publicKey)
    const dir = await mkdtemp(join(tmpdir(), 'opaque-archive-'))
    const blob = pattern(5000)
    {
      const writable = new WritableStreamoRecord()
      const { close } = await archiveSync(writable, dir, key)
      writable.attachSigner(signer, 'peer-record')
      writable.set({ headline: 'cached from a prior session', blob: new Opaque(blob) })
      await close()
    }
    assert.ok((await readFile(join(dir, `${key}.bin`))).length > 0)

    const slim = new StreamoRecord()
    const { close } = await archiveSync(slim, dir, key)
    try {
      assert.ok(slim.lastCommit, 'the reloaded commit decodes')
      assert.equal(slim.get('headline'), 'cached from a prior session')
      assert.ok(sameBytes(slim.get('blob').value, blob), 'and the opaque payload is intact')
    } finally {
      await close()
    }
  })
})
