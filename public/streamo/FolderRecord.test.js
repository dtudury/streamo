import { describe } from './utils/testing.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { StreamoRecordRegistry } from './StreamoRecordRegistry.js'
import { Recaller } from './utils/Recaller.js'
import { FolderRecord } from './FolderRecord.js'

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
})
