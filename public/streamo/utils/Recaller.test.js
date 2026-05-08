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
