import { describe } from './utils/testing.js'
import { Repo } from './Repo.js'
import { fileSync } from './fileSync.js'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Make a fresh sandbox: a folder for files + a separate folder for the
 * archive dataDir.  Returns paths plus a cleanup function.
 */
async function makeSandbox () {
  const dir = await mkdtemp(join(tmpdir(), 'fs-test-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'fs-test-data-'))
  // Robust cleanup: rm with retry+delay because parcel/watcher's async
  // finalization can race with the rmdir and produce ENOTEMPTY. A small
  // pause + one retry absorbs that without leaking handles or files.
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
  // ── default shape: files at value.files, siblings preserved ─────────────

  test('disk content lands at value.files; sibling state preserved', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'index.html'), '<h1>hi</h1>')

      const repo = new Repo()
      const working = repo.checkout()
      working.set({ members: ['alice'], journalists: ['bob'] })
      repo.commit(working, 'seed')

      const sub = await fileSync(repo, dir, dataDir)
      try {
        // Siblings preserved
        assert.deepEqual(repo.get('members'), ['alice'])
        assert.deepEqual(repo.get('journalists'), ['bob'])
        // Files at the subkey
        assert.equal(repo.get('files', 'index.html'), '<h1>hi</h1>')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('lastCommit exists but no files at value.files → disk still wins (does not wipe)', async ({ assert }) => {
    // This is the chat-server-on-first-startup edge: the home repo already
    // has `{ members, journalists, entries }` from the seed, but no `files`
    // key yet.  The repo-wins branch must NOT fire (it would write {} to
    // disk and delete authored files).
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'index.html'), '<authored>')

      const repo = new Repo()
      const working = repo.checkout()
      working.set({ entries: ['hi'] })
      repo.commit(working, 'seed')

      const sub = await fileSync(repo, dir, dataDir)
      try {
        // Disk file survives (wasn't wiped by "repo wins with empty files map")
        const onDisk = await readFile(join(dir, 'index.html'), 'utf8')
        assert.equal(onDisk, '<authored>')
        // And it got committed to the repo at the right key
        assert.equal(repo.get('files', 'index.html'), '<authored>')
        // Siblings preserved
        assert.deepEqual(repo.get('entries'), ['hi'])
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('repo wins when disk is empty but repo has files at value.files', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const repo = new Repo()
      const working = repo.checkout()
      working.set({ files: { 'a.html': '<a>' }, members: ['alice'] })
      repo.commit(working, 'seed with files')

      // Pretend disk content is older
      await new Promise(r => setTimeout(r, 30))

      const sub = await fileSync(repo, dir, dataDir)
      try {
        const content = await readFile(join(dir, 'a.html'), 'utf8')
        assert.equal(content, '<a>')
        // Siblings preserved
        assert.deepEqual(repo.get('members'), ['alice'])
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('fresh repo (no prior commit) + disk content → committed at value.files', async ({ assert }) => {
    // No seed, no prior commits.  setRepoFiles must materialize the
    // wrapping object before path-set can navigate.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'index.html'), '<fresh>')

      const repo = new Repo()
      const sub = await fileSync(repo, dir, dataDir)
      try {
        assert.equal(repo.get('files', 'index.html'), '<fresh>')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // ── mounts: materialization onto disk (read-only one-way) ────────────────

  /**
   * A minimal in-memory registry stub matching the get(key) shape
   * fileSync's mount resolver uses.
   */
  function makeStubRegistry (entries) {
    const map = new Map(entries)
    return { get: k => map.get(k) }
  }
  const KEY_A = 'a'.repeat(66)
  const KEY_B = 'b'.repeat(66)
  const KEY_C = 'c'.repeat(66)

  /** Build a sealed Repo with a single commit of the given value. */
  function sealedRepo (value, msg = 'seed') {
    const r = new Repo()
    const w = r.checkout()
    w.set(value)
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

  test('mounts: edits to mounted paths do NOT commit to this repo (filter excludes them)', async ({ assert }) => {
    // Read-only semantics at the chain layer: the disk→repo watcher's
    // acceptsForCommit filter rejects events under any mount prefix,
    // so the mounted files never bleed into this repo's `files` key.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const b = sealedRepo({ files: { 'h.js': 'B-version' } })
      const a = sealedRepo({
        files: { 'main.js': 'mine' },
        mounts: { 'streamo/': { key: KEY_B } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
        pubkeyHex: KEY_A
      })
      try {
        assert.equal((await readFile(join(dir, 'streamo/h.js'), 'utf8')), 'B-version')
        const files = a.get('files')
        assert.ok(!('streamo/h.js' in files), 'mount file did NOT leak into own files')
        assert.deepEqual(Object.keys(files).sort(), ['main.js'])
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
      const b = new Repo()
      let w = b.checkout()
      w.set({ files: { 'x.txt': 'v1' } })
      b.commit(w, 'v1')
      const v1Addr = b.lastCommit.dataAddress
      w = b.checkout()
      w.set({ files: { 'x.txt': 'v2' } })
      b.commit(w, 'v2')

      const a = sealedRepo({
        files: { 'index.html': 'A' },
        mounts: { 'lib/': { key: KEY_B, dataAddress: v1Addr } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
        pubkeyHex: KEY_A
      })
      try {
        assert.equal((await readFile(join(dir, 'lib/x.txt'), 'utf8')), 'v1',
          'pinned mount should materialize v1, not the latest v2')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('mounts: cycle detection — A→B→A stops at the loop', async ({ assert }) => {
    // A mounts B at b/; B mounts A at a/. Materializing A should NOT
    // recurse infinitely. A's content at b/ should include B's content,
    // and B's a/ mount should be detected as cycling back to A and
    // stopped — so nothing materializes at b/a/.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const b = sealedRepo({
        files: { 'b-file.txt': 'B' },
        mounts: { 'a/': { key: KEY_A } }
      })
      const a = sealedRepo({
        files: { 'a-file.txt': 'A' },
        mounts: { 'b/': { key: KEY_B } }
      })
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
        pubkeyHex: KEY_A
      })
      try {
        assert.equal((await readFile(join(dir, 'a-file.txt'), 'utf8')), 'A')
        assert.equal((await readFile(join(dir, 'b/b-file.txt'), 'utf8')), 'B')
        let exists = false
        try { await readFile(join(dir, 'b/a/a-file.txt'), 'utf8'); exists = true } catch {}
        assert.ok(!exists, 'expected cycle detection — b/a/a-file.txt should NOT exist')
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

  test('mounts: editing a mounted path logs a banner and reverts the file', async ({ assert }) => {
    // Read-only enforcement: an edit to a mount path triggers a loud
    // console.error banner AND triggers a re-materialization that
    // overwrites the user's edit. The disk-resident bytes return to
    // the upstream mounted record's content.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const b = sealedRepo({ files: { 'h.js': 'UPSTREAM' } })
      const a = sealedRepo({
        files: { 'main.js': 'mine' },
        mounts: { 'streamo/': { key: KEY_B } }
      })
      // Capture console.error output so the test can assert the banner
      // fired without polluting test output.
      const origError = console.error
      const captured = []
      console.error = (...args) => captured.push(args.join(' '))
      const sub = await fileSync(a, dir, dataDir, {
        registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
        pubkeyHex: KEY_A
      })
      try {
        // Confirm initial materialization
        assert.equal((await readFile(join(dir, 'streamo/h.js'), 'utf8')), 'UPSTREAM')
        // parcel/watcher batches and delays events (especially on macOS
        // FSEvents under load). The initial create events fire some
        // hundreds of ms after subscribe; we need to wait for that
        // first batch to drain BEFORE tampering, otherwise our tamper
        // write can be batched with the initial creates and the
        // content-check sees UPSTREAM (the latest write) and decides
        // it isn't a real edit. The 600ms grace below is enough on
        // every platform we've observed; bump if a CI host flakes.
        await new Promise(r => setTimeout(r, 600))
        // User edits the mounted file
        await writeFile(join(dir, 'streamo/h.js'), 'tampered')
        // Wait for the watcher to fire, log, and re-materialize.
        // 5s deadline is generous; on a quiet machine it fires within
        // ~100ms, on a busy macOS host (running the full suite in
        // parallel) up to ~1.5s. Five seconds keeps the test honest
        // without ever being the slowest part of the suite.
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          if (captured.some(s => s.includes('WRITE TO MOUNTED PATH'))) {
            // Banner fired — give re-materialization a beat to land
            await new Promise(r => setTimeout(r, 100))
            break
          }
          await new Promise(r => setTimeout(r, 50))
        }
        assert.ok(captured.some(s => s.includes('WRITE TO MOUNTED PATH')),
          'expected banner to mention "WRITE TO MOUNTED PATH"')
        assert.ok(captured.some(s => s.includes('streamo/h.js')),
          'expected banner to name the affected path')
        assert.equal((await readFile(join(dir, 'streamo/h.js'), 'utf8')), 'UPSTREAM',
          'mount-path edit should have been reverted by re-materialization')
      } finally {
        console.error = origError
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('mounts: disabled when registry/pubkeyHex not provided (files-only)', async ({ assert }) => {
    // Backward compat: without registry+pubkeyHex options, mounts are
    // completely inert — nothing materializes, own files behave as
    // they always have.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const a = sealedRepo({
        files: { 'main.js': 'mine' },
        mounts: { 'streamo/': { key: KEY_B } }
      })
      const sub = await fileSync(a, dir, dataDir)
      try {
        assert.equal((await readFile(join(dir, 'main.js'), 'utf8')), 'mine')
        let exists = false
        try { await readFile(join(dir, 'streamo/h.js'), 'utf8'); exists = true } catch {}
        assert.ok(!exists, 'mount should NOT materialize without registry option')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // ── recordFile (streamo.json) sync — meta editor ─────────────────────────
  // Opt-in via `recordFile: true`. fileSync syncs a JSON file at the
  // folder root ↔ the record's value MINUS the `files` key. Lets users
  // edit `mounts`, `title`, etc. in their editor as plain JSON.

  test('recordFile: writes streamo.json on first sync when repo has meta', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const a = sealedRepo({
        files: { 'index.html': '<h1>x</h1>' },
        title: 'My App',
        mounts: { 'streamo/': { key: KEY_B } }
      })
      const sub = await fileSync(a, dir, dataDir, { recordFile: true })
      try {
        const raw = await readFile(join(dir, 'streamo.json'), 'utf8')
        const parsed = JSON.parse(raw)
        assert.equal(parsed.title, 'My App')
        assert.deepEqual(parsed.mounts, { 'streamo/': { key: KEY_B } })
        assert.ok(!('files' in parsed), 'streamo.json should NOT contain files key')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('recordFile: disk-wins when streamo.json exists and is newer than the commit', async ({ assert }) => {
    // Bootstrap path: user writes streamo.json with mounts/etc, fileSync
    // commits the meta into the record on first sync.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(
        join(dir, 'streamo.json'),
        JSON.stringify({
          title: 'Bootstrap',
          mounts: { 'lib/': { key: KEY_B } }
        }, null, 2)
      )

      const repo = new Repo()  // fresh, no prior commit
      const sub = await fileSync(repo, dir, dataDir, { recordFile: true })
      try {
        assert.equal(repo.get('title'), 'Bootstrap')
        assert.deepEqual(repo.get('mounts'), { 'lib/': { key: KEY_B } })
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('recordFile: streamo.json is a first-class file in value.files (mirrors top-level meta)', async ({ assert }) => {
    // Under the FolderRecord shape (9.0.0), streamo.json IS a file
    // in value.files — and its content mirrors value-top-level-minus-files.
    // The redundancy invariant lets the Record fully self-describe:
    // a git clone of the folder reproduces the value exactly.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'index.html'), '<page>')
      await writeFile(
        join(dir, 'streamo.json'),
        JSON.stringify({ title: 'Combined' }, null, 2)
      )

      const repo = new Repo()
      const sub = await fileSync(repo, dir, dataDir, { recordFile: true })
      try {
        assert.equal(repo.get('files', 'index.html'), '<page>')
        assert.equal(repo.get('title'), 'Combined')
        // streamo.json IS in value.files now; its content is the parsed meta
        const filesEntry = repo.get('files', 'streamo.json')
        assert.deepEqual(filesEntry, { title: 'Combined' },
          'value.files[streamo.json] holds the parsed meta')
        // Invariant: value.files[streamo.json] mirrors value-top-level-minus-files
        const topLevel = { ...repo.get() }
        delete topLevel.files
        assert.deepEqual(filesEntry, topLevel,
          'value.files[streamo.json] mirrors top-level meta')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('recordFile: a `files` key inside streamo.json is dropped with a warning', async ({ assert }) => {
    // streamo.json is for everything-except-files. If a `files` key
    // appears, it's user error or a bad import — ignore + warn.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(
        join(dir, 'streamo.json'),
        JSON.stringify({ title: 'OK', files: { 'should-not-land.txt': 'X' } }, null, 2)
      )
      const origWarn = console.warn
      const warnings = []
      console.warn = (...args) => warnings.push(args.join(' '))

      const repo = new Repo()
      const sub = await fileSync(repo, dir, dataDir, { recordFile: true })
      try {
        assert.equal(repo.get('title'), 'OK')
        // The bad files entry MUST NOT land — the file tree is authoritative
        const repoFiles = repo.get('files')
        assert.ok(!repoFiles || !('should-not-land.txt' in repoFiles),
          'files key from streamo.json must NOT bleed into the record')
        assert.ok(warnings.some(w => w.includes('files')),
          'expected a warning about the files key being ignored')
      } finally {
        console.warn = origWarn
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('recordFile: invalid JSON skips the commit (mid-edit grace)', async ({ assert }) => {
    // Saving mid-edit produces transient invalid JSON. fileSync should
    // warn and skip, not crash; next valid save commits cleanly.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'streamo.json'), '{ broken json oops')
      const origWarn = console.warn
      const warnings = []
      console.warn = (...args) => warnings.push(args.join(' '))

      const repo = new Repo()
      const sub = await fileSync(repo, dir, dataDir, { recordFile: true })
      try {
        // No commit; repo's value should still be undefined / empty
        assert.equal(repo.lastCommit, null, 'no commit on invalid streamo.json')
        assert.ok(warnings.some(w => w.includes('parse error')),
          'expected a parse-error warning')
      } finally {
        console.warn = origWarn
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('recordFile: disabled by default (no streamo.json appears)', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const a = sealedRepo({
        files: { 'index.html': '<x>' },
        mounts: { 'streamo/': { key: KEY_B } }
      })
      const sub = await fileSync(a, dir, dataDir)  // recordFile NOT set
      try {
        let exists = false
        try { await readFile(join(dir, 'streamo.json'), 'utf8'); exists = true } catch {}
        assert.ok(!exists, 'streamo.json should NOT appear without recordFile option')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('recordFile: editing streamo.json commits the updated meta', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const a = sealedRepo({
        files: { 'index.html': '<x>' },
        title: 'Original'
      })
      const sub = await fileSync(a, dir, dataDir, { recordFile: true })
      try {
        // Give parcel/watcher a beat to settle on initial materialization
        // before we tamper.
        await new Promise(r => setTimeout(r, 600))
        // User edits streamo.json
        await writeFile(
          join(dir, 'streamo.json'),
          JSON.stringify({ title: 'Edited', mounts: { 'lib/': { key: KEY_B } } }, null, 2) + '\n'
        )
        // Wait for the watcher to commit
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          if (a.get('title') === 'Edited') break
          await new Promise(r => setTimeout(r, 50))
        }
        assert.equal(a.get('title'), 'Edited', 'meta should commit')
        assert.deepEqual(a.get('mounts'), { 'lib/': { key: KEY_B } })
        // files key preserved
        assert.equal(a.get('files', 'index.html'), '<x>')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // ── meta strategy: merge (default) vs replace ────────────────────────────
  // `meta: 'merge'` (default) spreads the file's keys into the existing
  // value — keys set by other writers (seed steps, code) survive.
  // `meta: 'replace'` mirrors the file literally — absent keys are removed.

  test('recordFile + meta:merge — keys set by code coexist with keys from streamo.json', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      // Pre-existing Record has code-set meta the file doesn't know about.
      const repo = sealedRepo({ journalists: ['alice', 'bob'] }, 'code seed')
      // Disk: streamo.json declares mounts ONLY (no journalists key).
      await writeFile(
        join(dir, 'streamo.json'),
        JSON.stringify({ mounts: { 'lib/': { key: KEY_B } } }, null, 2)
      )
      const sub = await fileSync(repo, dir, dataDir, { recordFile: true })  // meta default = merge
      try {
        // Both intents coexist on the Record's value.
        assert.deepEqual(repo.get('journalists'), ['alice', 'bob'], 'code-set journalists preserved')
        assert.deepEqual(repo.get('mounts'), { 'lib/': { key: KEY_B } }, 'streamo.json mounts merged in')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('recordFile + meta:merge — explicit `key: null` in streamo.json removes the key', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const repo = sealedRepo({ title: 'Old', journalists: ['alice'] })
      await writeFile(
        join(dir, 'streamo.json'),
        JSON.stringify({ title: null, mounts: { 'lib/': { key: KEY_B } } }, null, 2)
      )
      const sub = await fileSync(repo, dir, dataDir, { recordFile: true })
      try {
        assert.equal(repo.get('title'), undefined, 'title: null removed the key')
        assert.deepEqual(repo.get('journalists'), ['alice'], 'other code-set keys preserved')
        assert.deepEqual(repo.get('mounts'), { 'lib/': { key: KEY_B } })
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('recordFile + meta:replace — keys absent from streamo.json are removed from the Record', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const repo = sealedRepo({ title: 'Old', journalists: ['alice'] })
      await writeFile(
        join(dir, 'streamo.json'),
        JSON.stringify({ mounts: { 'lib/': { key: KEY_B } } }, null, 2)
      )
      const sub = await fileSync(repo, dir, dataDir, { recordFile: true, meta: 'replace' })
      try {
        // 'replace' is the strict-file-as-truth mode: title and journalists
        // are absent from streamo.json, so they're gone from the Record.
        assert.equal(repo.get('title'), undefined)
        assert.equal(repo.get('journalists'), undefined)
        assert.deepEqual(repo.get('mounts'), { 'lib/': { key: KEY_B } })
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // ── invariant: value.files[recordFile] mirrors top-level meta ────────────
  // (the FolderRecord redundancy invariant — fileSync maintains it)

  test('recordFile: sealed-Repo with top-level meta heals invariant on first sync (init)', async ({ assert }) => {
    // A Repo created by code (sealedRepo here) has top-level meta but
    // no streamo.json in value.files yet. fileSync's init runs a heal
    // commit so value.files[recordFile] mirrors top-level meta. After
    // init, the on-disk streamo.json reflects the full meta.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const a = sealedRepo({
        files: { 'index.html': '<page>' },
        title: 'Hello',
        mounts: { 'lib/': { key: KEY_B } }
      })
      // Sanity: invariant violated at start (no streamo.json in files yet)
      assert.equal(a.get('files', 'streamo.json'), undefined, 'precondition: streamo.json absent from files')

      const sub = await fileSync(a, dir, dataDir, { recordFile: true })
      try {
        // Invariant holds after init
        const filesEntry = a.get('files', 'streamo.json')
        assert.ok(filesEntry, 'streamo.json now in value.files')
        const topLevel = { ...a.get() }
        delete topLevel.files
        assert.deepEqual(filesEntry, topLevel)
        // On-disk streamo.json reflects the full meta
        const raw = await readFile(join(dir, 'streamo.json'), 'utf8')
        const parsed = JSON.parse(raw)
        assert.equal(parsed.title, 'Hello')
        assert.deepEqual(parsed.mounts, { 'lib/': { key: KEY_B } })
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('recordFile: code-driven set() that bypasses fileSync auto-heals invariant via flushToDisk', async ({ assert }) => {
    // Simulates the chat/server.js seed-step pattern: code does
    // server.streamo.set({...current, mounts: newM}) directly. That
    // updates top-level meta but leaves value.files[streamo.json] stale.
    // flushToDisk's heal commits a fix-up; the invariant restores.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const a = sealedRepo({
        files: { 'index.html': '<page>', 'streamo.json': { title: 'Old' } },
        title: 'Old'
      })

      const sub = await fileSync(a, dir, dataDir, { recordFile: true })
      try {
        // Confirm starting state
        assert.deepEqual(a.get('files', 'streamo.json'), { title: 'Old' })

        // Code-driven update: bump top-level title; do NOT touch value.files
        const current = a.get()
        const working = a.checkout()
        working.set({ ...current, title: 'New', mounts: { 'x/': { key: KEY_B } } })
        a.commit(working, 'code-driven meta update (bypassing fileSync)')

        // Wait for flushToDisk's heal-on-commit-watcher to converge
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const f = a.get('files', 'streamo.json')
          if (f && f.title === 'New' && f.mounts) break
          await new Promise(r => setTimeout(r, 50))
        }
        const healed = a.get('files', 'streamo.json')
        assert.equal(healed?.title, 'New', 'heal updated value.files[streamo.json].title')
        assert.deepEqual(healed?.mounts, { 'x/': { key: KEY_B } }, 'heal updated value.files[streamo.json].mounts')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  test('meta strategy: rejects unknown values', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const repo = new Repo()
      await assert.rejects(
        () => fileSync(repo, dir, dataDir, { recordFile: true, meta: 'splice' }),
        /must be 'merge' or 'replace'/
      )
    } finally {
      await cleanup()
    }
  })
})
