import { describe } from './utils/testing.js'
import { Recaller } from './utils/Recaller.js'
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
})
