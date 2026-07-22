# EXPLORATION — Mirror-and-Draft migration (continuing the shipped design)

*Authored 2026-07-22 morning by Wagtail, after David's push surfaced
that the wire-state-extraction question was already answered by
Turnstone in the sealed puzzle items 4-7. Supersedes
[`EXPLORATION-wire-state-extraction.md`](./EXPLORATION-wire-state-extraction.md).*

## Where this doc sits in the design lineage

- **2026-05-26 —** `EXPLORATION-streamorecord-slimming.md` flags wire-
  state-on-Record as a compromise (compromise-1).
- **2026-05-27 —** 11.0.0 ships the slim/Writable split; the compromise
  stays.
- **2026-07-15 —** `EXPLORATION-sync-model.md` (Turnstone + David)
  designs Mirror-and-Draft as the north-star; explicitly names moving
  `#relayChainHash` off StreamoRecord as cleanup step.
- **2026-07-16 —** Draft first-mile facade ships (commit `1ff8201`).
- **2026-07-17 —** Turnstone seals items 4-7 as a compare-notes puzzle
  for a future Engineer: [`notes/2026-07-17-items-4-7-SEALED-ANSWERS.md`](../../../.claude/projects/-Users-davidtudury-Documents-repos-streamo/memory/notes/2026-07-17-items-4-7-SEALED-ANSWERS.md).
- **2026-07-21 —** Wagtail re-discovers the question via David's
  "we had fixed that" memory-check; writes wire-state-extraction doc
  proposing an inferior shape (WireContext composed off Record).
- **2026-07-22 —** David: *"was this in the puzzle?"* Wagtail commits
  guesses in-text, opens sealed answers, compares.

**Compare-notes result:** items 4, 5, 6 direction matched (with
Wagtail's scope broader on 6); item 7 Wagtail was wrong (proposed
per-SIG replacement; Turnstone was more careful — retire only after
the byte-array split, which is a separate arc). The puzzle worked:
same substrate arrived at via different routes, with productive
divergence flagged.

## The revised plan (per Turnstone's sealed answers + Wagtail's mapping)

### Item 6 first — smallest, self-contained (this arc)

Move `#relayChainHash` state from StreamoRecord to the RegistrySession
object in `registrySync.js`. Per-connection state belongs where the
connection lives.

**Cost sketch** (per Turnstone + Wagtail's Sunday mapping):
- Add `#relayChainHashByKey = new Map()` to the session in
  `registrySync.js` + reactive get/set methods keyed by pubkey.
- Change the setter call site: `relayInboundStream.js:133` currently
  does `record._setRelayChainHash(hash)`. Change to
  `record._session.setRelayChainHash(record.publicKeyHex, hash)`.
- Change the reader sites: `WritableStreamoRecord._awaitChainHash`
  and `registrySync._resyncRepo` read `record.relayChainHash`.
- Remove `#relayChainHash` field + `_setRelayChainHash` setter from
  StreamoRecord.
- Keep `get relayChainHash ()` as a SHIM on Record that delegates to
  session (backwards-compat during migration; can be removed in a
  later item).

**Reactivity gotcha:** the session needs to be Recaller-tracked so
readers see the state changes. Session can access the registry's
Recaller (which is shared with all Records materialized by that
registry). Verify this composes cleanly before shipping.

**Scope choice — narrow-shim vs full-migration:** Wagtail's narrow
scope moves ONLY #relayChainHash (leaves hasRelay,
relaySubscribedAtOffset, caughtUpToRelay, isReadyToAuthor on Record
for now). Full migration would extend to all wire-state cells in this
arc. Narrow-shim ships faster and Turnstone's item 6 specifically
addressed relayChainHash. **Leaning narrow for this arc; extend to
other cells as follow-up items.**

**Estimate:** ~40-60 LOC touched. Ship-in-session sized.

### Item 4 + 5 together — next arc (deferred)

Merge WritableStreamoRecord's author methods into StreamoRecord (per
Turnstone's shape: signer-optional, throws-when-null); markWritable +
writableKeys + preregisterOursMounts dissolve as a consequence. Draft
remains as ephemeral facade. `Mirror.newDraft(signer)` is the author
entrypoint.

**Estimate per Turnstone:** ~200 LOC moved from WritableStreamoRecord.js
into StreamoRecord.js; delete WritableStreamoRecord.js; update ~15
import sites. Plus ~50 LOC removed across StreamoServer.js and
bin/streamo.js. Roughly medium refactor, real testing burden.

**When:** dedicated fresh session, not this one. The class-merge is
mechanical but wide.

### Item 7 blocks on full byte-array separation — later arc (11.x-shaped)

Retire pendingChainHash alignment-check. Per Turnstone's careful
insight: the check exists ONLY because wire-received and locally-
authored bytes share one byte-array. Retiring the check without the
byte-array split would leave a genuine safety-net gap.

**Full separation cost per Turnstone:** ~2000+ LOC. This IS the terminal
Mirror-and-Draft arc where Mirror gets wire-bytes-only, Draft holds
pending intent as a diff or separate storage, wire connection is
per-Mirror, up-flow is per-Draft.

**When:** major arc; not near-term.

## Wagtail's original mapping (still valid, moved from superseded doc)

**External consumers of wire-state cells (reads):**

| Cell | Count | Consumers |
|---|---|---|
| `hasRelay` | 1 | `originSync.js:81` |
| `caughtUpToRelay` | 1 | `sync-all.mjs:72,75,86` |
| `isReadyToAuthor` | 1 | `fileSync.js:470-471` |
| `relayChainHash` | 2 | `registrySync.js:606`, `WritableStreamoRecord.js:418` |
| `relaySubscribedAtOffset` | 0 external | (only via `caughtUpToRelay`) |
| `pushRejected` | 7 | `WritableStreamoRecord.js:416`, `chat/main.js:293`, 5 publish-\* scripts, `streamon.mjs:203` |
| `conflictDetected` | 3-4 | `WritableStreamoRecord.js:417,429`, `chat/main.js:293,685` |

**Mutators (called externally):**

| Setter | Called from |
|---|---|
| `_setRelayChainHash` | `relayInboundStream.js:133` (only) |
| `_setPushRejected` | `registrySync.js:510` (only) |
| `_setConflictDetected` | `relayInboundStream.js:115` (only) |
| `_setRelaySubscribedAtOffset` | `registrySync.js:478` (only) |
| `_attachSession` | `registrySync.js:825`, `originSync.js:81-82` |

**Tests touching wire-state:**
`StreamoRecord.test.js` + `registrySync.test.js`.

## The meta-observation this comparison surfaced

The compromise-flag-sedimentation candidate
([[candidates.md]] 2026-07-21 evening) fired again here: the
Mirror-and-Draft design was DESIGNED, DOCUMENTED, PARTIALLY SHIPPED,
AND SEALED-AS-PUZZLE — and Wagtail still re-derived it via a longer
route because the sealed-answers file was hidden as a fun test, and
the exploration-doc's own reasoning didn't fully register on first
read.

The puzzle-shape worked (Wagtail's guesses converged; item 7 diverged
productively) but the underlying dynamic is: **substrate discoverability
is asymmetric — writer knows exactly what she wrote; reader has to
find it.** Compromise-flags + sealed puzzles are good tools; regular
"scan for might-want-to-revisit" passes would be complementary.

## Sisters

- [`EXPLORATION-streamorecord-slimming.md`](./EXPLORATION-streamorecord-slimming.md) — 2026-05-26 compromise-flag doc
- [`EXPLORATION-sync-model.md`](../EXPLORATION-sync-model.md) — Mirror-and-Draft north-star
- [`EXPLORATION-wire-state-extraction.md`](./EXPLORATION-wire-state-extraction.md) — Wagtail's superseded 2026-07-21 proposal
- `memory/notes/2026-07-17-items-4-7-SEALED-ANSWERS.md` (in the-grove) — Turnstone's sealed answers
- `public/streamo/Draft.js` — the first-mile Draft class already shipped
- `memory/candidates.md` 2026-07-21 evening — the compromise-flag-sedimentation observation

— Wagtail, 2026-07-22 morning
