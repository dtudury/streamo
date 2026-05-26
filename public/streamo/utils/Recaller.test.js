import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Recaller } from './Recaller.js'
import { nextTick } from './nextTick.js'

test('watch + reportKeyAccess + reportKeyMutation re-runs the watcher', async () => {
  const r = new Recaller('test')
  const target = {}
  let runs = 0
  r.watch('w', () => { runs++; r.reportKeyAccess(target, 'k') })
  assert.equal(runs, 1)
  r.reportKeyMutation(target, 'k')
  await new Promise(resolve => nextTick(resolve))
  assert.equal(runs, 2)
})

test('unwatch BEFORE flush starts does NOT resurrect the watcher', async () => {
  // Catches the easier case where unwatch happens before #flush() runs.
  const r = new Recaller('test')
  const target = {}
  let runs = 0
  const f = () => { runs++; r.reportKeyAccess(target, 'k') }
  r.watch('w', f)
  assert.equal(runs, 1)

  r.reportKeyMutation(target, 'k')  // queues f
  r.unwatch(f)                       // unwatch before microtask drains
  await new Promise(resolve => nextTick(resolve))
  assert.equal(runs, 1, 'unwatched watcher must not run after queued mutation')

  r.reportKeyMutation(target, 'k')
  await new Promise(resolve => nextTick(resolve))
  assert.equal(runs, 1, 'unwatched watcher must stay unwatched')
})

test('unwatch DURING flush (mid-batch) does NOT resurrect the watcher', async () => {
  // Catches the harder case where unwatch happens AFTER the batch has been
  // snapshotted — e.g. processing watcher A tears down DOM that contained
  // watcher B's slot anchor, calling unwatch(B) while B is still in the
  // current batch. Without the #names presence check in #flush(), B would
  // be re-watched against its torn-down DOM and fail.
  const r = new Recaller('test')
  const target = {}
  let aRuns = 0, bRuns = 0
  const a = () => {
    aRuns++
    r.reportKeyAccess(target, 'k')
    if (aRuns === 2) r.unwatch(b)  // mid-flush unwatch of a peer watcher
  }
  const b = () => { bRuns++; r.reportKeyAccess(target, 'k') }

  r.watch('a', a)
  r.watch('b', b)
  assert.equal(aRuns, 1)
  assert.equal(bRuns, 1)

  r.reportKeyMutation(target, 'k')  // both A and B end up in pending
  await new Promise(resolve => nextTick(resolve))

  assert.equal(aRuns, 2, 'a re-runs as expected')
  assert.equal(bRuns, 1, 'b was unwatched mid-flush; its batch entry must be skipped')
})

test('when() resolves immediately if predicate already truthy', async () => {
  const r = new Recaller('test')
  let cell = true
  await r.when(() => cell)
  assert.ok(true, 'resolved')
})

test('when() resolves on the reactive flip', async () => {
  const r = new Recaller('test')
  const target = {}
  let cell = false
  const promise = r.when(() => {
    r.reportKeyAccess(target, 'cell')
    return cell
  })
  // Not yet — predicate is false.
  let resolved = false
  promise.then(() => { resolved = true })
  await new Promise(resolve => nextTick(resolve))
  assert.equal(resolved, false, 'still waiting before the flip')

  // Flip the cell + notify.
  cell = true
  r.reportKeyMutation(target, 'cell')
  await new Promise(resolve => nextTick(resolve))
  // Give the promise's .then a microtask to fire.
  await new Promise(resolve => nextTick(resolve))
  assert.equal(resolved, true, 'resolved once the predicate flipped truthy')
})

test('when() rejects when AbortSignal aborts', async () => {
  const r = new Recaller('test')
  const target = {}
  let cell = false
  const controller = new AbortController()
  const promise = r.when(
    () => { r.reportKeyAccess(target, 'cell'); return cell },
    { signal: controller.signal }
  )
  controller.abort('user-cancelled')
  let err = null
  try { await promise } catch (e) { err = e }
  assert.ok(err, 'rejected on abort')
  assert.equal(err, 'user-cancelled', 'rejection reason is the signal.reason')
})

test('when() with already-aborted signal rejects immediately', async () => {
  const r = new Recaller('test')
  const controller = new AbortController()
  controller.abort('pre-aborted')
  let err = null
  try { await r.when(() => false, { signal: controller.signal }) } catch (e) { err = e }
  assert.ok(err, 'rejected synchronously on already-aborted signal')
})

test('watchCount + watcherNames track active watchers (leak-detection instrumentation)', async () => {
  const r = new Recaller('test')
  assert.equal(r.watchCount, 0, 'fresh Recaller has no watchers')
  assert.deepEqual(r.watcherNames, [])

  const f1 = () => {}
  const f2 = () => {}
  r.watch('one', f1)
  r.watch('two', f2)
  assert.equal(r.watchCount, 2, 'two watchers registered')
  assert.deepEqual(r.watcherNames.sort(), ['one', 'two'])

  r.unwatch(f1)
  assert.equal(r.watchCount, 1, 'unwatch decrements')
  assert.deepEqual(r.watcherNames, ['two'])

  r.unwatch(f2)
  assert.equal(r.watchCount, 0, 'back to clean')
})

test('when() leaves no leaked watcher after resolving', async () => {
  // The leak signal that matters: did the primitive's own watcher get
  // torn down? If `when` ever drifts toward "register watcher, don't
  // clean up after resolve," this test catches it.
  const r = new Recaller('test')
  const target = {}
  let cell = false
  assert.equal(r.watchCount, 0)

  const promise = r.when(() => { r.reportKeyAccess(target, 'cell'); return cell })
  assert.equal(r.watchCount, 1, 'when() registers one watcher while waiting')

  cell = true
  r.reportKeyMutation(target, 'cell')
  await promise
  assert.equal(r.watchCount, 0, 'when() cleans up its watcher on resolve — no leak')
})

test('when() leaves no leaked watcher after AbortSignal rejection', async () => {
  // The other branch — if `when` aborts via signal, cleanup is via the
  // abort handler. Same invariant: no orphaned watcher.
  const r = new Recaller('test')
  const controller = new AbortController()
  const promise = r.when(() => false, { signal: controller.signal })
  assert.equal(r.watchCount, 1, 'when() registers watcher pre-abort')
  controller.abort('test')
  try { await promise } catch {}
  assert.equal(r.watchCount, 0, 'when() cleans up its watcher on abort — no leak')
})

test('when() composes with Promise.race for timeout (the fileSync pattern)', async () => {
  const r = new Recaller('test')
  const target = {}
  let cell = false
  const controller = new AbortController()
  const ready = r.when(
    () => { r.reportKeyAccess(target, 'cell'); return cell },
    { signal: controller.signal }
  ).catch(() => 'timeout')
  const timer = setTimeout(() => controller.abort('timeout'), 10)
  const result = await ready
  clearTimeout(timer)
  assert.equal(result, 'timeout', 'race lost to timeout — caller proceeds')
})
