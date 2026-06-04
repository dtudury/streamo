import { describe } from './utils/testing.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { fileSync } from './fileSync.js'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
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
      const sub = await fileSync(repo, dir, dataDir)
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
      const sub = await fileSync(repo, dir, dataDir)
      try {
        assert.equal(repo.get('index.html'), '<fresh>')
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
      const working = repo.checkout()
      working.set({ 'a.html': '<a>' })
      repo.commit(working, 'seed with files')
      await new Promise(r => setTimeout(r, 30))
      const sub = await fileSync(repo, dir, dataDir)
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
      const working = repo.checkout()
      working.set({ 'old.html': '<old>' })
      repo.commit(working, 'old seed')
      await new Promise(r => setTimeout(r, 30))
      await writeFile(join(dir, 'new.html'), '<new>')
      const sub = await fileSync(repo, dir, dataDir)
      try {
        assert.equal(repo.get('new.html'), '<new>')
      } finally {
        await sub.unsubscribe()
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
  function sealedRepo (value, msg = 'seed') {
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
    return r
  }

  test('mounts: materializes mounted files at their prefix paths on disk', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const b = sealedRepo({ files: { 'h.js': 'export const h = …' } })
      const a = sealedRepo({
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
      const a = sealedRepo({
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
      const a = sealedRepo({
        files: { 'a.txt': 'A-self' },
        mounts: { 'b/': { key: KEY_B } }
      })
      const b = sealedRepo({
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
      const c = sealedRepo({ files: { 'leaf.txt': 'deep' } })
      const b = sealedRepo({
        files: { 'mid.txt': 'middle' },
        mounts: { 'c/': { key: KEY_C } }
      })
      const a = sealedRepo({
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
      const b = sealedRepo({ files: { 'h.js': 'lib' } })
      const a = sealedRepo({
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
      const sub = await fileSync(repo, dir, dataDir, { recordFile: 'streamo.json' })
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
      const sub = await fileSync(repo, dir, dataDir, { recordFile: 'streamo.json' })
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
