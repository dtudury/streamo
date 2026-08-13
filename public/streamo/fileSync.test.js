import { describe } from './utils/testing.js'
import { StreamoRecord } from './StreamoRecord.js'
import { Mirror } from './Mirror.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { fileSync } from './fileSync.js'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Make a fresh sandbox: a folder for files + a separate folder for the
 * archive dataDir. Returns paths plus a cleanup function.
 */
async function makeSandbox () {
  const dir = await mkdtemp(join(tmpdir(), 'fs-test-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'fs-test-data-'))
  const tryRm = async path => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await rm(path, { recursive: true, force: true }); return }
      catch (e) {
        if (e.code !== 'ENOTEMPTY' || attempt === 2) throw e
        await new Promise(r => setTimeout(r, 100))
      }
    }
  }
  const cleanup = async () => {
    await tryRm(dir)
    await tryRm(dataDir)
  }
  return { dir, dataDir, cleanup }
}

describe(import.meta.url, ({ test }) => {
  // ── flat shape: value IS the files map ──────────────────────────────────
  // Tests that the disk↔repo sync writes/reads flat-shape Records:
  // filenames at top-level (value['index.html'], value['mounts.json'], etc.).
  // See [[the-flatten-arc-2026-06-04]] for the migration history.

  test('disk content lands at top-level value keys', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'index.html'), '<h1>hi</h1>')
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        assert.equal(repo.get('index.html'), '<h1>hi</h1>')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('fresh repo (no prior commit) + disk content → committed', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'index.html'), '<fresh>')
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        assert.equal(repo.get('index.html'), '<fresh>')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('.jsonl on disk becomes an array of records in the repo', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'log.jsonl'), '{"a":1}\n{"b":"two"}\n')
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        assert.deepEqual(repo.get('log.jsonl'), [{ a: 1 }, { b: 'two' }])
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('.jsonl written back from the repo is byte-identical', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const working = repo.checkout()
      working.set({ 'log.jsonl': [{ a: 1 }, { b: 'two' }] })
      repo.commit(working, 'seed jsonl')
      await new Promise(r => setTimeout(r, 30))
      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        const content = await readFile(join(dir, 'log.jsonl'), 'utf8')
        assert.equal(content, '{"a":1}\n{"b":"two"}\n', 'exact bytes, including the trailing newline')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // The one lossy conversion we accept, at David's call 2026-08-13: a file
  // with no trailing newline still parses, and gains one on the way back out.
  test('.jsonl with no trailing newline still parses, and gains one back', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'log.jsonl'), '{"a":1}\n{"b":2}')
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        assert.deepEqual(repo.get('log.jsonl'), [{ a: 1 }, { b: 2 }], 'parses despite the missing newline')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // The interesting case, and it is not hypothetical: 2 of 69 real transcripts
  // in the-grove hit it. Some records were written by a different tool as
  // `{"a": 1}` where Claude Code writes `{"a":1}`, and JSON.stringify
  // normalises the spaces away — so parsing would silently rewrite the file.
  // decodeFile checks its own round-trip against encodeFile and declines.
  test('.jsonl that cannot round-trip byte-exactly stays a string', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'log.jsonl'), '{"a": 1}\n')
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        assert.equal(repo.get('log.jsonl'), '{"a": 1}\n', 'kept verbatim rather than reformatted')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('repo wins when disk is empty but repo has files', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const working = repo.checkout()
      working.set({ 'a.html': '<a>' })
      repo.commit(working, 'seed with files')
      await new Promise(r => setTimeout(r, 30))
      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        const content = await readFile(join(dir, 'a.html'), 'utf8')
        assert.equal(content, '<a>')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('disk wins when disk is newer than the last commit', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const working = repo.checkout()
      working.set({ 'old.html': '<old>' })
      repo.commit(working, 'old seed')
      await new Promise(r => setTimeout(r, 30))
      await writeFile(join(dir, 'new.html'), '<new>')
      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        assert.equal(repo.get('new.html'), '<new>')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // ── the third quadrant: disk POPULATED and older ────────────────────────
  //
  // The two tests above cover disk-empty (repo wins, nothing to remove) and
  // disk-newer (disk wins, no removal branch reached). Neither one can reach
  // the code that deletes: with an empty disk `managed` is `{}`, so `toDelete`
  // is empty by construction no matter what the repo says.
  //
  // The quadrant that deletes is disk populated AND older than the last
  // commit. That is the arm that removed 115 of 154 files from `public/`
  // twice (see `env/dev.env`, and the revert in 7f9e6f3). It had no coverage
  // at this layer until now — the two opposed mount tests below (:186 / :249)
  // pin the same question one level down, at a mount prefix, and were written
  // by e40d72f for exactly this reason: one test alone can only confirm the
  // misunderstanding its author already had.
  //
  // So these two point in opposite directions on purpose. Weaken the delete
  // and the first fails; make it greedier and the second fails.

  test('repo wins and DELETES a disk file it does not have, when disk is older', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      // Files exist on disk FIRST, then a commit lands that doesn't mention
      // one of them — which is what a relay handing us an authoritative
      // value looks like from here.
      await writeFile(join(dir, 'keep.html'), '<keep>')
      await writeFile(join(dir, 'orphan.html'), '<orphan>')
      await new Promise(r => setTimeout(r, 30))

      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const working = repo.checkout()
      working.set({ 'keep.html': '<keep>' })
      repo.commit(working, 'record omits orphan.html')

      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        assert.equal(await readFile(join(dir, 'keep.html'), 'utf8'), '<keep>')
        let orphanGone = false
        try { await readFile(join(dir, 'orphan.html'), 'utf8') } catch { orphanGone = true }
        assert.equal(orphanGone, true)
        // And the deletion must not have been laundered back into the chain:
        // the Record still says what it said.
        assert.equal(repo.get('orphan.html'), undefined)
      } finally {
        await sub.close()
      }
    } finally {
      await cleanup()
    }
  })

  test('disk wins and KEEPS a file the repo does not have, when disk is newer', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const working = repo.checkout()
      working.set({ 'keep.html': '<keep>' })
      repo.commit(working, 'record omits orphan.html')
      await new Promise(r => setTimeout(r, 30))

      // Same shape as above, only the order is reversed: the disk moved last.
      await writeFile(join(dir, 'keep.html'), '<keep>')
      await writeFile(join(dir, 'orphan.html'), '<orphan>')

      const sub = await fileSync(repoMirror, dir, dataDir)
      try {
        assert.equal(await readFile(join(dir, 'orphan.html'), 'utf8'), '<orphan>')
        // Disk won, so the orphan is now part of the Record rather than gone.
        assert.equal(repo.get('orphan.html'), '<orphan>')
      } finally {
        await sub.close()
      }
    } finally {
      await cleanup()
    }
  })

  // ── mounts: materialization onto disk (read-only one-way) ────────────────

  function makeStubRegistry (entries) {
    const map = new Map(entries)
    return { get: k => map.get(k), _materialize: async k => map.get(k) }
  }
  const KEY_A = 'a'.repeat(66)
  const KEY_B = 'b'.repeat(66)
  const KEY_C = 'c'.repeat(66)

  /**
   * Build a sealed StreamoRecord with a single commit of the given value.
   * Accepts the legacy `{ files, mounts }` fixture shape (how apps thought
   * about Records before the flatten arc) and translates to flat storage:
   * filenames at top-level, mounts at value['mounts.json'].mounts.
   */
  function sealedRepo (publicKeyHex, value, msg = 'seed') {
    let next = {}
    if (value) {
      const { mounts, files = {}, ...rest } = value
      next = { ...rest, ...files }
      if (mounts) next['mounts.json'] = { mounts }
    }
    const r = new WritableStreamoRecord()
    const w = r.checkout()
    w.set(next)
    r.commit(w, msg)
    // Returns a Mirror, not the record: fileSync and FolderRecord both take
    // Mirrors as of 2026-08-01, and makeStubRegistry stores these directly
    // so `_materialize` hands back the SAME Mirror the test passed in —
    // one Mirror per (registry, pubkey), same as the real registry.
    return new Mirror({ publicKeyHex, local: r })
  }

  test('mounts: materializes mounted files at their prefix paths on disk', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const b = sealedRepo(KEY_B, { files: { 'h.js': 'export const h = …' } })
      const a = sealedRepo(KEY_A, {
        files: { 'main.js': "import { h } from '../streamo/h.js'" },
        mounts: { 'streamo/': { key: KEY_B } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
        pubkeyHex: KEY_A
      })
      try {
        assert.equal((await readFile(join(dir, 'main.js'), 'utf8')),
          "import { h } from '../streamo/h.js'")
        assert.equal((await readFile(join(dir, 'streamo/h.js'), 'utf8')),
          'export const h = …')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // ── the third quadrant: disk populated AND older than the last commit ────
  //
  // The two branch tests above cover "disk empty, repo has files" and "disk
  // newer than the commit." The quadrant that has never been tested is the
  // one that deletes: disk *populated* and *older*, so the repo wins and the
  // downward flush computes a toDelete set. On 2026-08-04 that path removed
  // 115 files under `public/`.
  //
  // The pair below is deliberate. An unpopulated mount must NOT delete; a
  // mount that resolved to an empty value MUST. Any fix that only satisfies
  // the first (e.g. "never delete under a mount prefix") fails the second.

  test('mounts: an unpopulated mount does not delete the files already at its prefix', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await mkdir(join(dir, 'apps/explorer'), { recursive: true })
      await writeFile(join(dir, 'apps/explorer/index.html'), '<explorer>')
      await new Promise(r => setTimeout(r, 30))

      // In the registry, but no chain: upstream has never said anything
      // about this prefix. Distinct from "upstream says it is empty."
      const unpopulated = new Mirror({ publicKeyHex: KEY_B, local: new WritableStreamoRecord() })
      const a = sealedRepo(KEY_A, {
        files: { 'index.html': '<home>' },
        mounts: { 'apps/explorer/': { key: KEY_B } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, unpopulated]]),
        pubkeyHex: KEY_A
      })
      try {
        assert.equal(
          (await readFile(join(dir, 'apps/explorer/index.html'), 'utf8')),
          '<explorer>'
        )
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('mounts: a keyless ours:true mount is unresolvable here, so its prefix is not deletable', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await mkdir(join(dir, 'apps/explorer'), { recursive: true })
      await writeFile(join(dir, 'apps/explorer/index.html'), '<explorer>')
      await new Promise(r => setTimeout(r, 30))

      // This is the shipped shape of public/mounts.json since 951c5e1: no
      // pinned key. collectAllMounted has no signer, so it cannot derive the
      // child key and cannot ask that Record anything — which means it has
      // not heard from upstream, same as a mount with no chain.
      const a = sealedRepo(KEY_A, {
        files: { 'index.html': '<home>' },
        mounts: { 'apps/explorer/': { ours: true } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a]]),
        pubkeyHex: KEY_A
      })
      try {
        assert.equal(
          (await readFile(join(dir, 'apps/explorer/index.html'), 'utf8')),
          '<explorer>'
        )
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('mounts: a mount that resolves to an empty value still deletes its materialized files', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await mkdir(join(dir, 'apps/explorer'), { recursive: true })
      await writeFile(join(dir, 'apps/explorer/stale.html'), '<stale>')
      await new Promise(r => setTimeout(r, 30))

      // Upstream HAS spoken — a real commit whose value no longer holds the
      // file. Per the relay invariant, what comes down is correct, so this
      // deletion must propagate.
      const emptied = sealedRepo(KEY_B, {})
      const a = sealedRepo(KEY_A, {
        files: { 'index.html': '<home>' },
        mounts: { 'apps/explorer/': { key: KEY_B } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, emptied]]),
        pubkeyHex: KEY_A
      })
      try {
        let stillThere = true
        try { await readFile(join(dir, 'apps/explorer/stale.html'), 'utf8') } catch { stillThere = false }
        assert.equal(stillThere, false)
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('mounts: pinned dataAddress materializes the record at that specific commit', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const b = new WritableStreamoRecord()
      let w = b.checkout()
      w.set({ 'h.js': 'v1' })
      b.commit(w, 'v1')
      const v1Addr = b.lastCommit.dataAddress
      w = b.checkout()
      w.set({ 'h.js': 'v2' })
      b.commit(w, 'v2')
      const a = sealedRepo(KEY_A, {
        mounts: { 'streamo/': { key: KEY_B, dataAddress: v1Addr } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
        pubkeyHex: KEY_A
      })
      try {
        // Pinned mount serves v1 even though b is at v2
        assert.equal((await readFile(join(dir, 'streamo/h.js'), 'utf8')), 'v1')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('mounts: cycle detection — A→B→A stops at the loop', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const a = sealedRepo(KEY_A, {
        files: { 'a.txt': 'A-self' },
        mounts: { 'b/': { key: KEY_B } }
      })
      const b = sealedRepo(KEY_B, {
        files: { 'b.txt': 'B-self' },
        mounts: { 'back-to-a/': { key: KEY_A } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
        pubkeyHex: KEY_A
      })
      try {
        // A's own + B's own are materialized; A→B→A loop short-circuits
        // before re-materializing A's files under b/back-to-a/a.txt.
        assert.equal((await readFile(join(dir, 'a.txt'), 'utf8')), 'A-self')
        assert.equal((await readFile(join(dir, 'b/b.txt'), 'utf8')), 'B-self')
        let cycled = false
        try { await readFile(join(dir, 'b/back-to-a/a.txt')); cycled = true } catch {}
        assert.equal(cycled, false, 'cycle should not have materialized')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('mounts: nested mount-through-mount materializes A→B→C', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const c = sealedRepo(KEY_C, { files: { 'leaf.txt': 'deep' } })
      const b = sealedRepo(KEY_B, {
        files: { 'mid.txt': 'middle' },
        mounts: { 'c/': { key: KEY_C } }
      })
      const a = sealedRepo(KEY_A, {
        files: { 'top.txt': 'top' },
        mounts: { 'b/': { key: KEY_B } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, b], [KEY_C, c]]),
        pubkeyHex: KEY_A
      })
      try {
        assert.equal((await readFile(join(dir, 'top.txt'), 'utf8')), 'top')
        assert.equal((await readFile(join(dir, 'b/mid.txt'), 'utf8')), 'middle')
        assert.equal((await readFile(join(dir, 'b/c/leaf.txt'), 'utf8')), 'deep')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('mounts: disabled when registry/pubkeyHex not provided (files-only)', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const b = sealedRepo(KEY_B, { files: { 'h.js': 'lib' } })
      const a = sealedRepo(KEY_A, {
        files: { 'main.js': 'app' },
        mounts: { 'streamo/': { key: KEY_B } }
      })
      // No registry/pubkeyHex → mount table is ignored, only own files materialize.
      const sub = await fileSync(a, dir, dataDir)
      try {
        assert.equal((await readFile(join(dir, 'main.js'), 'utf8')), 'app')
        let mounted = false
        try { await readFile(join(dir, 'streamo/h.js')); mounted = true } catch {}
        assert.equal(mounted, false, 'mounts should not materialize without registry')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // ── streamo.json (recordFile) mid-edit grace ────────────────────────────
  // streamo.json is just another file in flat shape — its parsed object
  // lands at value['streamo.json']. The only special handling is mid-edit:
  // if its JSON fails to parse, we drop it from the commit so a transient
  // broken state doesn't overwrite the previous valid object.

  test('streamo.json: parsed JSON lands as a top-level object', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'streamo.json'), '{"title":"hello"}')
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const sub = await fileSync(repoMirror, dir, dataDir, { recordFile: 'streamo.json' })
      try {
        assert.deepEqual(repo.get('streamo.json'), { title: 'hello' })
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('streamo.json: invalid JSON during initial sync is dropped (mid-edit grace)', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'streamo.json'), '{ broken')
      await writeFile(join(dir, 'index.html'), '<ok>')
      const repo = new WritableStreamoRecord()
      const repoMirror = new Mirror({ publicKeyHex: 'ab'.repeat(33), local: repo })
      const sub = await fileSync(repoMirror, dir, dataDir, { recordFile: 'streamo.json' })
      try {
        // Other files commit fine; broken JSON entry is absent.
        assert.equal(repo.get('index.html'), '<ok>')
        assert.equal(repo.get('streamo.json'), undefined)
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })
})
