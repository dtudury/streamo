# Sketch: codec state-invariance (kill UINT7 + inline + variable-width addresses)

> *Companion to `codecs-duple-tree-optimization-sketch.md`. That sketch
> identified the smart-copyFrom direction; THIS sketch identifies the
> change that makes the smart-copyFrom trivially bit-identical instead
> of requiring careful append-order matching.*

## The architectural finding (2026-06-07, from finch's 2026-06-05 log)

The codec's `inlineOrAddressPart` makes per-chunk decisions that depend
on **registry state**, not just the value:

```js
const nextAddr = Math.max(0, r.byteLength + code.length - 1)
if (existingAddr === undefined && code.length <= numberToVar(nextAddr).length) {
  return [code, 0]  // inline (no separate chunk stored)
}
```

The "inline vs addressed" decision compares the chunk's length against
the varint width of the address it WOULD get if appended. As
`r.byteLength` grows, address widths grow (1 → 2 → 3 → 4 bytes), so the
inline-threshold changes mid-encode.

**Consequence**: smart copyFrom can't be naively bit-identical, because
recursive subtree-copying changes byteLengths between decision points,
which changes inline-vs-addressed decisions, which changes chunk bytes,
which changes chain hashes. Finch hit this wall on Branches 2 & 3.

**The fix is upstream of copyFrom**: make the encoding state-invariant.
Same (value, codec-context) pair always produces identical bytes,
regardless of where in the chunk store it lands.

## What removes

### 1. UINT7

Direct integer 0–127 → 1-byte chunk via dedicated footer per value.
Saves ~5 bytes per small integer; costs 128 footer slots and the
`uint7Readers` factory.

After: ints 0–127 encode as `WORD([byte])` or `FLOAT64(double)`. Each
gets a real chunk address. Cost increase: ~few bytes per small int
when serialized; negligible at the data scales we operate on.

### 2. Inline parts in DUPLE / all `inlineOrAddress` codecs

Currently every multipart codec has 5 options per part:
- option 0: inline (raw bytes embedded in parent)
- options 1–4: 1-, 2-, 3-, 4-byte address

After: every part is always addressed. The `inlineReader` factory and
all "is this inline?" branching disappears.

**Affects:** UINT8ARRAY, STRING, FLOAT64, DATE, DUPLE, ARRAY, OBJECT,
VARIABLE — every codec that uses `inlineOrAddress` as its partReader.

DUPLE drops from claiming 25 footers (5 × 5) to claiming N footers
(depends on what we do with variable-width — see next).

### 3. Variable-width addresses (1- to 4-byte)

Currently addresses are 1, 2, 3, or 4 bytes depending on size. After:
fixed 4 bytes always.

Combined with (2): every multipart codec has **1 option per part**
(just "addressed, 4 bytes"). DUPLE claims 1 footer total. Same for
OBJECT, ARRAY, VARIABLE, UINT8ARRAY, STRING, FLOAT64, DATE.

Cost: addresses for chains with < 2^24 chunks pay 1–3 extra bytes
per address. For our 5MB engineer chain (~10k chunks; currently
2-byte addresses): ~0.4% storage overhead. Negligible.

## What stays (load-bearing)

- **The two-r split** (`#readWriteR` / `#readOnlyR`) — mutation-impossibility
  by control flow. Foundation of safe read APIs.
- **Negative addresses for single-byte primitives** — UNDEFINED, NULL,
  FALSE, TRUE still encode as `-(footer + 1)`, no chunk store touch.
  After kills, range narrows from ~132 to 4, but the mechanism stays.
- **Duple tree for ARRAY/OBJECT** — O(log N) append/modify properties.
- **`decodeAt`'s lazy path traversal** — O(depth) reads on huge records.
  *Note: the "inline child fallback" branch becomes dead code; remove
  alongside.*
- **`directReferences` separate from `asRefs`** — chunk-graph view vs
  user-value view. Different consumers, different contracts.
- **`copyFrom`'s 3-branch architecture** — Branch 0 (primitive) +
  Branch 1 (shared-through) stays. Branch 2&3 collapses to "just
  encode" once state-invariant.
- **The codec registry pattern itself** — not over-engineered. Stays.

## What simplifies as a cascade

After the kill:
- `inlineReader`, `addressReaders` (all 4 separate readers), and
  `inlineOrAddress` → one reader: "address, 4 bytes"
- `inlineOrAddressPart` → `(r, code) => [varInt4(r.addressOf(code) ?? r.append(code)), 0]`
  (or simpler — no option to return; every part is the same shape)
- `getPartAddress`'s inline branch → gone
- `asRefs` / `_asRefsForWrite` → collapse to one function. The whole
  "read-only context returns undefined for inline children" no longer
  has anything to do because there are no inline children.
- `decodeAt`'s inline-fallback branch → gone
- DUPLE.decode's `nameIsRef`/`valueIsRef`/`'all'` mode logic →
  simplifies dramatically (refs are always refs)

## The new footer layout

Counting baseFooters after the cascade (every multipart codec claims 1):

| codec | footers claimed | notes |
|---|---|---|
| UNDEFINED | 1 | |
| NULL | 1 | |
| FALSE | 1 | |
| TRUE | 1 | |
| WORD | 4 | literal widths 1, 2, 3, 4 stay |
| UINT8ARRAY | 1 | was 5 |
| EMPTY_STRING | 1 | |
| STRING | 1 | was 5 |
| ~~UINT7~~ | ~~128~~ | **removed** |
| FLOAT64 | 1 | was 5 |
| DATE | 1 | was 5 |
| SIGNATURE | 1 | fixed-width, unchanged |
| DUPLE | 1 | was 25 |
| EMPTY_ARRAY | 1 | |
| ARRAY | 1 | was 5 |
| EMPTY_OBJECT | 1 | |
| OBJECT | 1 | was 5 |
| VARIABLE | 1 | was 5 |
| EMPTY_UINT8ARRAY | 1 | |

**Total: 19 footers (was ~201).** ~237 footers free.

(EMPTY_* codecs: worth re-evaluating now that footer pressure is gone —
they're each 3 lines of trivial code, harmless. Leave for now; revisit
in a follow-on sweep.)

## The migration story — load-bearing

**This is the part that needs decision before any commit.**

Once the new codec ships, OLD chunks (with UINT7-shifted footers, with
inline parts, with variable-width addresses) are unreadable by the new
reader. Every existing Record becomes inaccessible from new code.

**Records currently on streamo.dev (per `mounts.json`):**
- `streamo-relay` home Record
- `streamo` (library)
- `streamo/apps/chat`
- `streamo/apps/flashcards`
- `streamo/apps/explorer`
- `streamo/apps/todomvc`
- `streamo/apps/styles`
- `claude` (memory corpus) — `02c0159e…`
- `claude/sketch` — `029dc16a…`
- `claude/bubbles` — `02bf50b3…`
- `claude/engineer/3fb1490e…` (this session's watcher Record) — `03e79074…`

Plus whatever's on backup tiers (Hetzner, fly.io, etc.).

**Three options for the migration:**

### Option A: clean break + republish everything

- Old chunks orphaned (sit on disk, no reader)
- All Records re-published under NEW codec from source data
  (e.g., fileSync re-walks `public/` and republishes; engineer-watcher
  starts a fresh chain from current JSONL)
- New code has no legacy-reader code path — clean
- *Most aligned with the "no helpful fallbacks" discipline*

**Risks:** loss of chain history for high-value Records (claude memory,
bubbles). Some Records (like the engineer-watcher chain) are
content-driven — re-publishing from source gives same logical content,
new chain identity. Acceptable for ephemeral chains; questionable for
chains-of-record like memory.

### Option B: migration tool (one-time read-old, write-new)

- Ship the new codec alongside a `migrate.mjs` tool that:
  - Loads old codec implementation (saved as `legacyCodecs.js`)
  - Reads each Record's old chunks under legacy codec
  - Re-encodes under new codec
  - Republishes as new chain (preserves logical content; new chain hash)
- After migration completes for a Record, drop the legacy reader entirely
- Slightly more work; preserves "we migrated, here's the new version"
  in the chain history

**Risks:** `legacyCodecs.js` becomes a maintenance load until everyone's
migrated. Mostly write-once, but if a bug is found in migration it has
to be re-run.

### Option C: dual-codec runtime (legacy reader stays)

- New code includes BOTH old codec (read-only) and new codec (read+write)
- Auto-detects which codec to use based on chunk footer pattern
- No migration needed; old chunks just keep reading

**Risks:** This is the "helpful fallback" pattern we explicitly catch.
Carries the complexity we just removed, indefinitely. Probably wrong.

**My lean: A for content-driven Records (everything that's re-derivable
from source); the question for B vs A is whether the memory corpus
chain-history matters as an artifact. If yes, write the small migration
tool just for those; if no, A everywhere.**

## Test surface

The load-bearing invariant after the kill: **encoding is a pure function
of (value, codec definitions).** Test this directly:

```js
test('encode is state-invariant', () => {
  const r1 = new CodecRegistry()
  // Pre-fill r1 with junk to grow byteLength
  for (let i = 0; i < 1000; i++) r1.encode(`junk-${i}`)
  const addr1 = r1.encode(testValue)

  const r2 = new CodecRegistry()  // fresh, byteLength = 0
  const addr2 = r2.encode(testValue)

  // Different byteLengths at encode time. Same bytes out.
  assert.deepEqual(r1.resolve(addr1), r2.resolve(addr2))
})
```

If this holds, `copyFrom`'s Branches 2 & 3 collapse to:

```js
copyFrom (source, address, sharedThrough = -1) {
  if (address < 0) return address
  if (address <= sharedThrough) return address
  const value = source.decode(address)
  const newCode = this.encode(value)
  return this.addressOf(newCode) ?? this.append(newCode)
}
```

That's the current code. It just *works correctly* now because the encode
output is the same regardless of `this.byteLength`. No smart recursion
needed — the simple recursion IS bit-identical.

## Why a major version

- Breaks chunk format (old chunks unreadable by new code)
- Removes API surface (`_asRefsForWrite` may go entirely; `asRefs`'s
  return shape changes — no more undefined for inline)
- Cascading test updates
- *The deferred-majors-must-ship discipline applies* — if we're doing
  a major, kill what's queued for one in the same release. The smart-copyFrom
  enablement is a great headline for the major.

## Suggested commit sequence

1. **Sketch acknowledged + plan agreed** (this file + David's review)
2. **Decide migration story** (A / A+B for specific Records / C)
3. **Add state-invariance test** (failing initially; defines the bar)
4. **Kill UINT7** alone. Tests adjust. Footer space shifts. Commit.
5. **Kill inline parts** (replace `inlineOrAddress` with `addressOnly`).
   Tests adjust. Commit.
6. **Kill variable-width addresses** (fixed 4-byte). Tests adjust. Commit.
7. **State-invariance test passes** — confirm. Commit if any code change
   was needed.
8. **Simplify cascades** — collapse `asRefs`/`_asRefsForWrite`, remove
   decodeAt inline fallback, simplify DUPLE.decode. Tests still pass. Commit.
9. **Per chosen migration story** — re-publish (A) or build migrate tool (B).
10. **Major version bump + CHANGELOG + npm publish.**

Each commit is independently verifiable. The version bump comes at the
end, after the substrate is clean.

## Open questions for David

1. **Migration story choice** (A / B / C-not). Lean A; specific Records?
2. **Want the smart-copyFrom test enablement built into this same major**, or held back as a follow-up that's purely a perf improvement on the same wire format?
3. **EMPTY_* codecs** — leave as-is, or kill in the same sweep? Lean leave.

— nuthatch, 2026-06-07

---

## Postscript — REVERTED 2026-06-07 (same session, hours later)

**This sketch was the wrong move. We implemented all four kills, measured
the byte cost, and reverted.** Recording the path because the substrate
is meant to be honest about the dead ends, not just the wins.

### What we measured

After implementing every kill (UINT7 + EMPTY_* + inline + variable-width),
encoded sizes vs the original codec:

| Value | OLD | NEW | Ratio |
|---|---|---|---|
| `undefined / null / true` | 1b | 1b | 1× |
| integer `42` | **1b** | **29b** | **29×** |
| integer `0` | 1b | 24b | 24× |
| `""` | 1b | 6b | 6× |
| `"hi"` | 5b | 8b | 1.6× |
| `"hello world"` | 24b | 42b | 1.75× |
| `{}` | 1b | 6b | 6× |
| `{a: 1}` | 9b | 50b | 5.5× |
| `[]` | 1b | **70b** | **70×** |
| `[1,2,3]` | 8b | 100b | 12.5× |
| `[1..100]` | 313b | 3296b | 10.5× |

UINT7 wasn't just a "footer-space optimizer" — it was the biggest single
saving for any data with small integers (which is essentially all
structured data: counts, indices, timestamps, IDs). And the empty-value
codecs save a *lot* more than I'd guessed.

### Why the architectural justification was wrong

**The claim in this sketch**: state-invariance → smart copyFrom becomes
trivially bit-identical.

**What's actually true**: state-invariance is needed for the *decode-then-
re-encode* approach to smart copyFrom. It's NOT needed if you take the
byte-copy approach.

For the working-clone-then-commit pattern (the common case):
- `working` is a byte-identical clone of `original` up through `sharedThrough`
- `working` appends new chunks at addresses `sharedThrough+1, +2, ..., +N`
- When we copy those new chunks back to `original` (whose byteLength is
  still at `sharedThrough+1`), they land at the **same addresses** they
  had in `working`
- The address-references inside those new chunks are valid in `original`
  without any translation

So smart copyFrom can be:

```js
copyFrom (source, address, sharedThrough = -1) {
  if (address < 0) return address
  if (address <= sharedThrough) return address
  for (const child of source.directReferences(address)) {
    this.copyFrom(source, child, sharedThrough)
  }
  const code = source.resolve(address)
  return this.addressOf(code) ?? this.append(code)
}
```

No decode, no re-encode, no state-invariance needed. The inline-vs-addressed
decision doesn't matter because we're not making new encoding decisions —
just byte-copying chunks that already exist.

**Finch's original wall** wasn't state-invariance per se. Her recursion
used `asRefs` to extract addresses and then *re-encoded* with those
addresses (which calls `inlineOrAddressPart`, which IS state-dependent).
If she'd done `source.resolve(address)` and byte-copied instead, she
would have sidestepped the entire state-dependency problem.

### The lesson

**Architectural cleanup that comes with a 10–70× byte regression for the
typical case is not cleanup — it's a regression that comes with
architectural cleanup.** Always measure before committing to a
"simplification" that touches a load-bearing codec.

The smart copyFrom can be implemented (via byte-copy) without any of the
kills proposed here. When/if we want it, do that.

### State after revert

- All four kills reverted (UINT7, EMPTY_*, inline, variable-width all back)
- finch's pre-session Branch 1 (`sharedThrough`) changes preserved
- 346/346 tests pass (back from 345 during the kills — the `-0 decodes as 0`
  test restored)
- This sketch stays in the substrate as the record of the path

— nuthatch, 2026-06-07 later
