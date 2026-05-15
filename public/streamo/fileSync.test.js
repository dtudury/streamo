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
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
  return { dir, dataDir, cleanup }
}

describe(import.meta.url, ({ test }) => {
  // ── legacy mode (no filesKey: value IS the files map) ────────────────────

  test('legacy mode: disk content commits as the whole repo value', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'page.html'), '<page>')

      const repo = new Repo()
      const sub = await fileSync(repo, dir, dataDir)
      try {
        assert.equal(repo.get('page.html'), '<page>')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })

  // ── filesKey: disk wins, siblings preserved ──────────────────────────────

  test('filesKey: disk content lands at the subkey; sibling state preserved', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'index.html'), '<h1>hi</h1>')

      const repo = new Repo()
      const working = repo.checkout()
      working.set({ members: ['alice'], journalists: ['bob'] })
      repo.commit(working, 'seed')

      const sub = await fileSync(repo, dir, dataDir, { filesKey: 'files' })
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

  test('filesKey: lastCommit exists but no files at key → disk still wins (does not wipe)', async ({ assert }) => {
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

      const sub = await fileSync(repo, dir, dataDir, { filesKey: 'files' })
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

  test('filesKey: repo wins when disk is empty but repo has files at the key', async ({ assert }) => {
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      const repo = new Repo()
      const working = repo.checkout()
      working.set({ files: { 'a.html': '<a>' }, members: ['alice'] })
      repo.commit(working, 'seed with files')

      // Pretend disk content is older
      await new Promise(r => setTimeout(r, 30))

      const sub = await fileSync(repo, dir, dataDir, { filesKey: 'files' })
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

  test('filesKey: fresh repo (no prior commit) + disk content → committed at subkey', async ({ assert }) => {
    // No seed, no prior commits.  setRepoFiles must materialize the
    // wrapping object before path-set can navigate.
    const { dir, dataDir, cleanup } = await makeSandbox()
    try {
      await writeFile(join(dir, 'index.html'), '<fresh>')

      const repo = new Repo()
      const sub = await fileSync(repo, dir, dataDir, { filesKey: 'files' })
      try {
        assert.equal(repo.get('files', 'index.html'), '<fresh>')
      } finally {
        await sub.unsubscribe()
      }
    } finally {
      await cleanup()
    }
  })
})
