// Dedup leverage stats for a repo and per-value economics for a single
// chunk inside it. Both walk the chunk graph via asRefs and return plain
// data — no h, no DOM, no view state. The "earlier bytes become more
// efficient over time" narrative the explorer tells lives here.

import { isCommitShape } from './shapes.js'

// Helper for walking asRefs children. `refs` can be:
//   - undefined / a non-object → no children
//   - an array of addresses (ARRAY codec)
//   - { v: [a, b] } (DUPLE wrapper)
//   - an object whose values are addresses (OBJECT codec)
// Dates and Uint8Arrays look object-ish but have no addressable children.
function pushAsRefs (stack, refs) {
  if (Array.isArray(refs)) {
    for (const c of refs) if (typeof c === 'number') stack.push(c)
  } else if (refs && typeof refs === 'object' && !(refs instanceof Date) && !(refs instanceof Uint8Array)) {
    if (Array.isArray(refs.v)) {
      for (const c of refs.v) if (typeof c === 'number') stack.push(c)
    } else {
      for (const c of Object.values(refs)) if (typeof c === 'number') stack.push(c)
    }
  }
}

// Dedup leverage: for each chunk, count how many distinct commits'
// data trees include it (BFS from each commit's dataAddress through
// asRefs). A chunk that shows up in 10 commits "earned" 9 free reuses;
// without dedup, those 9 reuses would've cost chunk.length each.
//
// Repo rollup: naiveBytes = Σ(chunk.length × uses) is what the stream
// would've cost without dedup; actualReusable = Σ(chunk.length) over
// the reachable chunks is what streamo actually stores. Leverage =
// naiveBytes / actualReusable — "this many effective bytes per actual
// byte." Grows monotonically as commits reuse existing chunks.
//
// The savings narrative the user reached for: "earlier bytes become
// more efficient over time" — a chunk's price is fixed at first-
// encoding-time; its value compounds with every later commit that
// references it. This computes the snapshot.
export function repoReuseStats (repo) {
  const uses = new Map()  // chunkAddr → number of commits reaching it
  let addr = repo.byteLength - 1
  while (addr >= 0) {
    const code = repo.resolve(addr)
    if (!code || !code.length) break
    if (repo.footerToCodec[code.at(-1)]?.type === 'OBJECT') {
      let val
      try { val = repo.decode(addr) } catch {}
      if (val && isCommitShape(val)) {
        const visited = new Set()
        const stack = [val.dataAddress]
        while (stack.length) {
          const a = stack.pop()
          if (typeof a !== 'number' || visited.has(a)) continue
          visited.add(a)
          uses.set(a, (uses.get(a) ?? 0) + 1)
          let refs
          try { refs = repo.asRefs(a) } catch {}
          pushAsRefs(stack, refs)
        }
      }
    }
    addr -= code.length
  }
  let naiveBytes = 0
  let actualReusable = 0
  for (const [a, count] of uses) {
    let code
    try { code = repo.resolve(a) } catch { continue }
    if (!code) continue
    naiveBytes += code.length * count
    actualReusable += code.length
  }
  const leverage = actualReusable > 0 ? naiveBytes / actualReusable : 1
  return { uses, naiveBytes, actualReusable, leverage }
}

// Per-value economics — for the chunk at address A, sum the bytes of
// its full asRefs subtree (the chunks streamo actually stores to
// represent A), then combine with A's repo-wide use count to express
// the "naive vs. actual" story for THIS specific value:
//
//   subtree bytes = sum of every chunk reachable from A via asRefs
//   uses_A        = commits whose data tree includes A
//   naive cost    = subtree_bytes × uses_A
//                   ("if every commit re-encoded the whole subtree")
//   actual cost   = subtree_bytes
//                   (streamo stores it once and references it after)
//   leverage      = naive / actual = uses_A
//
// Honest about graph roots (uses_A = 0 — commits and signatures): no
// reuse possible by construction, so the block reports it that way
// rather than dividing by zero or pretending.
export function valueEconomics (repo, address, uses) {
  let chunkBytes = 0
  try { chunkBytes = repo.resolve(address)?.length ?? 0 } catch {}
  let subtreeBytes = 0
  const visited = new Set()
  const stack = [address]
  while (stack.length) {
    const a = stack.pop()
    if (typeof a !== 'number' || visited.has(a)) continue
    visited.add(a)
    let code
    try { code = repo.resolve(a) } catch { continue }
    if (!code) continue
    subtreeBytes += code.length
    let refs
    try { refs = repo.asRefs(a) } catch {}
    pushAsRefs(stack, refs)
  }
  const useCount = uses.get(address) ?? 0
  return {
    chunkBytes,
    subtreeBytes,
    dependenciesBytes: Math.max(0, subtreeBytes - chunkBytes),
    uses: useCount,
    naiveCost: subtreeBytes * useCount,
    savings: useCount > 0 ? subtreeBytes * (useCount - 1) : 0,
    leverage: useCount  // value-as-a-whole framing: leverage = use count
  }
}
