// Browsers throttle setTimeout(fn, 0) to 1000ms minimum in background or
// idle-considered tabs (Opera in particular is aggressive about this).
// queueMicrotask is not throttled — it runs at the end of the current
// task regardless of tab state, so the recaller flush stays prompt as
// long as JS keeps running (which it does, e.g. on every WebSocket
// message). process.nextTick is the equivalent in Node.
const _next = typeof process !== 'undefined'
  ? process.nextTick
  : (typeof queueMicrotask !== 'undefined' ? queueMicrotask : setTimeout)

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
