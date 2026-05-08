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

test('unwatch during a pending flush does NOT resurrect the watcher', async () => {
  // Regression: unwatch used to only remove from #deps. If the watcher was
  // already in #pending (from an earlier mutation), the next flush would
  // re-run it via watch() — re-establishing its dependencies and undoing
  // the unwatch. unwatch() must also drop f from #pending.
  const r = new Recaller('test')
  const target = {}
  let runs = 0
  const f = () => { runs++; r.reportKeyAccess(target, 'k') }
  r.watch('w', f)
  assert.equal(runs, 1)

  // Synchronously: queue f for re-run, then unwatch before the microtask drains.
  r.reportKeyMutation(target, 'k')
  r.unwatch(f)

  await new Promise(resolve => nextTick(resolve))
  // If unwatch were broken, runs would be 2 (the resurrection re-ran f).
  assert.equal(runs, 1, 'unwatched watcher must not run after queued mutation')

  // And subsequent mutations must not trigger it either — its deps should be cleared.
  r.reportKeyMutation(target, 'k')
  await new Promise(resolve => nextTick(resolve))
  assert.equal(runs, 1, 'unwatched watcher must stay unwatched')
})
