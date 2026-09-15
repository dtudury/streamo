export function loopback () {
  const ends = [handlers(), handlers()]
  const pair = ends.map((mine, index) => {
    const theirs = ends[1 - index]
    return {
      send (data) {
        if (mine.closed) throw new Error('loopback: this end is closed')
        queueMicrotask(() => { for (const fn of theirs.message) fn(data) })
      },
      on (event, fn) { mine[event]?.add(fn) },
      off (event, fn) { mine[event]?.delete(fn) },
      close () {
        if (mine.closed) return
        mine.closed = true
        theirs.closed = true
        queueMicrotask(() => {
          for (const end of ends) for (const fn of end.close) fn()
        })
      }
    }
  })
  return pair
}

function handlers () {
  return { message: new Set(), close: new Set(), closed: false }
}
