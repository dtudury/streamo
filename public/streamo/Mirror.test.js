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

  // The receive stream is deliberately codec-blind — it compares bytes and
  // appends them. So these drive it with arbitrary payloads rather than
  // signed commits: anything else would be testing the codec too, and
  // hiding which layer a failure came from.
  const frame = (...payloads) => {
    const total = payloads.reduce((n, p) => n + 4 + p.length, 0)
    const out = new Uint8Array(total)
    const view = new DataView(out.buffer)
    let pos = 0
    for (const p of payloads) {
      view.setUint32(pos, p.length, true)
      pos += 4
      out.set(p, pos)
      pos += p.length
    }
    return out
  }
  const bytes = (...ns) => new Uint8Array(ns)

  const feed = async (mirror, framed) => {
    const writer = mirror.makeReceiveStream().getWriter()
    try {
      await writer.write(framed)
      await writer.close()
      return null
    } catch (error) {
      return error
    }
  }

  test('receive: wire bytes past local append and advance remoteLength', async ({ assert }) => {
    const recaller = new Recaller('mirror-receive-append')
    const local = new StreamoRecord({ recaller })
    const mirror = new Mirror({ publicKeyHex: PUB, local })

    const error = await feed(mirror, frame(bytes(1, 2, 3), bytes(4, 5)))

    assert.equal(error, null, 'clean append does not reject')
    assert.equal(local.byteLength, 5, 'both payloads landed')
    assert.equal(mirror.remoteLength, 5,
      'remoteLength counts payload bytes only — 5, not 13 with the two 4-byte prefixes')
    assert.equal(mirror.divergence, null)
  })

  test('receive: our own commit echoing back advances the cursor without re-appending', async ({ assert }) => {
    const recaller = new Recaller('mirror-receive-echo')
    const local = new StreamoRecord({ recaller })
    const mirror = new Mirror({ publicKeyHex: PUB, local })

    // Stand in for an unpushed local commit: bytes exist in local, and
    // remoteLength still says the wire hasn't confirmed them.
    local.append(bytes(1, 2, 3))
    assert.equal(local.byteLength, 3, 'local has unpushed bytes')
    assert.equal(mirror.remoteLength, 0, 'wire has confirmed nothing yet')

    const error = await feed(mirror, frame(bytes(1, 2, 3)))

    assert.equal(error, null)
    assert.equal(local.byteLength, 3, 'not appended twice')
    assert.equal(mirror.remoteLength, 3, 'cursor caught up to local')
    assert.equal(mirror.divergence, null)
  })

  test('receive: different bytes at an occupied position report divergence', async ({ assert }) => {
    const recaller = new Recaller('mirror-receive-diverge')
    const local = new StreamoRecord({ recaller })
    const mirror = new Mirror({ publicKeyHex: PUB, local })

    local.append(bytes(1, 2, 3))   // unpushed local commit
    const error = await feed(mirror, frame(bytes(9, 9, 9)))   // wire disagrees

    assert.ok(error, 'write rejects')
    assert.ok(/diverged/.test(error.message))
    assert.ok(mirror.divergence)
    assert.equal(mirror.divergence.atRemoteLength, 0, 'reports where the wire had confirmed to')
    assert.equal(mirror.divergence.preClone, local, 'hands back the pre-replacement local')
    assert.deepEqual([...mirror.divergence.wireBytes], [9, 9, 9])

    mirror.divergence.acknowledge()
    assert.equal(mirror.divergence, null)
  })

  test('receive: a frame split across two writes is reassembled', async ({ assert }) => {
    const recaller = new Recaller('mirror-receive-split')
    const local = new StreamoRecord({ recaller })
    const mirror = new Mirror({ publicKeyHex: PUB, local })

    const framed = frame(bytes(1, 2, 3, 4, 5))
    const writer = mirror.makeReceiveStream().getWriter()
    await writer.write(framed.subarray(0, 3))    // mid-length-prefix
    assert.equal(mirror.remoteLength, 0, 'nothing published from a partial prefix')
    await writer.write(framed.subarray(3))
    await writer.close()

    assert.equal(local.byteLength, 5, 'payload landed once')
    assert.equal(mirror.remoteLength, 5, 'cursor advanced after the frame completed')
  })
})
