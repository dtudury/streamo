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
