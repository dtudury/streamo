# The actual copyFrom algorithm (David's framing, 2026-06-05 late)

After spelunking through smart-copyFrom attempts, copyChunk sketches,
and bulk-byte-copy ideas — David named the actual algorithm in plain
shape. Writing it down because it's load-bearing and I kept losing it.

## The recipe

> "You copy the value across by decomposing it and copying its parts
> across. If a part is from a memory address that they share then you
> copy it directly. If it's from a memory address after the shared
> part then you copy it by decomposing it. If it's not decomposable
> then you look it up / add it. I think that's the whole recipe."

Three branches, applied per part:

1. **Shared address** (address ≤ clonePoint, where clonePoint is the
   lastCommit.dataAddress shared between source and self): **keep the
   address as-is.** Both source and self have the same chunks at the
   same addresses up to clonePoint — the reference is valid in self
   without any work.

2. **New address** (address > clonePoint — a chunk source added since
   the clone): **recurse — decompose THIS chunk and translate**. The
   chunk is genuinely new content needing import.

3. **Leaf (not decomposable)** (no `partReaders.length`): **lookup or
   add.** Check `self.addressOf(chunkBytes)` — if present (dedup),
   return that address. Else `self.append(chunkBytes)` and return the
   new address.

The recursion bottoms out at leaves. Composites get rebuilt with
translated child addresses; the translation only happens for the
"new address" branch.

## Why this dissolves the chain-layout problem

I was worried that the commit-record + SIG between commits broke the
shared-ancestry invariant. They don't, in this algorithm: we never
try to align working's bytes to specific offsets in self. We walk
working's chunk graph, recursively bringing in only the new chunks.
Each new chunk lands at self.byteLength when appended; the parent's
bytes get rebuilt with the *translated* address pointing at where
the child actually landed in self.

The shared-address fast path is what makes this efficient: for
working's chunks-that-reference-old-content, we don't recurse at all
— the address is valid as-is. Most references in the new chunks
point to old content (because path-update or even whole-value-set
mostly references existing dedup'd entries).

## Why my earlier smart-copyFrom broke a test

My version called `source.asRefs(address)` which returns the FLAT
array of refs for a composite (Duple.flat already applied). I then
mapped over them and re-encoded via `this.encode(refs, true)`.

That should have produced bit-identical bytes if byteLengths aligned
at each `inlineOrAddressPart` decision. The traversal order looked
right to me on paper. But something in `makeRelayInboundStream`'s
alignment check fired differently — either the byteLength sequence
shifted in some edge case, or my version missed a special-case codec
(VARIABLE wrappers? signature chunks?).

Without running the test under a debugger I can't be sure WHICH
detail diverged. The fix is to write the bit-identical assertion as a
test FIRST, then iterate the implementation until it passes. That's
the substrate-honest move for codec-level changes.

## Proposed implementation (recipe-shaped)

```js
copyFrom (source, address, sharedThrough = -1) {
  if (address < 0) return address                  // primitive (universal)
  if (address <= sharedThrough) return address     // shared region — direct copy

  // Try content-address fast path (dedup might give us a match)
  const sourceCode = source.resolve(address)
  const existing = this.addressOf(sourceCode)
  if (existing !== undefined) return existing

  // Decompose
  const footer = sourceCode.at(-1)
  const codec = this.footerToCodec[footer]
  if (!codec?.partReaders?.length) {
    // Leaf / not decomposable
    return this.append(sourceCode)
  }

  // Composite. Walk parts; recurse on addressed parts (case 2);
  // keep inline parts as-is (their bytes don't need translation
  // unless they themselves contain > sharedThrough addresses,
  // which is the tricky nested-inline case — handle as "kept bytes"
  // for v0; iterate if a test catches a real example).
  const parts = decodeParts(this.#readOnlyR, sourceCode)
  const partCodes = new Array(parts.length)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.address !== undefined) {
      const newAddr = this.copyFrom(source, part.address, sharedThrough)
      partCodes[i] = this.resolve(newAddr)
    } else {
      partCodes[i] = part.getCode()  // inline bytes
    }
  }

  // Reassemble using the same inlineOrAddressPart logic the encoder
  // uses — same function, same self-state, same decisions. The codec's
  // partReaders give the inline-vs-address option counts for footer math.
  return assembleAndAppend(this, codec, partCodes)
}
```

The `assembleAndAppend` helper would mirror `encodeMultipart`'s loop:
walk parts in reverse, call `inlineOrAddressPart(this, partCodes[i])`
for each, accumulate the footer, prepend the part bytes, finally
append the footer byte. Same code the standard encoder uses.

## The sharedThrough parameter

Where does the caller pass it? From `WritableStreamoRecord.commit`:

```js
const dataAddress = this.copyFrom(
  workingStreamo,
  workingStreamo.valueAddress,
  this.lastCommit?.dataAddress ?? -1
)
```

For non-clone-based callers (e.g., `merge` fetching from a snapshot),
`sharedThrough = -1` (no shared region; the full recursion runs but
addressOf still gives content-dedup hits where applicable).

## Load-bearing test surface

Before shipping, the bit-identical invariant needs explicit tests:

```js
test('copyFrom produces byte-identical chain to direct encode', () => {
  // Many shapes: primitives, strings, small/medium/large arrays,
  //              nested objects, mixed shapes, edge cases like
  //              empty arrays, single-element arrays, power-of-2
  //              array sizes.
  // Assert: cloneStreamoSetValue produces identical bytes to
  //         streamoSetValueFromScratch.
})

test('chain hash continuity holds across commit', () => {
  // Critical for makeRelayInboundStream's alignment check.
})
```

## The watcher-is-already-correct framing

The watcher publishes at ~10s per commit. For the product use case
(queryable past-Engineers, summon from snapshot for questions), 10s
of staleness is fine. The optimization to make commit fast is genuine
architectural progress but not load-bearing for shipping.

This file captures the algorithm so the optimization CAN be done
properly in a focused session with the test surface as the
load-bearing check. Not tonight; not the urgent path.

## What I keep losing track of

The reason I kept reaching for the wrong abstraction (copyChunk;
bulk-byte-copy; smart copyFrom that re-runs the encoder) was
*sunk-cost on what I'd already written*. David's algorithm is
plainly the actual answer — three branches, applied per part. The
implementation is mechanical from there once the test surface is in
place.

— heron-now / finch, 2026-06-05 ~midnight-ish, at 96% context
