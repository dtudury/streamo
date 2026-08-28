import { describe } from './utils/testing.js'
import { Recaller } from './utils/Recaller.js'
import { Signer } from './Signer.js'
import { Hub } from './Hub.js'

const K1 = '11'.repeat(33)
const K2 = '22'.repeat(33)
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

describe(import.meta.url, ({ test }) => {
  test('each consumer wakes for exactly what it read', async ({ assert }) => {
    const recaller = new Recaller('hub-grain')
    const hub = new Hub({ recaller, upstream: { want: async () => {} } })
    const signer = new Signer('user', 'pass', 1000)

    let readsK1 = 0
    let countsKeys = 0
    let readsEveryKey = 0
    recaller.watch('reads-K1', () => { hub.current(K1); readsK1++ })
    recaller.watch('counts-keys', () => { [...hub.keys()].length; countsKeys++ })
    recaller.watch('reads-every-key', () => { for (const key of hub.keys()) hub.current(key); readsEveryKey++ })
    await settle()

    await hub.want(K1)
    await settle()
    const [k1, keys, every] = [readsK1, countsKeys, readsEveryKey]

    await hub.want(K2)
    await settle()
    assert.equal(readsK1, k1, 'a new key is not the business of a view reading one other key')
    assert.equal(countsKeys, keys + 1, 'but it is membership, so the counter wakes')
    assert.equal(readsEveryKey, every + 1, 'and so does the renderer')

    // Settled between the two, because the recaller batches: checkout and
    // discard in one tick flush as a single fire, which would pass an
    // assertion about "both" while proving only one.
    hub.checkout(K2, signer, 'home')
    await settle()
    assert.equal(readsEveryKey, every + 2, 'the renderer read K2, so K2 getting a draft wakes it')

    hub.discard(K2)
    await settle()
    assert.equal(readsEveryKey, every + 3, 'and discarding it wakes the renderer again')
    assert.equal(readsK1, k1, 'K2 drafting and discarding is still not K1 business')
    assert.equal(countsKeys, keys + 1, 'and a draft is not membership, so the counter stays put')

    hub.checkout(K1, signer, 'home')
    await settle()
    assert.equal(readsK1, k1 + 1, 'and K1 own draft wakes its view exactly once')
  })

  test('canon cannot author, and only upstream can reach it', async ({ assert }) => {
    const recaller = new Recaller('hub-canon')
    const upstream = { want: async () => {} }
    const hub = new Hub({ recaller, upstream })

    const canon = hub.receive(K1, upstream)
    assert.equal(canon.isAuthorable, false, 'canon is a plain record and cannot invent a commit')
    assert.equal(hub.current(K1), canon, 'and current falls through to it with no draft')

    let threw = null
    try { hub.receive(K1, { imposter: true }) } catch (error) { threw = error }
    assert.ok(threw, 'a Sync that is not upstream cannot reach canon')
  })

  test('a draft needs a signer, and current switches to it', async ({ assert }) => {
    const recaller = new Recaller('hub-draft')
    const hub = new Hub({ recaller, upstream: { want: async () => {} } })
    const signer = new Signer('user', 'pass', 1000)
    await hub.want(K1)

    let threw = null
    try { hub.checkout(K1, null) } catch (error) { threw = error }
    assert.ok(threw, 'authoring is can-you-sign, asked at checkout')

    const draft = hub.checkout(K1, signer, 'home')
    assert.equal(draft.isAuthorable, true)
    assert.equal(hub.current(K1), draft, 'current prefers the draft')
    hub.discard(K1)
    assert.equal(hub.current(K1), hub.get(K1), 'and falls back to canon when it is discarded')
  })

  test('forget removes a key, and both kinds of watcher notice', async ({ assert }) => {
    const recaller = new Recaller('hub-forget')
    const hub = new Hub({ recaller, upstream: { want: async () => {} } })
    let listed = []
    let readsK2 = 0
    recaller.watch('lists-keys', () => { listed = [...hub.keys()] })
    recaller.watch('reads-K2', () => { hub.current(K2); readsK2++ })
    await hub.want(K1)
    await hub.want(K2)
    await settle()
    assert.equal(listed.length, 2, 'both keys listed')
    const before = readsK2

    assert.equal(hub.forget(K2), true)
    await settle()
    assert.deepEqual(listed, [K1], 'the list watcher shows the correct list afterwards')
    assert.equal(readsK2, before + 1, 'and a view of that key wakes to find it gone')
    assert.equal(hub.current(K2), undefined)
    assert.equal(hub.forget(K2), false, 'forgetting twice is not an event')
  })
})
