// Measures copyFrom's sharedThrough fast-path savings on a watcher-shaped
// workload (large `entries-wip` array, append K items, copy back).
//
// Compares two scenarios:
//   A. dest already has the base array's chunks (sharedThrough = baseValueAddr)
//      → Branch 1 returns shared subtrees as-is, no decompose/recurse work
//   B. dest is fresh (sharedThrough = -1)
//      → Every chunk in the tree gets decompose/recurse/compose treatment
//
// Both scenarios produce bit-identical output (per copyFrom.test.js); the
// difference is purely how much work was done to get there.

import { Streamo } from '../public/streamo/Streamo.js'

const makeItem = i => ({
  type: i % 3 === 0 ? 'user' : 'assistant',
  uuid: `uuid-${i.toString().padStart(8, '0')}`,
  parentUuid: i > 0 ? `uuid-${(i - 1).toString().padStart(8, '0')}` : null,
  timestamp: new Date(2026, 5, 10, 0, 0, i).toISOString(),
  message: {
    role: i % 3 === 0 ? 'user' : 'assistant',
    content: [
      { type: 'text', text: `Item ${i}: some content of moderate length here.` },
      ...(i % 2 === 0 ? [{ type: 'thinking', thinking: `reasoning ${i}`, signature: `sig_${i}` }] : [])
    ]
  }
})

function bench (N, K) {
  // Build destination registry with base array of N items
  const dest = new Streamo()
  const baseArr = Array.from({ length: N }, (_, i) => makeItem(i))
  dest.set('entries-wip', baseArr)
  const baseValueAddr = dest.valueAddress

  // Clone dest → working; mutate working with N+K items
  // (sharing chunks below baseValueAddr by construction)
  const working = dest.clone(baseValueAddr)
  const extendedArr = Array.from({ length: N + K }, (_, i) => makeItem(i))
  working.set('entries-wip', extendedArr)

  // Scenario A: dest knows about the shared region
  const tA0 = performance.now()
  dest.copyFrom(working, working.valueAddress, baseValueAddr)
  const tA1 = performance.now()

  // Scenario B: fresh destination (no shared region)
  const freshDest = new Streamo()
  const tB0 = performance.now()
  freshDest.copyFrom(working, working.valueAddress, -1)
  const tB1 = performance.now()

  return {
    N,
    K,
    withSharedMs: (tA1 - tA0).toFixed(2),
    withoutSharedMs: (tB1 - tB0).toFixed(2),
    speedup: ((tB1 - tB0) / (tA1 - tA0)).toFixed(1) + '×'
  }
}

console.log('N (base size) | K (appended) | with sharedThrough | without sharedThrough | speedup')
console.log('--------------|--------------|---------------------|------------------------|--------')
for (const N of [100, 500, 1000, 2000, 5000]) {
  for (const K of [5, 50]) {
    const r = bench(N, K)
    console.log(
      `${String(r.N).padStart(13)} | ${String(r.K).padStart(12)} | ${r.withSharedMs.padStart(19)}ms | ${r.withoutSharedMs.padStart(22)}ms | ${r.speedup.padStart(7)}`
    )
  }
}
