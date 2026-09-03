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
    // hasMirror, not getMirror: a watcher that *gets* would create the key on
    // its own first run, and there would be no appearance left to observe.
    recaller.watch('reads-K1', () => { hub.hasMirror(K1); readsK1++ })
    recaller.watch('counts-keys', () => { [...hub.keys()].length; countsKeys++ })
    await settle()

    hub.getMirror(K1)
    await settle()
    const [k1, keys] = [readsK1, countsKeys]

    hub.getMirror(K2)
    await settle()
    assert.equal(readsK1, k1, 'K2 appearing is not the business of a view reading K1')
    assert.equal(countsKeys, keys + 1, 'but it is membership, so the counter wakes')
  })

  test('hasMirror asks, getMirror asks and wants, and the three states stay apart', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-lazy') })
    assert.equal(hub.hasMirror(K1), false, 'nobody has ever wanted this')
    assert.equal(hub.hasMirror(K1), false, 'and asking does not make it so')

    const canon = hub.getMirror(K1)
    assert.equal(hub.hasMirror(K1), true, 'reading it is wanting it')
    assert.equal(canon.lastCommit, null, 'wanted, and nothing has arrived — a different state from never asked')
    assert.equal(canon.isAuthorable, false, 'canon cannot author')
    assert.equal(hub.getMirror(K1), canon, 'and getting it again is the same record')
  })

  test('canon and draft are separate subjects, so watching one does not watch the other', async ({ assert }) => {
    const recaller = new Recaller('hub-slots')
    const hub = new Hub({ recaller })
    const signer = new Signer('user', 'pass', 1000)
    const upstream = { name: 'a fileSync' }
    const receiveInto = hub.installUpstream(upstream)

    let readsCanon = 0
    let readsDraft = 0
    recaller.watch('canon', () => { hub.getMirror(K1); readsCanon++ })
    recaller.watch('draft', () => { hub.getDraft(K1); readsDraft++ })
    hub.getMirror(K1)
    await settle()
    const [canon, draft] = [readsCanon, readsDraft]

    hub.checkout(K1, signer, 'home')
    await settle()
    assert.equal(readsCanon, canon, 'a Sync writing canon to disk does not wake because someone edited locally')
    assert.equal(readsDraft, draft + 1, 'the draft watcher does')

    receiveInto(K1)
    await settle()
    assert.equal(readsDraft, draft + 2, 'and canon moving drops the draft, which the draft watcher sees')
    assert.equal(hub.getDraft(K1), null)
  })

  test('a draft needs a signer, shares canon history, and getCurrent prefers it', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-draft') })
    const signer = new Signer('user', 'pass', 1000)
    const upstream = { name: 'a fileSync' }
    const receiveInto = hub.installUpstream(upstream)
    const canon = hub.getMirror(K1)

    let threw = null
    try { hub.checkout(K1, null) } catch (error) { threw = error }
    assert.ok(threw, 'authoring is can-you-sign, asked at checkout')

    const draft = hub.checkout(K1, signer, 'home')
    assert.equal(draft.isAuthorable, true)
    assert.equal(canon.isAuthorable, false, 'and canon still cannot')
    assert.equal(hub.getCurrent(K1), draft, 'getCurrent prefers the draft')
    assert.equal(hub.checkout(K1, signer, 'home'), draft, 'checkout twice is the same draft')

    receiveInto(K1)
    assert.equal(hub.getCurrent(K1), canon, 'canon moving retires the draft, so getCurrent falls back')
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

    hub.installUpstream(folder)
    await settle()
    assert.equal(runs, before + 1, 'installing upstream is a mutation, so the Sync re-runs')
    assert.equal(iAmUpstream, true, 'and finds it is the one — no two-phase start, no race')
  })

  test('writing canon is a capability, not a permission check', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-capability') })
    const folder = { name: 'a fileSync' }
    const socket = { name: 'a registrySync' }

    assert.equal(typeof hub.receive, 'undefined', 'there is no door to knock on')
    const receiveInto = hub.installUpstream(folder)
    assert.equal(receiveInto(K1), hub.getMirror(K1), 'the capability is the only way in')

    let threw = null
    try { hub.installUpstream(socket) } catch (error) { threw = error }
    assert.ok(threw, 'installing a second upstream is the wiring error, so it is loud')

    assert.equal(hub.releaseUpstream(socket), false, 'only the holder can release it')
    assert.equal(hub.releaseUpstream(folder), true)

    threw = null
    try { receiveInto(K2) } catch (error) { threw = error }
    assert.ok(threw, 'and a released capability goes dead rather than lingering')

    const second = hub.installUpstream(socket)
    assert.equal(second(K2), hub.getMirror(K2), 'released first, then reinstalled, is fine')
  })

  test('_materialize hands the socket syncs a Mirror over the same record', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-compat') })
    const mirror = hub._materialize(K1)
    assert.equal(mirror.local, hub.getMirror(K1))
    assert.equal(mirror.publicKeyHex, K1)
    assert.equal(mirror, hub._materialize(K1), 'cached, so a second subscribe gets the same one')
  })
})
