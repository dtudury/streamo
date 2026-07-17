import { describe } from './utils/testing.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { Recaller } from './utils/Recaller.js'
import { Signer } from './Signer.js'
import { Draft } from './Draft.js'

describe('Draft (first-mile facade)', ({ test }) => {
  const SIGNER = new Signer('alice', 'hunter2', 1)

  async function makeWriter (name = 'draft-test') {
    const recaller = new Recaller('draft-test')
    const repo = new WritableStreamoRecord({ recaller })
    repo.attachSigner(SIGNER, name)
    return { repo, recaller }
  }

  test('Draft can be constructed from a WritableStreamoRecord with a signer', async ({ assert }) => {
    const { repo } = await makeWriter('c1')
    const draft = repo.newDraft()
    assert.ok(draft instanceof Draft, 'newDraft returns a Draft instance')
    assert.equal(draft.status, 'draft', 'initial status is draft')
    assert.ok(draft.parentChainHash, 'parent chainHash snapshot at construction')
  })

  test('Draft.set mutates pendingValue reactively', async ({ assert }) => {
    const { repo, recaller } = await makeWriter('c2')
    const draft = repo.newDraft()
    let notified = 0
    recaller.watch('test:pendingValue', () => {
      draft.pendingValue  // register dep
      notified++
    })
    const before = notified
    draft.set({ x: 42 })
    // Recaller mutations propagate asynchronously via microtask.
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(draft.pendingValue, { x: 42 }, 'pendingValue updated')
    assert.ok(notified > before, `watcher fired on set (before=${before}, after=${notified})`)
  })

  test('Draft.set with function updater applies to current pendingValue', async ({ assert }) => {
    const { repo } = await makeWriter('c3')
    const draft = repo.newDraft()
    draft.set({ x: 1 })
    draft.set(v => ({ ...v, y: 2 }))
    assert.deepEqual(draft.pendingValue, { x: 1, y: 2 }, 'updater received current pendingValue')
  })

  test('Draft.cancel transitions to cancelled; subsequent set throws', async ({ assert }) => {
    const { repo } = await makeWriter('c4')
    const draft = repo.newDraft()
    draft.cancel()
    assert.equal(draft.status, 'cancelled', 'status is cancelled')
    let threw = false
    try { draft.set({ x: 1 }) } catch { threw = true }
    assert.ok(threw, 'set throws after cancel')
  })

  test('Draft rejects construction from a non-Writable record', async ({ assert }) => {
    // A plain object shaped like a StreamoRecord but without checkout/commit
    const fakeMirror = {
      publicKeyHex: '02' + 'a'.repeat(64),
      committedChainHash: new Uint8Array(32),
      recaller: new Recaller('fake'),
      get: () => ({}),
      // No .commit(), no .checkout()
    }
    let threw = false
    try { new Draft(fakeMirror) } catch (e) {
      threw = true
      assert.ok(/Writable/.test(e.message), 'error names the Writable requirement')
    }
    assert.ok(threw, 'construction throws when mirror isn\'t Writable')
  })

  test('Draft.commit throws if trying to commit after cancel', async ({ assert }) => {
    const { repo } = await makeWriter('c5')
    const draft = repo.newDraft()
    draft.cancel()
    let threw = false
    try { await draft.commit({ message: 'test' }) } catch { threw = true }
    assert.ok(threw, 'commit throws after cancel')
  })
})
