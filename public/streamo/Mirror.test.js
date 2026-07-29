import { describe } from './utils/testing.js'
import { Mirror } from './Mirror.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { Recaller } from './utils/Recaller.js'

describe('Mirror (scaffold)', ({ test }) => {
  const PUB = '02' + 'a'.repeat(64)

  test('constructor requires publicKeyHex + local', ({ assert }) => {
    const recaller = new Recaller('mirror-test-1')
    const local = new StreamoRecord({ recaller })

    let threwCount = 0
    try { new Mirror({}) } catch (e) {
      threwCount++
      assert.ok(/publicKeyHex/.test(e.message), 'error names publicKeyHex')
    }
    try { new Mirror({ publicKeyHex: PUB }) } catch (e) {
      threwCount++
      assert.ok(/local/.test(e.message), 'error names local')
    }
    assert.equal(threwCount, 2, 'both incomplete constructions threw')

    const mirror = new Mirror({ publicKeyHex: PUB, local })
    assert.equal(mirror.publicKeyHex, PUB, 'publicKeyHex stored')
    assert.equal(mirror.local, local, 'local stored')
    assert.equal(mirror.recaller, recaller, 'recaller defaulted from local')
  })

  test('constructor rejects non-StreamoRecord local', ({ assert }) => {
    let threw = false
    try {
      new Mirror({ publicKeyHex: PUB, local: { fake: true } })
    } catch (e) {
      threw = true
      assert.ok(/StreamoRecord/.test(e.message), 'error names StreamoRecord requirement')
    }
    assert.ok(threw, 'threw for non-StreamoRecord local')
  })

  test('remoteLength is reactive', async ({ assert }) => {
    const recaller = new Recaller('mirror-test-2')
    const local = new StreamoRecord({ recaller })
    const mirror = new Mirror({ publicKeyHex: PUB, local })

    assert.equal(mirror.remoteLength, 0, 'starts at 0')

    let notified = 0
    recaller.watch('test:remoteLength', () => {
      mirror.remoteLength // register dep
      notified++
    })
    const before = notified

    mirror.remoteLength = 42
    // Recaller mutations propagate asynchronously via microtask.
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(mirror.remoteLength, 42, 'value updated')
    assert.ok(notified > before, `watcher fired (before=${before}, after=${notified})`)
  })

  test('remoteLength refuses to move backward', ({ assert }) => {
    const recaller = new Recaller('mirror-test-3')
    const local = new StreamoRecord({ recaller })
    const mirror = new Mirror({ publicKeyHex: PUB, local })

    mirror.remoteLength = 100
    let threw = false
    try { mirror.remoteLength = 50 } catch (e) {
      threw = true
      assert.ok(/backward/.test(e.message), 'error names backward-move')
    }
    assert.ok(threw, 'refused backward move')
    assert.equal(mirror.remoteLength, 100, 'value unchanged after refused set')
  })

  test('remoteLength rejects non-numeric or negative', ({ assert }) => {
    const recaller = new Recaller('mirror-test-4')
    const local = new StreamoRecord({ recaller })
    const mirror = new Mirror({ publicKeyHex: PUB, local })

    let count = 0
    for (const bad of [-1, 'foo', null, undefined, NaN]) {
      try { mirror.remoteLength = bad } catch { count++ }
    }
    assert.equal(count, 5, 'all invalid values threw')
  })

  test('divergence cell + acknowledge cycle', async ({ assert }) => {
    const recaller = new Recaller('mirror-test-5')
    const local = new StreamoRecord({ recaller })
    const mirror = new Mirror({ publicKeyHex: PUB, local })

    assert.equal(mirror.divergence, null, 'starts null')

    let notified = 0
    recaller.watch('test:divergence', () => {
      mirror.divergence // register dep
      notified++
    })
    const before = notified

    const preClone = new StreamoRecord({ recaller: new Recaller('preclone') })
    const wireBytes = new Uint8Array([1, 2, 3])
    mirror.reportDivergence({ preClone, wireBytes, atRemoteLength: 42 })

    await new Promise(resolve => setTimeout(resolve, 0))

    const d = mirror.divergence
    assert.ok(d, 'divergence set')
    assert.equal(d.atRemoteLength, 42, 'atRemoteLength preserved')
    assert.equal(d.preClone, preClone, 'preClone preserved')
    assert.equal(d.wireBytes, wireBytes, 'wireBytes preserved')
    assert.equal(typeof d.acknowledge, 'function', 'acknowledge is a function')
    assert.ok(notified > before, 'watcher fired on reportDivergence')

    const midpoint = notified
    d.acknowledge()
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(mirror.divergence, null, 'cleared after acknowledge')
    assert.ok(notified > midpoint, 'watcher fired on clear')
  })

  test('isAuthorable reflects local type', ({ assert }) => {
    const recaller = new Recaller('mirror-test-6')
    const slim = new StreamoRecord({ recaller })
    const writable = new WritableStreamoRecord({ recaller })

    const slimMirror = new Mirror({ publicKeyHex: PUB, local: slim })
    const writableMirror = new Mirror({ publicKeyHex: PUB, local: writable })

    assert.equal(slimMirror.isAuthorable, false, 'slim StreamoRecord: not authorable')
    assert.equal(writableMirror.isAuthorable, true, 'WritableStreamoRecord: authorable')
  })
})
