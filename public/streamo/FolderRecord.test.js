import { describe } from './utils/testing.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { StreamoRecordRegistry } from './StreamoRecordRegistry.js'
import { Recaller } from './utils/Recaller.js'
import { FolderRecord } from './FolderRecord.js'
import { commitWithRetry } from './Draft.js'

const PK_A = '02' + 'a'.repeat(64)
const PK_B = '02' + 'b'.repeat(64)
const PK_C = '02' + 'c'.repeat(64)
const PK_D = '02' + 'd'.repeat(64)

// Test ergonomics: accepts the legacy { files: {...} } fixture shape and
// translates to flat-shape storage (filenames at top level).
// See [[the-flatten-arc-2026-06-04]].
function commit (repo, value) {
  let next = value
  if (value && value.files) {
    const { files, ...rest } = value
    next = { ...rest, ...files }
  }
  const working = repo.checkout()
  working.set(next)
  repo.commit(working, 'test')
  return repo
}

describe(import.meta.url, ({ test }) => {
  async function setup (perKey, rootKey = PK_A) {
    const recaller = new Recaller('test')
    const registry = new StreamoRecordRegistry({
      recaller,
      factory: async (key) => {
        const repo = new WritableStreamoRecord({ recaller })
        const value = perKey[key]
        if (value !== undefined) commit(repo, value)
        return repo
      }
    })
    const root = await registry._materialize(rootKey)
    return { registry, root }
  }

  test('files() returns {} for an empty record', async ({ assert }) => {
    const recaller = new Recaller('test')
    const registry = new StreamoRecordRegistry({
      recaller,
      factory: () => new WritableStreamoRecord({ recaller })
    })
    const repo = await registry._materialize(PK_A)
    const f = new FolderRecord(repo, registry)
    assert.deepEqual(f.files(), {})
  })

  test('files() returns the files map', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: { files: { 'index.html': '<root>', 'a.txt': 'aaa' } }
    })
    const f = new FolderRecord(root, registry)
    assert.deepEqual(f.files(), { 'index.html': '<root>', 'a.txt': 'aaa' })
  })

  test('mounts() returns the parsed mounts table', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: {
        files: {
          'index.html': '<root>',
          'mounts.json': { mounts: { 'lib/': { key: PK_B } } }
        }
      }
    })
    const f = new FolderRecord(root, registry)
    assert.deepEqual(f.mounts(), { 'lib/': { key: PK_B } })
  })

  test('mounts() returns {} when no mounts.json file', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: { files: { 'index.html': '<root>' } }
    })
    const f = new FolderRecord(root, registry)
    assert.deepEqual(f.mounts(), {})
  })

  test('resolvePath finds a direct file', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: { files: { 'index.html': '<root>' } }
    })
    const result = await new FolderRecord(root, registry).resolvePath('index.html')
    assert.equal(result, '<root>')
  })

  test('resolvePath returns null on miss', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: { files: { 'index.html': '<root>' } }
    })
    const result = await new FolderRecord(root, registry).resolvePath('missing.txt')
    assert.equal(result, null)
  })

  test('resolvePath follows a mount to another record', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: {
        files: {
          'index.html': '<root>',
          'mounts.json': { mounts: { 'lib/': { key: PK_B } } }
        }
      },
      [PK_B]: { files: { 'foo.txt': 'mounted-foo' } }
    })
    const result = await new FolderRecord(root, registry).resolvePath('lib/foo.txt')
    assert.equal(result, 'mounted-foo')
  })

  test('resolvePath prefers longest-prefix mount match', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: {
        files: {
          'index.html': '<root>',
          'mounts.json': {
            mounts: {
              'lib/': { key: PK_B },
              'lib/v1/': { key: PK_C }
            }
          }
        }
      },
      [PK_B]: { files: { 'v2/foo.txt': 'from-B' } },
      [PK_C]: { files: { 'foo.txt': 'from-C' } }
    })
    const fromC = await new FolderRecord(root, registry).resolvePath('lib/v1/foo.txt')
    assert.equal(fromC, 'from-C')
    const fromB = await new FolderRecord(root, registry).resolvePath('lib/v2/foo.txt')
    assert.equal(fromB, 'from-B')
  })

  test('resolvePath does files-first when path matches both directly and via mount', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: {
        files: {
          'lib/hit.txt': 'direct-hit',
          'mounts.json': { mounts: { 'lib/': { key: PK_B } } }
        }
      },
      [PK_B]: { files: { 'hit.txt': 'mount-hit' } }
    })
    const result = await new FolderRecord(root, registry).resolvePath('lib/hit.txt')
    assert.equal(result, 'direct-hit')
  })

  test('resolvePath detects cycles (A→B→A) and returns null', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: {
        files: { 'mounts.json': { mounts: { 'b/': { key: PK_B } } } }
      },
      [PK_B]: {
        files: { 'mounts.json': { mounts: { 'a/': { key: PK_A } } } }
      }
    })
    const result = await new FolderRecord(root, registry).resolvePath('b/a/nothing.txt')
    assert.equal(result, null)
  })

  test('resolvePath returns null when mount target has malformed key', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: {
        files: { 'mounts.json': { mounts: { 'lib/': { key: 'not-hex' } } } }
      }
    })
    const result = await new FolderRecord(root, registry).resolvePath('lib/foo.txt')
    assert.equal(result, null)
  })

  test('resolvePath handles nested mounts (A→B→C)', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: {
        files: { 'mounts.json': { mounts: { 'b/': { key: PK_B } } } }
      },
      [PK_B]: {
        files: { 'mounts.json': { mounts: { 'c/': { key: PK_C } } } }
      },
      [PK_C]: {
        files: { 'leaf.txt': 'deep' }
      }
    })
    const result = await new FolderRecord(root, registry).resolvePath('b/c/leaf.txt')
    assert.equal(result, 'deep')
  })

  // ─── write — bounded primitive: commits to THIS Record only ───────────

  test('write commits value at top-level path', async ({ assert }) => {
    const repo = new WritableStreamoRecord({ recaller: new Recaller('w1') })
    const folder = new FolderRecord(repo)
    await folder.write('hello.txt', 'world')
    assert.equal(repo.get('hello.txt'), 'world')
  })

  test('write preserves siblings (spread-then-set shape)', async ({ assert }) => {
    const repo = new WritableStreamoRecord({ recaller: new Recaller('w2') })
    const folder = new FolderRecord(repo)
    await folder.write('a.txt', 'A')
    await folder.write('b.txt', 'B')
    assert.equal(repo.get('a.txt'), 'A')
    assert.equal(repo.get('b.txt'), 'B')
  })

  test('write accepts options.message (forwarded to repo.update)', async ({ assert }) => {
    const repo = new WritableStreamoRecord({ recaller: new Recaller('w3') })
    const folder = new FolderRecord(repo)
    await folder.write('greeting.txt', 'hi', { message: 'add greeting' })
    assert.equal(repo.lastCommit.message, 'add greeting')
  })

  test('write of object at .json path stores the parsed object', async ({ assert }) => {
    const repo = new WritableStreamoRecord({ recaller: new Recaller('w4') })
    const folder = new FolderRecord(repo)
    await folder.write('streamo.json', { title: 'home', count: 3 })
    assert.deepEqual(repo.get('streamo.json'), { title: 'home', count: 3 })
  })

  test('write throws when path falls under a mount (read-only)', async ({ assert }) => {
    const repo = new WritableStreamoRecord({ recaller: new Recaller('w5') })
    const w = repo.checkout()
    w.set({ 'mounts.json': { mounts: { 'apps/chat/': { key: PK_B } } } })
    repo.commit(w, 'seed mounts')
    const folder = new FolderRecord(repo)
    await assert.rejects(
      () => folder.write('apps/chat/index.html', '<html>'),
      /apps\/chat\/.*read-only.*we don't own/
    )
  })

  test('write throws when ours:true mount lacks {signer, signerName} on FolderRecord', async ({ assert }) => {
    const repo = new WritableStreamoRecord({ recaller: new Recaller('w6') })
    const w = repo.checkout()
    w.set({ 'mounts.json': { mounts: { 'apps/chat/': { key: PK_B, ours: true } } } })
    repo.commit(w, 'seed mounts')
    const folder = new FolderRecord(repo)  // no signer
    await assert.rejects(
      () => folder.write('apps/chat/messages.json', []),
      /ours:true mount.*pass \{signer, signerName\}/
    )
  })

  test('write recurses through ours:true mount via keysFor derivation', async ({ assert }) => {
    const { Signer } = await import('./Signer.js')
    const { bytesToHex } = await import('./utils.js')
    const recaller = new Recaller('w-cross')
    // Root signer + parent name. Child name = parentName + '/' + mountPrefix.
    const signer = new Signer('test-root', 'test-pwd', 1)  // 1 iteration for fast test
    const parentName = 'parent'
    const childName = parentName + '/sub/'
    const { publicKey: childPub } = await signer.keysFor(childName)
    const childKey = bytesToHex(childPub)

    // Registry with both Records — child must be Writable to accept attachSigner.
    const registry = new StreamoRecordRegistry({
      recaller,
      factory: async () => new WritableStreamoRecord({ recaller })
    })
    // Materialize the child Record up-front (so it exists in registry).
    await registry._materialize(childKey)

    // Build parent with mounts.json pointing at the derived child key.
    const parent = await registry._materialize(PK_A)
    const w = parent.checkout()
    w.set({ 'mounts.json': { mounts: { 'sub/': { key: childKey, ours: true } } } })
    parent.commit(w, 'seed parent mounts')

    // FolderRecord with signer + signerName — enables cross-Record write.
    const folder = new FolderRecord(parent, registry, { signer, signerName: parentName })
    await folder.write('sub/hello.txt', 'world!')

    // Child Record should now hold the file.
    const child = await registry._materialize(childKey)
    assert.equal(child.get('hello.txt'), 'world!', 'cross-Record write landed in child')
    assert.equal(parent.get('hello.txt'), undefined, 'did not touch parent')
  })

  test('write throws when ours:true mount points at wrong pubkey (derivation mismatch)', async ({ assert }) => {
    const { Signer } = await import('./Signer.js')
    const recaller = new Recaller('w-mismatch')
    const signer = new Signer('test-root', 'test-pwd', 1)
    const registry = new StreamoRecordRegistry({
      recaller,
      factory: async () => new WritableStreamoRecord({ recaller })
    })
    const parent = await registry._materialize(PK_A)
    const w = parent.checkout()
    // mounts.json points at PK_B but the derived child would be different
    w.set({ 'mounts.json': { mounts: { 'apps/x/': { key: PK_B, ours: true } } } })
    parent.commit(w, 'seed wrong key')
    const folder = new FolderRecord(parent, registry, { signer, signerName: 'parent' })
    await assert.rejects(
      () => folder.write('apps/x/f.txt', 'hi'),
      /derived child pubkey.*doesn't match mount target.*different naming convention/
    )
  })

  test('write throws on a slim StreamoRecord (no author surface)', async ({ assert }) => {
    const { StreamoRecord } = await import('./StreamoRecord.js')
    const slim = new StreamoRecord()
    const folder = new FolderRecord(slim)
    await assert.rejects(
      () => folder.write('hello.txt', 'world'),
      /not Writable.*slim StreamoRecord/
    )
  })

  // ─── reactivity probe ─────────────────────────────────────────────────
  // David's hypothesis (2026-06-04 evening): "if you get something off of
  // a record that has no data and then it gets data, the function that
  // called the get should get queued to get called again." Proving the
  // substrate-is-already-reactive case before building the reactive
  // resolvePath on top of it.

  test('reactivity: record.get inside a watcher re-fires when value arrives', async ({ assert }) => {
    const recaller = new Recaller('reactive-record')
    const repo = new WritableStreamoRecord({ recaller })
    let calls = 0
    let lastValue
    recaller.watch('probe', () => {
      lastValue = repo.get('x')
      calls++
    })
    assert.equal(calls, 1, 'watcher fires once on register')
    assert.equal(lastValue, undefined, 'no data yet → undefined')
    await commitWithRetry(repo, v => ({ ...(v ?? {}), x: 'hello' }))
    // Recaller flushes asynchronously via nextTick — give it a beat.
    await new Promise(r => setTimeout(r, 0))
    assert.equal(calls, 2, 'watcher re-fired after value arrived')
    assert.equal(lastValue, 'hello', 'second call saw the new value')
  })

  test('reactivity: FolderRecord.files() inside a watcher re-fires on commit', async ({ assert }) => {
    const recaller = new Recaller('reactive-folder')
    const repo = new WritableStreamoRecord({ recaller })
    const folder = new FolderRecord(repo)
    let calls = 0
    let lastKeys = []
    recaller.watch('probe', () => {
      lastKeys = Object.keys(folder.files()).sort()
      calls++
    })
    assert.equal(calls, 1)
    assert.deepEqual(lastKeys, [], 'no files yet')
    await folder.write('hello.txt', 'world')
    await new Promise(r => setTimeout(r, 0))
    assert.equal(calls, 2)
    assert.deepEqual(lastKeys, ['hello.txt'], 'watcher saw the new file')
    await folder.write('world.txt', '!')
    await new Promise(r => setTimeout(r, 0))
    assert.equal(calls, 3)
    assert.deepEqual(lastKeys, ['hello.txt', 'world.txt'])
  })

  test('resolveReactive returns value for direct file + re-fires when value arrives', async ({ assert }) => {
    const recaller = new Recaller('rr-direct')
    const repo = new WritableStreamoRecord({ recaller })
    const folder = new FolderRecord(repo)
    let calls = 0
    let lastValue
    recaller.watch('probe', () => {
      lastValue = folder.resolveReactive('readme.md')
      calls++
    })
    assert.equal(calls, 1)
    assert.equal(lastValue, undefined, 'no commit yet → undefined')
    await folder.write('readme.md', '# hi')
    await new Promise(r => setTimeout(r, 0))
    assert.equal(calls, 2, 'watcher re-fired on commit')
    assert.equal(lastValue, '# hi', 'second call saw the new value')
  })

  test('resolveReactive returns undefined for unknown path (no mount, no file)', async ({ assert }) => {
    const recaller = new Recaller('rr-nope')
    const repo = new WritableStreamoRecord({ recaller })
    const folder = new FolderRecord(repo)
    assert.equal(folder.resolveReactive('does/not/exist.txt'), undefined)
  })

  test('resolveReactive walks a static mount synchronously when the mount target is already materialized', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: {
        files: {
          'mounts.json': { mounts: { 'lib/': { key: PK_B } } }
        }
      },
      [PK_B]: { files: { 'foo.txt': 'mounted-foo' } }
    })
    // Setup's factory only materializes on _materialize; pre-load PK_B
    // so the walk's registry.get hits sync.
    await registry._materialize(PK_B)
    const f = new FolderRecord(root, registry)
    assert.equal(f.resolveReactive('lib/foo.txt'), 'mounted-foo')
  })

  test('writeMany routes flat files to home Record (no mounts)', async ({ assert }) => {
    const repo = new WritableStreamoRecord({ recaller: new Recaller('wm1') })
    const folder = new FolderRecord(repo)
    await folder.writeMany({ 'a.txt': 'A', 'b.txt': 'B', 'sub/c.txt': 'C' })
    assert.equal(repo.get('a.txt'), 'A')
    assert.equal(repo.get('b.txt'), 'B')
    assert.equal(repo.get('sub/c.txt'), 'C')
  })

  test('writeMany with replace:true wipes prior siblings (mirror-disk semantics)', async ({ assert }) => {
    const repo = new WritableStreamoRecord({ recaller: new Recaller('wm2') })
    const folder = new FolderRecord(repo)
    await folder.writeMany({ 'a.txt': 'A', 'b.txt': 'B' })
    await folder.writeMany({ 'c.txt': 'C' }, { replace: true })
    assert.equal(repo.get('a.txt'), undefined, 'a.txt wiped')
    assert.equal(repo.get('b.txt'), undefined, 'b.txt wiped')
    assert.equal(repo.get('c.txt'), 'C', 'c.txt landed')
  })

  test('writeMany silently skips files under read-only mounts', async ({ assert }) => {
    const repo = new WritableStreamoRecord({ recaller: new Recaller('wm3') })
    const w = repo.checkout()
    w.set({ 'mounts.json': { mounts: { 'theirs/': { key: PK_B } } } })  // no ours:true
    repo.commit(w, 'seed')
    const folder = new FolderRecord(repo)
    await folder.writeMany({ 'mine.txt': 'M', 'theirs/x.txt': 'X' })
    assert.equal(repo.get('mine.txt'), 'M', 'home file landed')
    assert.equal(repo.get('theirs/x.txt'), undefined, 'read-only mount file skipped')
  })

  test('writeMany auto-shards: files under ours:true mounts route to derived child Records', async ({ assert }) => {
    const { Signer } = await import('./Signer.js')
    const { bytesToHex } = await import('./utils.js')
    const recaller = new Recaller('wm-auto')
    const signer = new Signer('test-root', 'test-pwd', 1)
    const parentName = 'parent'
    const childAName = parentName + '/apps/a/'
    const childBName = parentName + '/apps/b/'
    const { publicKey: cAPub } = await signer.keysFor(childAName)
    const { publicKey: cBPub } = await signer.keysFor(childBName)
    const cAKey = bytesToHex(cAPub)
    const cBKey = bytesToHex(cBPub)

    const registry = new StreamoRecordRegistry({
      recaller,
      factory: async () => new WritableStreamoRecord({ recaller })
    })
    await registry._materialize(cAKey)
    await registry._materialize(cBKey)
    const parent = await registry._materialize(PK_A)
    const w = parent.checkout()
    w.set({
      'mounts.json': {
        mounts: {
          'apps/a/': { key: cAKey, ours: true },
          'apps/b/': { key: cBKey, ours: true }
        }
      }
    })
    parent.commit(w, 'seed parent mounts')

    const folder = new FolderRecord(parent, registry, { signer, signerName: parentName })
    await folder.writeMany({
      'index.html':       '<html>home</html>',
      'apps/a/index.html': '<html>app a</html>',
      'apps/a/main.js':    'console.log("a")',
      'apps/b/index.html': '<html>app b</html>'
    })

    // home Record gets home files only
    assert.equal(parent.get('index.html'), '<html>home</html>')
    assert.equal(parent.get('apps/a/index.html'), undefined, 'shard files NOT in parent')
    // each shard gets its own files at the inner path
    const childA = await registry._materialize(cAKey)
    const childB = await registry._materialize(cBKey)
    assert.equal(childA.get('index.html'), '<html>app a</html>')
    assert.equal(childA.get('main.js'), 'console.log("a")')
    assert.equal(childB.get('index.html'), '<html>app b</html>')
  })

  test('resolveReactive returns undefined for pending mount target + watcher re-fires after materialization', async ({ assert }) => {
    const { root, registry } = await setup({
      [PK_A]: {
        files: {
          'mounts.json': { mounts: { 'lib/': { key: PK_B } } }
        }
      },
      [PK_B]: { files: { 'foo.txt': 'arrived!' } }
    })
    // PK_B is NOT pre-materialized — first call should return undefined,
    // then resolveReactive fires _materialize internally (fire-and-forget),
    // and the watcher should re-fire when PK_B lands.
    const recaller = registry.recaller
    const folder = new FolderRecord(root, registry)
    let calls = 0
    let lastValue
    recaller.watch('probe', () => {
      lastValue = folder.resolveReactive('lib/foo.txt')
      calls++
    })
    assert.equal(calls, 1)
    assert.equal(lastValue, undefined, 'PK_B not materialized yet → undefined')
    // _materialize was kicked off by resolveReactive; let it land.
    await new Promise(r => setTimeout(r, 10))
    assert.ok(calls >= 2, `watcher re-fired (calls=${calls})`)
    assert.equal(lastValue, 'arrived!', 'value arrived through the reactive walk')
  })

  test('reactivity: FolderRecord.mounts() inside a watcher re-fires when mounts.json is written', async ({ assert }) => {
    const recaller = new Recaller('reactive-mounts')
    const repo = new WritableStreamoRecord({ recaller })
    const folder = new FolderRecord(repo)
    let calls = 0
    let lastMounts = {}
    recaller.watch('probe', () => {
      lastMounts = folder.mounts()
      calls++
    })
    assert.equal(calls, 1)
    assert.deepEqual(lastMounts, {})
    await folder.write('mounts.json', { mounts: { 'lib/': { key: PK_B } } })
    await new Promise(r => setTimeout(r, 0))
    assert.equal(calls, 2)
    assert.deepEqual(lastMounts, { 'lib/': { key: PK_B } })
  })
})
