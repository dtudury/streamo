import { test } from 'node:test'
import assert from 'node:assert'
import { Mirror } from './Mirror.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'
import { Recaller } from './utils/Recaller.js'

// A session stand-in with the two reactive cells awaitLanded reads. The real
// one lives in registrySync's closure and isn't constructible standalone;
// what matters here is that the cells are reactive, because awaitLanded is
// a recaller.watch and only re-runs when something it read mutates.
function fakeSession (recaller) {
  const cells = { pushRejected: null, conflictDetected: null }
  return {
    getPushRejected (k) { recaller.reportKeyAccess(cells, 'pushRejected'); return cells.pushRejected },
    getConflictDetected (k) { recaller.reportKeyAccess(cells, 'conflictDetected'); return cells.conflictDetected },
    arm (which, value) { cells[which] = value; recaller.reportKeyMutation(cells, which) }
  }
}

function mirrorWithSession () {
  const recaller = new Recaller('awaitLanded-test')
  const local = new WritableStreamoRecord({ recaller })
  const mirror = new Mirror({ publicKeyHex: 'ab'.repeat(32), local })
  const session = fakeSession(recaller)
  local._attachSession(session)
  return { mirror, local, session, recaller }
}

test('awaitLanded resolves when remoteLength reaches the target', async () => {
  const { mirror } = mirrorWithSession()
  const landed = mirror.awaitLanded(100)
  mirror.remoteLength = 40
  mirror.remoteLength = 100
  await landed // resolves, or the test times out
})

test('awaitLanded resolves when remoteLength passes the target', async () => {
  const { mirror } = mirrorWithSession()
  const landed = mirror.awaitLanded(100)
  mirror.remoteLength = 250
  await landed
})

test('awaitLanded rejects on pushRejected — the arm that survives the receive swap', async () => {
  const { mirror, session } = mirrorWithSession()
  const landed = mirror.awaitLanded(100)
  session.arm('pushRejected', { reason: 'beaten to the position' })
  const err = await landed.then(() => null, e => e)
  assert.ok(err, 'expected rejection')
  assert.match(err.message, /push rejected: beaten to the position/)
  assert.deepStrictEqual(err.pushRejected, { reason: 'beaten to the position' })
})

test('awaitLanded rejects on Mirror.divergence — the new arm', async () => {
  const { mirror, local } = mirrorWithSession()
  const landed = mirror.awaitLanded(100)
  mirror.reportDivergence({ preClone: local, wireBytes: new Uint8Array([1, 2]), atRemoteLength: 0 })
  const err = await landed.then(() => null, e => e)
  assert.ok(err, 'expected rejection')
  assert.match(err.message, /diverged from incoming chain/)
  assert.ok(err.divergence, 'divergence detail should ride along')
})

test('awaitLanded rejects on session conflictDetected — the legacy arm, until relayInboundStream goes', async () => {
  const { mirror, session } = mirrorWithSession()
  const landed = mirror.awaitLanded(100)
  session.arm('conflictDetected', { dataAddress: 42 })
  const err = await landed.then(() => null, e => e)
  assert.ok(err, 'expected rejection')
  assert.deepStrictEqual(err.conflictDetected, { dataAddress: 42 })
})

test('awaitLanded resolves immediately with no session — nothing will ever advance remoteLength', async () => {
  const recaller = new Recaller('awaitLanded-sessionless')
  const local = new WritableStreamoRecord({ recaller })
  const mirror = new Mirror({ publicKeyHex: 'cd'.repeat(32), local })
  // remoteLength stays 0, target is 500: a wire-waiting await would hang.
  // This is the bypass fileSync's archive-only paths depend on.
  await mirror.awaitLanded(500)
})

test('awaitLanded checks failures BEFORE the sessionless bypass', async () => {
  // Regression guard for ordering: _awaitChainHash resolved sessionless
  // callers cleanly, but tests that pre-arm a rejection must still reject.
  // Get the order wrong and a pre-armed failure silently resolves.
  const recaller = new Recaller('awaitLanded-order')
  const local = new WritableStreamoRecord({ recaller })
  const mirror = new Mirror({ publicKeyHex: 'ef'.repeat(32), local })
  mirror.reportDivergence({ preClone: local, wireBytes: new Uint8Array([9]), atRemoteLength: 0 })
  const err = await mirror.awaitLanded(500).then(() => null, e => e)
  assert.ok(err, 'a pre-armed divergence must reject even with no session attached')
})

test('awaitLanded unwatches once settled — leaving it live leaks a watcher per commit', async () => {
  // Asserted by spying on unwatch, NOT by re-settling: resolving an
  // already-resolved promise is a silent no-op in JS, so the obvious
  // version of this test cannot fail. A leaked watcher here would be one
  // per commit for the life of the session, re-running on every byte.
  const { mirror, recaller } = mirrorWithSession()
  let unwatched = 0
  const realUnwatch = recaller.unwatch.bind(recaller)
  recaller.unwatch = (fn) => { unwatched++; return realUnwatch(fn) }
  try {
    const landed = mirror.awaitLanded(10)
    mirror.remoteLength = 10
    await landed
    assert.strictEqual(unwatched, 1, 'expected exactly one unwatch on the resolve path')
  } finally {
    recaller.unwatch = realUnwatch
  }
})

test('Draft over a Mirror awaits remoteLength', async () => {
  // The whole point of the migration. This test used to also stub
  // `_awaitChainHash` and assert it wasn't reached — a check that became
  // vacuous when the method was deleted in 5d-2, so it's gone. A test that
  // cannot fail is worse than no test.
  const { mirror, local } = mirrorWithSession()
  const draft = mirror.newDraft()
  draft.set({ hello: 'wire' })
  // No signer attached → commit() takes the no-signer early return, which
  // is the sessionless-author path fileSync uses. It must not reach either
  // await, and it must not throw.
  const { chainHash } = await draft.commit({ message: 'from a Mirror' })
  assert.ok(chainHash !== undefined, 'commit should report the landed chainHash')
  assert.deepStrictEqual(local.get(), { hello: 'wire' }, 'the value should have landed in local')
})
