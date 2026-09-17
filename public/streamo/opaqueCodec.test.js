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
import { bytesToHex } from './utils.js'

const chunkCount = record => (record.wireByteLength - record.byteLength) / 4
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])
const pattern = n => new Uint8Array(n).map((_, i) => (i * 13 + 5) % 251)

async function carriedAcross (from) {
  const to = new Streamo({ recaller: new Recaller('to') })
  const writer = to.makeWritableStream().getWriter()
  const reader = from.makeReadableStream({ fromOffset: 0 }).getReader()
  while (to.byteLength < from.byteLength) {
    const { value, done } = await reader.read()
    if (done) break
    await writer.write(value)
  }
  writer.releaseLock()
  reader.cancel().catch(() => {})
  return to
}

describe(import.meta.url, ({ test }) => {
  test('opaque bytes round-trip at every length boundary', async ({ assert }) => {
    for (const n of [5, 254, 255, 256, 257, 65535, 65536, 65537, 200000]) {
      const bytes = pattern(n)
      const streamo = new Streamo({ recaller: new Recaller('rt') })
      streamo.set({ blob: bytes })
      assert.ok(sameBytes(streamo.get('blob'), bytes), `${n} bytes round-trip in memory`)
      const carried = await carriedAcross(streamo)
      assert.ok(sameBytes(carried.get('blob'), bytes), `${n} bytes survive the wire`)
    }
  })

  test('one chunk per blob, however big — the Duple tree walked bytes to 4-byte leaves', async ({ assert }) => {
    const streamo = new Streamo({ recaller: new Recaller('count') })
    streamo.set({ blob: pattern(4096) })
    assert.ok(chunkCount(streamo) < 10, `a 4096-byte blob is a handful of chunks, was 1013 (got ${chunkCount(streamo)})`)
    assert.ok(streamo.byteLength < 4096 * 1.05, `and stops inflating 20% (got ${streamo.byteLength})`)
  })

  test('identical blobs still dedup', async ({ assert }) => {
    const streamo = new Streamo({ recaller: new Recaller('dedup') })
    const blob = pattern(1000)
    streamo.set({ x: blob, y: blob })
    assert.ok(streamo.byteLength < 1500, `stored once, not twice (got ${streamo.byteLength})`)
  })

  test('over 16MB throws rather than silently truncating the length', async ({ assert }) => {
    const streamo = new Streamo({ recaller: new Recaller('big') })
    assert.throws(() => streamo.set({ blob: new Uint8Array(0x1000000) }))
  })

  test('a Buffer-backed payload decodes — Buffer.slice is a view, Uint8Array.slice is a copy', async ({ assert }) => {
    // The regression this test exists for: archiveSync loads with readFile, so
    // every chunk parsed out of the file is Buffer-backed. A payload handed
    // back as a view into the whole file breaks DATE/FLOAT64, which do
    // new Float64Array(buffer, byteOffset) and need an 8-byte-aligned offset.
    const signer = new Signer('user', 'pass', 1000)
    const key = bytesToHex((await signer.keysFor('peer-record')).publicKey)
    const dir = await mkdtemp(join(tmpdir(), 'opaque-archive-'))
    {
      const writable = new WritableStreamoRecord()
      const { close } = await archiveSync(writable, dir, key)
      writable.attachSigner(signer, 'peer-record')
      writable.set({ headline: 'cached from a prior session' })
      await close()
    }
    const onDisk = await readFile(join(dir, `${key}.bin`))
    assert.ok(onDisk.length > 0)

    const slim = new StreamoRecord()
    const { close } = await archiveSync(slim, dir, key)
    try {
      assert.ok(slim.lastCommit, 'the reloaded commit decodes')
      assert.equal(slim.get('headline'), 'cached from a prior session')
    } finally {
      await close()
    }
  })
})
