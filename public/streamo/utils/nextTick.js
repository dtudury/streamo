const _next = typeof process !== 'undefined' ? process.nextTick : setTimeout

let _pending = []
let _scheduled = false

const flush = () => {
  for (let i = 0; i < 10; i++) {
    _scheduled = false
    const batch = _pending
    _pending = []
    batch.forEach(f => f())
    if (!_pending.length) return
  }
  console.error('nextTick: flush loop exceeded 10 iterations')
}

export const nextTick = f => {
  _pending.push(f)
  if (_scheduled) return
  _scheduled = true
  _next(flush)
}

/**
 * Run everything that's queued, right now, instead of on the next tick.
 *
 * The debounce exists so a burst of mutations coalesces into one flush.
 * A caller who has finished its burst and wants the consequences doesn't
 * need the debounce — it needs the work. This is that: same `flush` the
 * scheduler would have run, called directly.
 *
 * Safe to call with a flush already scheduled: that one still fires and
 * finds an empty queue.
 */
export const flushNow = () => flush()

/**
 * Awaitable form, for callers that would rather wait for the real
 * boundary than reach past it.
 */
export const tick = () => new Promise(resolve => nextTick(resolve))
