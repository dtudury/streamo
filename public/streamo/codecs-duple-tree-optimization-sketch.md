# Sketch: tree-aware ARRAY modification (the next codec optimization)

The trap surfaced 2026-06-05 when the watcher's incremental commits
took ~1.2s per appended entry at N≈4188 — because `Streamo.set`'s
path-update calls `encode(newRefs, true)` which recursively builds
~4187 in-memory `Duple` objects every time, even though only the
rightmost path actually changes.

The fix is a tree-aware ARRAY append/modify that descends the existing
Duple tree, swaps one leaf, and walks back up reusing sibling subtree
addresses. O(log N) new chunks per change instead of O(N) walked.

## The Duple split algorithm (from codecs.js)

```js
class Duple {
  constructor (items) {
    if (items.length === 2) this.v = items
    else if (items.length > 2) {
      const split = 2 ** (31 - Math.clz32(items.length - 1))
      const right = items.length - split === 1
        ? items[items.length - 1]                // single item, not Duple
        : new Duple(items.slice(split))
      this.v = [new Duple(items.slice(0, split)), right]
    }
  }
}
```

For an array of size N: `split = 2^floor(log2(N-1))`, i.e. the largest
power of 2 strictly less than N.

## When does split move on append (N → N+1)?

It JUMPS only when `N` is `2^k + 1` (transition from `split=2^(k-1)` to
`split=2^k`). Example: 4096 → 4097, split jumps from 2048 to 4096.

**Between jumps**: split is stable. Append modifies ONLY the right
subtree path; left subtree's chunk reused by address.

**At a jump**: the new tree's root has left = the WHOLE OLD TREE (the
old root chunk address used directly as left child), right = the new
item. One Duple chunk to encode.

So both cases are O(log N) at worst, O(1) at jump boundaries.

## Proposed API

```js
// In codecs.js — new function alongside ARRAY codec:

/**
 * Append a single item to an existing ARRAY chunk without rebuilding
 * the underlying Duple tree. Returns the new array's chunk address,
 * or undefined if oldSize is too small (1) and the caller should
 * fall back to a fresh encode.
 *
 * The new tree is BIT-IDENTICAL to what `encode([...oldItems, newItem])`
 * would produce — same Duple structure, same split points, same chunk
 * hashes throughout. Critical: content-addressing means any deviation
 * would cause our optimized path's output not to dedup with other
 * encodings of the same logical array elsewhere.
 *
 * @param {object} r              registry-r (write context — has append)
 * @param {number} oldArrayAddr   chunk address of the existing ARRAY
 * @param {number} oldSize        number of items in the existing array
 * @param {any}    newItem        the value being appended
 * @param {boolean|undefined} asRefs  passed through to value encoding
 * @returns {number|undefined}    new array chunk address, or undefined
 *                                 if caller should fall back
 */
function appendToArrayChunk (r, oldArrayAddr, oldSize, newItem, asRefs) {
  // For length 0 or 1 the encoding doesn't use a Duple; the ARRAY codec
  // has special branches (length === 1 → object-with-length, length === 0
  // → EMPTY_ARRAY). Fall back to standard encode.
  if (oldSize < 2) return undefined

  // Decode the old ARRAY chunk to get its Duple part — but only at the
  // ROOT level. We need the [leftRef, rightRef] of the top Duple.
  // ... mechanics: decodeParts(r, r.resolve(oldArrayAddr))[0] gives the
  //     ARRAY's single part, which is the Duple. Walk that.

  const oldSplit = 2 ** (31 - Math.clz32(oldSize - 1))
  const newSize  = oldSize + 1
  const newSplit = 2 ** (31 - Math.clz32(newSize - 1))

  if (oldSplit !== newSplit) {
    // SPLIT JUMP (newSize = 2^k + 1 transition).
    // New root: left = entire old tree's Duple (by address), right = newItem.
    // Construct: new Duple([oldDupleAddr, newItemValue]) — Duple
    // constructor for length-2 just stores them as v=[left, right].
    // The encoder via encodeMultipart will treat the number as an
    // address (via r.encode(num, true) → r.resolve(num)).
    // Special case: encode this as the new ARRAY's single part.
    return encodeArrayWithDupleRoot(r, [oldDupleAddr, encodedNewItem], asRefs)
  }

  // STABLE SPLIT — descend the right subtree of the old root.
  // Recurse: in the old right subtree (which has oldSize-oldSplit items),
  // we're appending one item at the local index (oldSize-oldSplit).
  //
  // The new right subtree has oldSize-oldSplit+1 items.
  // Recursive base case: when right subtree has 1 item (just the rightmost
  // item, not a Duple), the new right becomes a Duple([oldRightItem, newItem]).
  //
  // The new root: left = oldLeftAddr (unchanged, used by address),
  //               right = newRightAddr (computed by recursion).

  // ... full implementation needs careful handling of:
  //   - the asRefs flag (number = address vs value)
  //   - the "right has 1 item" special case (the old right child was the
  //     item itself, not a Duple-wrapped pair)
  //   - the new-Duple encoding (inline vs addressed via inlineOrAddressPart)
}
```

## Where to wire it in Streamo.set

```js
// In Streamo.set's path-update branch, after computing the new leaf:
// if the level being modified is an ARRAY and the key === array.length
// (pure append), try the fast path before falling back.

if (Array.isArray(refs) && +key === refs.length) {
  const oldArrayAddr = /* level's addr from the descent */
  const newRootAddr = appendToArrayChunk(this.#readWriteR, oldArrayAddr,
                                          refs.length, value, true)
  if (newRootAddr !== undefined) {
    childAddr = newRootAddr
    continue // skip the normal flat-encode path for this level
  }
}
// ... fall through to existing encode(newRefs, true) path
```

## Test plan (the load-bearing checks)

```js
// Critical invariant: the optimized output must be bit-identical to
// the standard output. If not, content-addressing breaks; chunks
// don't dedup across encoders; the architecture silently fragments.

test('appendToArrayChunk produces same chunk as standard encode for a wide range of sizes', () => {
  for (let N = 2; N <= 10000; N++) {
    const items = Array.from({length: N}, (_, i) => i)
    const standard = streamo.encode(items)
    const oldArr = streamo.encode(items.slice(0, N - 1))
    const oldArrAddr = streamo.append(oldArr)
    const optimized = appendToArrayChunk(streamo._readWriteR,
                                          oldArrAddr, N - 1, items[N-1])
    assert.deepEqual(standard, streamo.resolve(optimized))
  }
})

// Boundary case: split-jump sizes (2^k + 1 transitions)
test('split-jump boundaries handled correctly', () => {
  // 9, 17, 33, 65, 129, 257, 513, 1025, 2049, 4097, 8193, ...
  // Each of these is a 2^k + 1 transition; the new root structure
  // differs from the old in a different way than non-jump cases.
})

// Round-trip via decode
test('optimized append round-trips through decode identically', () => {
  const items = /* test array */
  const optimizedAddr = /* via appendToArrayChunk */
  assert.deepEqual(streamo.decode(streamo.resolve(optimizedAddr)), items)
})
```

## Why this is the right next move

The current path-update branch reuses sibling addresses at the
**object/array level**, but the array codec itself doesn't reuse
subtree addresses at the **Duple-tree level**. That's the actual cost
boundary for large arrays.

After this lands:
- Watcher per-set: 1.2s → microseconds
- Same architecture applies to ANY large-array path-update (not just append)
- The deeper "modifyAt" version (any index, not just append) is a similar
  shape — descend the tree, find the index, swap the leaf, walk back up

## Why not tonight

Bit-identical output across all sizes including split-jump boundaries
requires careful testing. Without it, content-addressing fragments
silently — chunks our optimized path produces don't dedup with chunks
the standard path produces elsewhere in the system, costing more than
the optimization saves. The test surface is wide (every array size,
every modification index) and the failure mode is silent.

The watcher's current 1.2s/entry is slow but functional. Better to do
this with proper test surface than rush it.

## See also

- The watcher's commit at `fe742f3` lands the three-fixes that
  surfaced this remaining slowness
- `Streamo.set`'s path-update branch in `public/streamo/Streamo.js`
- The Duple class in `public/streamo/codecs.js` lines 89-123
- The ARRAY codec in `public/streamo/codecs.js` lines 432-449
