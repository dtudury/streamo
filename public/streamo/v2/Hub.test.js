import { describe } from '../utils/testing.js'
import { Recaller } from '../utils/Recaller.js'
import { Signer } from '../Signer.js'
import { Hub } from './Hub.js'
import { Streamo } from '../Streamo.js'
import { WritableStreamoRecord } from '../WritableStreamoRecord.js'

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

  })

  test('a draft needs a signer, shares canon history, and getCurrent prefers it', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-draft') })
    const signer = new Signer('user', 'pass', 1000)
    const canon = hub.getMirror(K1)

    let threw = null
    try { hub.checkout(K1, null) } catch (error) { threw = error }
    assert.ok(threw, 'authoring is can-you-sign, asked at checkout')

    const draft = hub.checkout(K1, signer, 'home')
    assert.equal(draft.isAuthorable, true)
    assert.equal(canon.isAuthorable, false, 'and canon still cannot')
    assert.equal(hub.checkout(K1, signer, 'home'), draft, 'checkout twice is the same draft')

    // getCurrent hands back a READER now, not the pen. It used to assert
    // identity with the draft; that was the old contract.
    const view = hub.getCurrent(K1)
    assert.notEqual(view, draft, 'getCurrent is a view, not the writable draft')
    assert.equal(view.isAuthorable, false, 'and it cannot author')
    assert.equal(hub.getCurrent(K1), view, 'the view is stable, so identity comparisons hold')

    draft.set({ edited: 'after checkout' })
    assert.equal(view.get('edited'), 'after checkout', 'the view tracks the draft it windows')
  })

  test('a second signer is refused the pen, and can still read', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-two-signers') })
    const mine = new Signer('user', 'pass', 1000)
    const theirs = new Signer('other', 'pass', 1000)

    const draft = hub.checkout(K1, mine, 'home')
    assert.equal(hub.checkout(K1, mine, 'home'), draft, 'the same author may check out again — canon can be slow')

    let threw = null
    try { hub.checkout(K1, theirs, 'elsewhere') } catch (error) { threw = error }
    assert.ok(threw, 'a different signer is refused rather than handed someone else\'s pen')
    assert.ok(/getDraft/.test(threw.message), 'and the refusal names what to use instead')
    assert.equal(hub.getDraft(K1).isAuthorable, false, 'reading never needed the pen')
  })

  test('_materialize hands the socket syncs a Mirror over the same record', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-compat') })
    const mirror = hub._materialize(K1)
    assert.equal(mirror.local, hub.getMirror(K1))
    assert.equal(mirror.publicKeyHex, K1)
    assert.equal(mirror, hub._materialize(K1), 'cached, so a second subscribe gets the same one')
  })

  test('the compat Mirror is cached because a Mirror holds wire state', async ({ assert }) => {
    const hub = new Hub({ recaller: new Recaller('hub-compat-state') })
    const compat = hub._materialize(K1)
    compat.remoteLength = 208
    assert.equal(hub._materialize(K1).remoteLength, 208,
      'a fresh Mirror per call would reset the wire cursor and lose divergence')
    assert.equal(hub._materialize(K1), compat, 'so identity has to be stable')
  })

  test('a draft continues canon chain instead of forking it', async ({ assert }) => {
    const signer = new Signer('user', 'pass', 1000)

    // Canon as it arrives from anywhere but our own draft: author in one hub,
    // land it, then carry the bytes into a second hub the way a socket does.
    const authoring = new Recaller('authoring')
    const source = new Hub({ recaller: authoring })
    const seed = source.checkout(K1, signer, 'home')
    const working = seed.checkout()
    working.set({ 'readme.md': 'canon\n' })
    seed.commit(working, 'seed')
    await authoring.when(() => seed.byteLength > 0 && seed.signedLength === seed.byteLength)
    const sourceCanon = source.getMirror(K1)
    const reader = seed.makeReadableStream({ fromOffset: 0 }).getReader()
    const writer = sourceCanon.makeWritableStream().getWriter()
    while (sourceCanon.byteLength < seed.byteLength) {
      const { value, done } = await reader.read()
      if (done) break
      await writer.write(value)
    }
    writer.releaseLock()
    reader.cancel().catch(() => {})

    const following = new Recaller('following')
    const hub = new Hub({ recaller: following })
    const canon = hub.getMirror(K1)
    const wireReader = sourceCanon.makeReadableStream({ fromOffset: 0 }).getReader()
    const wireWriter = canon.makeWritableStream().getWriter()
    while (canon.byteLength < sourceCanon.byteLength) {
      const { value, done } = await wireReader.read()
      if (done) break
      await wireWriter.write(value)
    }
    wireWriter.releaseLock()
    wireReader.cancel().catch(() => {})

    const draft = hub.checkout(K1, signer, 'home')
    assert.deepEqual(draft.committedChainHash, canon.committedChainHash, 'the draft is on canon chain, not a new one')
    assert.equal(draft.byteLength, canon.byteLength)
    assert.deepEqual(draft.get(), { 'readme.md': 'canon\n' }, 'and it can read the value it inherited')
    assert.equal(draft.resolve(canon.lastCommit.dataAddress), canon.resolve(canon.lastCommit.dataAddress),
      'seeded by clone, so the chunks are shared rather than copied')

    const next = draft.checkout()
    next.set({ ...draft.get(), 'added.md': 'later\n' })
    draft.commit(next, 'second')
    assert.ok(draft.lastCommit.parent >= 0, 'a commit on it extends the chain rather than starting one')
  })

  test('a view shares the store but not the write-side dedup, so _reset cannot strand it', async ({ assert }) => {
    const recaller = new Recaller('view-dedup')
    const origin = new Streamo({ recaller })
    origin.set({ hello: 'world' })
    const view = origin._applyView(new Streamo({ recaller }))

    const code = origin.resolve(origin.byteLength - 1)
    const address = origin.addressOf(code)
    assert.ok(address !== undefined, 'the origin dedups, because it writes')
    assert.equal(view.addressOf(code), undefined, 'the view does not, because it cannot')

    // Sharing #contentMap made this the failure: after _reset the view's
    // addressOf still answered with an address its own (shared, cleared)
    // store could no longer resolve — yes, then crash.
    origin._reset()
    assert.equal(view.addressOf(code), undefined, 'and still does not after a reset')
    assert.equal(view._chunks.length, 0, 'the cleared store is visible through the window')
  })

  test('_applyView refuses a target that can author', async ({ assert }) => {
    const recaller = new Recaller('view-refuses')
    const origin = new Streamo({ recaller })
    origin.set({ hello: 'world' })

    let threw = null
    try { origin._applyView(new WritableStreamoRecord({ recaller })) } catch (error) { threw = error }
    assert.ok(threw, 'two writers on one store is what checkout already refuses')
    assert.ok(/reader/.test(threw.message), 'and the refusal says what a view is')
  })
})
