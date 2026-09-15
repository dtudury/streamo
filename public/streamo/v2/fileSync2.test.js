import { mkdtemp, rm, writeFile, unlink, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe } from '../utils/testing.js'
import { Recaller } from '../utils/Recaller.js'
import { Signer } from '../Signer.js'
import { Hub } from './Hub.js'
import { fileSync2 } from './fileSync2.js'

const ROOT = 'aa'.repeat(33)
const CHILD = 'cd'.repeat(33)

async function sandbox ({ canSign = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fs2-test-'))
  const hub = new Hub({ recaller: new Recaller('fs2-test') })
  const signer = canSign ? new Signer('user', 'pass', 1000) : null
  const start = () => fileSync2({
    hub,
    rootKey: ROOT,
    folder: dir,
    signer,
    signerName: 'home',
    upstream: true
  })
  return {
    dir,
    hub,
    root: hub.getMirror(ROOT),
    child: hub.getMirror(CHILD),
    start,
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

// The parcel watcher batches; a change needs a beat to arrive and a beat to
// commit. `settled()` covers the commit half only.
const afterDiskEvent = async sync => {
  await new Promise(r => setTimeout(r, 300))
  await sync.settled()
}

describe(import.meta.url, ({ test }) => {
  test('the complete read commits every accepted file before anything is watched', async ({ assert }) => {
    const { dir, root, start, cleanup } = await sandbox()
    await writeFile(join(dir, 'readme.md'), '# hello\n')
    await writeFile(join(dir, 'data.json'), '{"a":1}\n')
    await writeFile(join(dir, 'secrets.env'), 'PASSWORD=x\n')
    const sync = await start()
    try {
      assert.equal(root.get('readme.md'), '# hello\n')
      assert.equal(root.get('data.json').a, 1, '.json arrives decoded, not as text')
      assert.equal(root.get('secrets.env'), undefined, '*.env is ignored by default')
    } finally {
      await sync.unsubscribe(); await cleanup()
    }
  })

  test('an edit commits a change, and a delete removes the key', async ({ assert }) => {
    const { dir, root, start, cleanup } = await sandbox()
    await writeFile(join(dir, 'readme.md'), '# hello\n')
    await writeFile(join(dir, 'data.json'), '{"a":1}\n')
    const sync = await start()
    try {
      await writeFile(join(dir, 'readme.md'), '# changed\n')
      await afterDiskEvent(sync)
      assert.equal(root.get('readme.md'), '# changed\n')

      await unlink(join(dir, 'data.json'))
      await afterDiskEvent(sync)
      assert.equal(root.get('data.json'), undefined, 'a file with no key behind it is a deletion')
      assert.equal(root.get('readme.md'), '# changed\n', 'and it takes nothing else with it')
    } finally {
      await sync.unsubscribe(); await cleanup()
    }
  })

  test('a file under a mount prefix belongs to the child, so the root never claims it', async ({ assert }) => {
    const { dir, root, start, cleanup } = await sandbox()
    await writeFile(join(dir, 'readme.md'), 'root file\n')
    await writeFile(join(dir, 'mounts.json'), JSON.stringify({ mounts: { 'child/': { key: CHILD, ours: true } } }) + '\n')
    await mkdir(join(dir, 'child'))
    await writeFile(join(dir, 'child', 'note.md'), 'the child owns this\n')
    const sync = await start()
    try {
      assert.equal(root.get('readme.md'), 'root file\n')
      assert.equal(root.get('child/note.md'), undefined)

      await writeFile(join(dir, 'child', 'note.md'), 'edited by someone else\n')
      await afterDiskEvent(sync)
      assert.equal(root.get('child/note.md'), undefined, 'and still does not claim it after an edit')
    } finally {
      await sync.unsubscribe(); await cleanup()
    }
  })

  test('a filesystem event for an unchanged file commits nothing', async ({ assert }) => {
    const { dir, root, start, cleanup } = await sandbox()
    await writeFile(join(dir, 'readme.md'), '# hello\n')
    const sync = await start()
    try {
      // byteLength, not dataAddress. The address is content-derived, so a
      // redundant commit of identical bytes lands at the same address and the
      // assertion passes either way — verified by mutation.
      const before = root.byteLength
      await writeFile(join(dir, 'readme.md'), '# hello\n')
      await afterDiskEvent(sync)
      assert.equal(root.byteLength, before,
        'the loop terminates on content equality, not on a suppression flag')
    } finally {
      await sync.unsubscribe(); await cleanup()
    }
  })

  test('with nothing that can sign, it does not throw and does not commit', async ({ assert }) => {
    const { dir, root: readOnly, start, cleanup } = await sandbox({ canSign: false })
    await writeFile(join(dir, 'readme.md'), '# hello\n')
    const sync = await start()
    try {
      assert.equal(readOnly.get('readme.md'), undefined, 'not authorable is a state, not a crash')
    } finally {
      await sync.unsubscribe(); await cleanup()
    }
  })
})
