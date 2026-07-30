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
 * Awaitable form of nextTick: resolves after the currently-queued
 * callbacks have run.
 *
 * Ordering is what makes this precise rather than hopeful. A mutation
 * queues its flush here first; `await tick()` queues behind it in the
 * same batch, and `flush` runs the batch in order — so by the time this
 * resolves, the work that was already scheduled has happened. Waiting a
 * fixed number of milliseconds for the same thing is a guess that gets
 * slower and less reliable at the same time.
 */
export const tick = () => new Promise(resolve => nextTick(resolve))
