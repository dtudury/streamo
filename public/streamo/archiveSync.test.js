import { describe } from './utils/testing.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { Streamo } from './Streamo.js'
import { Signer } from './Signer.js'
import { bytesToHex } from './utils.js'
import { archiveSync } from './archiveSync.js'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const SIGNER = new Signer('archive-test', 'pw', 1)
async function realKey (name) {
  const { publicKey } = await SIGNER.keysFor(name)
  return bytesToHex(publicKey)
}

describe(import.meta.url, ({ test }) => {
  test('slim StreamoRecord loads an existing archive without wiping it (regression for the post-11.0 compact-path duck-type bug)', async ({ assert }) => {
    // Pre-11.0, the compact path was gated on `typeof stream.commit !==
    // 'function'` — every StreamoRecord had commit, so the check
    // correctly skipped Records. Post-rip, slim StreamoRecord lost
    // commit (moved to Writable), so the duck-type now misfires: a
    // slim Record loading from archive triggers the compact path,
    // which calls `_reset()` (works) then `set(value)` (TypeError —
    // slim has no set), the try/catch silently swallows, the stream
    // is left empty, archiveSync's startup decides to truncate the
    // file to 0 bytes, and the cache is wiped.
    //
    // This test catches that. It exercises the everyday "subscriber's
    // local cache" use case: a peer's Record was previously cached to
    // disk; on the next session we want to load it via a slim Record
    // (we don't author to peers).
    const dir = await mkdtemp(join(tmpdir(), 'archive-slim-'))
    const key = await realKey('peer-record')
    try {
      // First session: WritableStreamoRecord writes a commit, archive
      // persists it, close.
      {
        const w = new WritableStreamoRecord()
        const { close } = await archiveSync(w, dir, key)
        w.attachSigner(SIGNER, 'peer-record')
        w.set({ headline: 'cached from a prior session' })
        await close()
      }

      const fileBefore = await readFile(join(dir, `${key}.bin`))
      assert.ok(fileBefore.length > 0, 'archive has bytes from the first session')

      // Second session: a SLIM StreamoRecord loads the cache. The
      // compact path must not fire; the stream must end up with the
      // loaded bytes intact.
      const slim = new StreamoRecord()
      const { close: closeSlim } = await archiveSync(slim, dir, key)

      assert.equal(slim.wireByteLength, fileBefore.length,
        'slim Record loaded the full archive contents into memory; ' +
        'if wireByteLength is 0, the compact path silently wiped it ' +
        '(archiveSync.js duck-type bug)')
      assert.ok(slim.lastCommit, 'slim Record can read the loaded commit')
      assert.equal(slim.get('headline'), 'cached from a prior session',
        'slim Record reads the cached value through lastCommit')

      await closeSlim()  // shut down the writer loop so the process can exit

      // And the cache on disk survived intact.
      const fileAfter = await readFile(join(dir, `${key}.bin`))
      assert.equal(fileAfter.length, fileBefore.length,
        'disk archive bytes preserved — slim load did not trigger a truncate')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('archiveSync refuses to silently truncate when in-memory diverges from disk', async ({ assert }) => {
    // The defense-in-depth sanity: archiveSync's append-vs-truncate
    // decision is based on `wireByteLength === fileSize`. The
    // legitimate truncate cause is the compact-plain-Streamo branch.
    // Any OTHER cause of in-memory < disk at archiveSync setup
    // (stale-process race, in-memory corruption, future bug we
    // haven't seen yet) should crash loudly instead of silently
    // serializing the corruption.
    //
    // Manufactured scenario: a pre-populated stream that already has
    // bytes when archiveSync runs. After the load step writes the
    // file bytes into it, in-memory > file. Either-direction
    // divergence is the alarm.
    const dir = await mkdtemp(join(tmpdir(), 'archive-refuse-'))
    const keyA = await realKey('refuse-test-a')
    const keyB = await realKey('refuse-test-b')
    try {
      // Author two distinct archives. (Using a Writable for the
      // setup is fine — we await close() so its scheduleSign
      // settles before we move on.)
      {
        const a = new WritableStreamoRecord()
        const { close } = await archiveSync(a, dir, keyA)
        a.attachSigner(SIGNER, 'refuse-test-a')
        a.set({ phase: 'archive A in memory' })
        await close()
      }
      {
        const b = new WritableStreamoRecord()
        const { close } = await archiveSync(b, dir, keyB)
        b.attachSigner(SIGNER, 'refuse-test-b')
        b.set({ phase: 'archive B on disk' })
        await close()
      }

      // Manufacture divergence: a slim StreamoRecord pre-populated
      // with archive A's bytes, then archiveSync'd against archive
      // B's file. archiveSync's load appends B's bytes into slim
      // (different content addresses than A's, no dedup), so after
      // load: in-memory has A+B; fileSize is B alone. Divergence →
      // sanity throws.
      //
      // We use slim (not Writable) on purpose: it has no
      // scheduleSign machinery, so there are no pending async
      // sign promises to keep the event loop alive past the
      // throw — keeps the test process exit-clean.
      //
      // Compact path is correctly skipped here because `'lastCommit'
      // in slim` is true (slim StreamoRecord has lastCommit), so
      // intentionallyCompacted stays false and the sanity check
      // applies.
      const fileA = await readFile(join(dir, `${keyA}.bin`))
      const slim = new StreamoRecord()
      const loadWriter = slim.makeWritableStream().getWriter()
      await loadWriter.write(new Uint8Array(fileA))
      loadWriter.releaseLock()

      let threw = null
      try {
        await archiveSync(slim, dir, keyB)
      } catch (e) {
        threw = e
      }
      assert.ok(threw, 'archiveSync should refuse to proceed when in-memory diverges from disk')
      assert.ok(/refus|diverg/i.test(threw.message),
        'the diagnostic should name what happened so the operator can investigate; got: ' + threw.message)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('plain Streamo still compacts on load (the legitimate truncate path)', async ({ assert }) => {
    // The compact path exists for a reason: plain Streamos (no commit
    // semantics, no chain) can be safely compacted to "just the current
    // value" because there are no dataAddress pointers to invalidate.
    // archiveSync should keep doing this for plain Streamos — the
    // refuse-to-truncate sanity should NOT fire here.
    const dir = await mkdtemp(join(tmpdir(), 'archive-compact-'))
    const key = await realKey('plain-streamo-compact')
    try {
      // Write a plain Streamo with several sets — the archive holds
      // the full history.
      {
        const s = new Streamo()
        const { close } = await archiveSync(s, dir, key)
        s.set({ counter: 1 })
        s.set({ counter: 2 })
        s.set({ counter: 3 })
        await close()
      }
      const fileBefore = await readFile(join(dir, `${key}.bin`))

      // Re-open: a plain Streamo loads the archive. Compaction
      // discards the {counter:1,2} history; the rewrite captures only
      // the current value.
      const s = new Streamo()
      const { close } = await archiveSync(s, dir, key)
      assert.deepEqual(s.get(), { counter: 3 },
        'plain Streamo reads the current value after compact + reload')
      await close()

      const fileAfter = await readFile(join(dir, `${key}.bin`))
      assert.ok(fileAfter.length < fileBefore.length,
        'plain-Streamo compact shrunk the archive (the legitimate truncate path)')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
