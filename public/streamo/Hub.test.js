import { describe } from './utils/testing.js'
import { Recaller } from './utils/Recaller.js'
import { Signer } from './Signer.js'
import { Hub } from './Hub.js'

const K1 = '11'.repeat(33)
const K2 = '22'.repeat(33)
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

describe(import.meta.url, ({ test }) => {
  test('a view of one key does not wake when a different key appears', async ({ assert }) => {
    const recaller = new Recaller('hub-grain')
    const hub = new Hub({ recaller })

    let readsK1 = 0
    let countsKeys = 0
    recaller.watch('reads-K1', () => { hub.get(K1); readsK1++ })
    recaller.watch('counts-keys', () => { [...hub.keys()].length; countsKeys++ })
    await settle()

    hub.want(K1)
    await settle()
    const [k1, keys] = [readsK1, countsKeys]

    hub.want(K2)
    await settle()
    assert.equal(readsK1, k1, 'K2 appearing is not the business of a view reading K1')
    assert.equal(countsKeys, keys + 1, 'but it is membership, so the counter wakes')
  })

  test('want is synchronous, and is the only thing that creates a slot', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-want') })
    assert.equal(hub.get(K1), undefined, 'get does not create — undefined means not yet')
    const record = hub.want(K1)
    assert.equal(record, hub.get(K1), 'want returns the record it made')
    assert.equal(record, hub.want(K1), 'and asking twice is the same record')
    assert.equal(record.isAuthorable, false, 'canon is a plain record and cannot invent a commit')
    assert.equal(typeof record.then, 'undefined', 'no promise: nothing here is async')
  })

  test('_materialize hands the socket syncs a Mirror over the same record', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-compat') })
    const mirror = hub._materialize(K1)
    assert.equal(mirror.local, hub.get(K1))
    assert.equal(mirror.publicKeyHex, K1)
    assert.equal(mirror, hub._materialize(K1), 'cached, so a second subscribe gets the same one')
  })

  test('watching canon does not wake on a draft, and watching a draft does not wake on canon', async ({ assert }) => {
    const recaller = new Recaller('hub-slots')
    const hub = new Hub({ recaller })
    const signer = new Signer('user', 'pass', 1000)

    let readsCanon = 0
    let readsDraft = 0
    let readsCurrent = 0
    recaller.watch('canon', () => { hub.get(K1); readsCanon++ })
    recaller.watch('draft', () => { hub.draftFor(K1); readsDraft++ })
    recaller.watch('current', () => { hub.current(K1); readsCurrent++ })
    await settle()

    hub.want(K1)
    await settle()
    const [canon, draft, current] = [readsCanon, readsDraft, readsCurrent]

    hub.checkout(K1, signer, 'home')
    await settle()
    assert.equal(readsCanon, canon, 'a Sync writing canon to disk does not wake because someone edited locally')
    assert.equal(readsDraft, draft + 1, 'the draft watcher does')
    assert.equal(readsCurrent, current + 1, 'and so does current, by composition')

    hub.discard(K1)
    await settle()
    assert.equal(readsCanon, canon, 'still not canon business')
    assert.equal(readsDraft, draft + 2)
    assert.equal(readsCurrent, current + 2)
  })

  test('a draft needs a signer, shares canon history, and current prefers it', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-draft') })
    const signer = new Signer('user', 'pass', 1000)
    const canon = hub.want(K1)

    let threw = null
    try { hub.checkout(K1, null) } catch (error) { threw = error }
    assert.ok(threw, 'authoring is can-you-sign, asked at checkout')

    const draft = hub.checkout(K1, signer, 'home')
    assert.equal(draft.isAuthorable, true)
    assert.equal(canon.isAuthorable, false, 'and canon still cannot author')
    assert.equal(hub.current(K1), draft, 'current prefers the draft')
    assert.equal(hub.checkout(K1, signer, 'home'), draft, 'checkout twice is the same draft')
    hub.discard(K1)
    assert.equal(hub.current(K1), canon, 'and falls back to canon once discarded')
  })

  test('upstream is installed by the wiring, and installing it wakes the Syncs', async ({ assert }) => {
    const recaller = new Recaller('hub-upstream')
    const hub = new Hub({ recaller })
    const folder = { name: 'a fileSync' }

    let iAmUpstream = null
    let runs = 0
    recaller.watch('a-sync', () => { iAmUpstream = hub.upstream === folder; runs++ })
    await settle()
    assert.equal(iAmUpstream, false, 'a Sync that is not upstream yet does nothing this run')
    const before = runs

    hub.upstream = folder
    await settle()
    assert.equal(runs, before + 1, 'installing upstream is a mutation, so the Sync re-runs')
    assert.equal(iAmUpstream, true, 'and finds it is the one — no two-phase start, no race')
  })

  test('only upstream can write canon, and there is only one of it', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-receive') })
    const folder = { name: 'a fileSync' }
    const socket = { name: 'a registrySync' }

    let threw = null
    try { hub.receive(K1, folder) } catch (error) { threw = error }
    assert.ok(threw, 'nothing writes canon before an upstream is installed')

    hub.upstream = folder
    assert.equal(hub.receive(K1, folder), hub.get(K1), 'upstream gets canon to append into')

    threw = null
    try { hub.receive(K1, socket) } catch (error) { threw = error }
    assert.ok(threw, 'and a different Sync still cannot')

    threw = null
    try { hub.upstream = socket } catch (error) { threw = error }
    assert.ok(threw, 'installing a second upstream is the wiring error, so it is loud')

    hub.upstream = null
    hub.upstream = socket
    assert.equal(hub.upstream, socket, 'released first, then reinstalled, is fine')
  })
})
