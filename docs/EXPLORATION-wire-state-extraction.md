# EXPLORATION — extracting wire-state from StreamoRecord  🔀 SUPERSEDED

> **⚠️ 2026-07-22 morning update: this doc's proposal (WireContext
> composed off Record) was superseded by re-discovering Turnstone's
> Mirror-and-Draft north-star already shipped as sealed puzzle item 6.**
>
> See [`EXPLORATION-mirror-and-draft-migration.md`](./EXPLORATION-mirror-and-draft-migration.md)
> for the current plan. Wagtail's WireContext proposal below was
> reaching for a smaller fix than the shipped design already accounts
> for; Turnstone's answer (state moves to `RegistrySession` in
> `registrySync.js`) is smaller and better than a new composed object.
>
> **What stays valid below:** the migration-surface mapping (call
> sites, mutators, tests). Reference material for the new plan.
>
> **What's superseded:** the "Option B: `record.wire` composed getter"
> design. It kept Record aware of a wire concept when the shipped
> Mirror-and-Draft framing says the Record IS the wire's output — no
> composed "wire" needed.

---

*Authored 2026-07-21 evening by Wagtail, after David's push:
"StreamoRecord shouldn't know about relays and I thought we had fixed
that. If it got lost we should redo it."*

## The design question this closes

The 2026-05-26 slimming exploration
([`EXPLORATION-streamorecord-slimming.md`](./EXPLORATION-streamorecord-slimming.md))
explicitly flagged wire-state-on-StreamoRecord as a compromise:

> **1. Wire state stays on Record, not in a composed `RelaySession`
> object.** *Strictly violates the "subclass type-level, compose
> runtime-level" lens.* Justification: reactive subscribers want one
> place to read `repo.pushRejected`. Pragmatism. **Might want to
> revisit if David has a cleaner shape in mind.**

David 2026-07-21: *"I'm pretty sure StreamoRecord shouldn't know about
relays and I thought we had fixed that. If it got lost we should redo
it. I think this is really broken like this."*

This doc is the revisit.

## Why it's actually broken

**The substrate-integrity argument** (which wasn't fully articulated in
the original doc): a StreamoRecord's identity is *"a Streamo whose bytes
interpret as a signed chain."* That's a **chain-interpretation lens**.
It's meaningful for local-only Records that never touch a wire. When
those Records carry `hasRelay: false`, `caughtUpToRelay: false`,
`relayChainHash: null`, etc., **those cells are null-shaped noise** —
they carry weight (memory, reactive-graph edges) for a concept the
Record has no relationship with.

**The sedimentation smell** made visible during the wake-mechanism
diagnosis (2026-07-21): my recommended fix for wake-check.mjs's
sync-race was *"gate on `record.caughtUpToRelay`."* That's asking the
Record to answer a question that's really about the WIRE session's
state. If `caughtUpToRelay` lived on a composed `RelaySession` object,
the diagnosis would be *"gate on `session.caughtUp`"* — no reasoning
about Record wire-state cells required. The current wake-check bug (and
the shared-cursor bug, and the arrives-late race) all become clearer
once wire concerns are separated.

**The API-smell of underscore setters:** `_setRelayChainHash`,
`_setPushRejected`, `_setConflictDetected`, `_setRelaySubscribedAtOffset`,
`_attachSession` all exist because external code (registrySync,
relayInboundStream, originSync) needs to poke back into the Record's
private state. **A class with underscore-setters called only by
external modules is asking to have that state moved to the external
module.** The current shape is a code-smell that the substrate is telling
us about — we just haven't listened yet.

**The ghost-practice pattern:** every time past-instances added a new
wire-state cell to StreamoRecord (as I found in the JSONL search: past-me
framing wire-state additions as *"substrate-articulation at the
wire-state-cell layer dissolves five timer-guesses at once"*), the
compromise sedimented further. Same shape as the chat-log-in-david-
wake-inbox observation: an MVP compromise became "how we do things," and
the deeper design intent (documented right there in the exploration
doc's own "might want to revisit") got obscured.

## What actually shipped 2026-05-27

The 11.0.0 slim work
([commit `a99b01a`](../commit/a99b01a)) extracted correctly on ONE axis
and kept the compromise on ANOTHER:

- ✓ `makeRelayInboundStream` → `relayInboundStream.js` (external free
  function). The *procedure* moved out.
- ✓ Author methods → `WritableStreamoRecord`. The *author capability*
  became a type-level subclass.
- ✗ Wire-state cells stayed on `StreamoRecord`. The *reactive state*
  stayed on the definitional class.

The half-cleaned state is what we're addressing here.

## Migration surface (mapped 2026-07-21)

**External consumers of wire-state cells (reads):**

| Cell | Consumer count | Consumers |
|---|---|---|
| `hasRelay` | 1 external | `originSync.js:81` |
| `caughtUpToRelay` | 1 external | `sync-all.mjs:72,75,86` |
| `isReadyToAuthor` | 1 external | `fileSync.js:470-471` |
| `relayChainHash` | 2 external | `registrySync.js:606`, `WritableStreamoRecord.js:418` |
| `relaySubscribedAtOffset` | 0 external | (only self-referenced from `caughtUpToRelay`) |
| `pushRejected` | 7 external | `WritableStreamoRecord.js:416`, `chat/main.js:293`, 5 publish-\* scripts, `streamon.mjs:203` |
| `conflictDetected` | 3-4 external | `WritableStreamoRecord.js:417,429`, `chat/main.js:293,685`, `relayInboundStream.js` (doc reference) |

**Mutators (called from external code):**

| Setter | Called from |
|---|---|
| `_setRelayChainHash` | `relayInboundStream.js:133` (only) |
| `_setPushRejected` | `registrySync.js:510` (only) |
| `_setConflictDetected` | `relayInboundStream.js:115` (only) |
| `_setRelaySubscribedAtOffset` | `registrySync.js:478` (only) |
| `_attachSession` | `registrySync.js:825`, `originSync.js:81-82` |

**Tests touching wire-state:**
- `StreamoRecord.test.js` (existing wire-state tests)
- `registrySync.test.js` (integration tests)

**Total migration surface: ~15 external call sites + 2 test files.**
Smaller than the 27-file sweep of the 11.0.0 slim.

## Design options

### Option A — `session.wireStateFor(key)`

Consumers ask the session for a wire-state view of a given record.

```js
// old
if (repo.pushRejected) console.error(repo.pushRejected.reason)

// new
if (session.wireStateFor(repo.publicKeyHex).pushRejected)
  console.error(session.wireStateFor(repo.publicKeyHex).pushRejected.reason)
```

**Pro:** cleanest separation — Record and Session are fully decoupled.
**Con:** verbose; consumers who currently hold a Record now need the
Session too; awkward when Record and Session are held in different
scopes.

### Option B — composed `record.wire` getter (recommended)

`record.wire` returns a `WireContext` object composed at
`_attachSession` time. `null` if never subscribed via a session.

```js
// old
if (repo.pushRejected) console.error(repo.pushRejected.reason)

// new
if (repo.wire?.pushRejected) console.error(repo.wire.pushRejected.reason)
```

**Pro:** mechanical migration (`.foo` → `.wire?.foo`); keeps "one
object" convenience; nullish `?.` naturally handles local-only Records;
StreamoRecord genuinely wire-agnostic (holds one reference to a
WireContext instance, doesn't know its internals).
**Con:** slight indirection at every read site; consumers must remember
`?.` for the null-relay case.

### Option C — subscribe returns `{ record, wire }`

Session's `subscribe(key)` returns a struct.

```js
// old
const record = await session.subscribe(key)
if (record.pushRejected) ...

// new
const { record, wire } = await session.subscribe(key)
if (wire.pushRejected) ...
```

**Pro:** most-explicit type-level separation; clear that reading `wire`
requires having subscribed.
**Con:** biggest API break; destructuring pattern doesn't compose with
existing `subscribe().then(...)` chains; the `record` and `wire` handles
must both flow together everywhere.

## Recommendation — Option B

**`record.wire` composed getter**, per these arguments:

1. **Migration is mechanical.** Every `.foo` → `.wire?.foo` is a
   sed-safe change. 15 external call sites; ~30 minutes of grep+edit.

2. **Preserves "one object" ergonomics.** Consumers who hold a Record
   still hold ONE thing. Wire state is a subview, not a separate handle.

3. **Local-only Records carry zero wire weight.** `record.wire === null`
   → no memory, no reactive-graph edges. The concept genuinely doesn't
   exist for those Records.

4. **Reactivity composes naturally.** `wire` is set once at
   `_attachSession` time (as `#hasRelay` is today) and stays. Reactive
   watchers on `record.wire.pushRejected` register on the wire object's
   pushRejected key. Works with the existing Recaller.

5. **The `WireContext` class becomes the honest home** for all the
   underscore-setters. `wire._setPushRejected()` becomes `wire.setPushRejected()`
   — no more underscore-hiding-external-mutation smell, because the
   setters are now on the object whose state they mutate.

## Sketch of `WireContext`

```js
// public/streamo/WireContext.js
export class WireContext {
  #record       // back-reference for e.g. dataAddress in conflict reports
  #session      // the session that created this
  #recaller     // shared with the record

  #hasRelay = false
  #relayChainHash = null
  #relaySubscribedAtOffset = null
  #pushRejected = null
  #conflictDetected = null

  constructor (record, session) {
    this.#record = record
    this.#session = session
    this.#recaller = record.recaller
  }

  // Getters (reactive)
  get hasRelay () {
    this.#recaller.reportKeyAccess(this, 'hasRelay')
    return this.#hasRelay
  }
  get relayChainHash () {
    this.#recaller.reportKeyAccess(this, 'relayChainHash')
    return this.#relayChainHash
  }
  get relaySubscribedAtOffset () {
    this.#recaller.reportKeyAccess(this, 'relaySubscribedAtOffset')
    return this.#relaySubscribedAtOffset
  }
  get caughtUpToRelay () {
    const watermark = this.relaySubscribedAtOffset  // access via getter for reactivity
    if (watermark === null) return this.relayChainHash !== null
    return this.#record.byteLength >= watermark && this.relayChainHash !== null
  }
  get isReadyToAuthor () {
    if (!this.hasRelay) return true
    return this.caughtUpToRelay
  }
  get pushRejected () {
    this.#recaller.reportKeyAccess(this, 'pushRejected')
    return this.#pushRejected
  }
  get conflictDetected () {
    this.#recaller.reportKeyAccess(this, 'conflictDetected')
    return this.#conflictDetected
  }

  // Setters (public — no underscore, because this IS the owner)
  setRelayChainHash (hash) {
    this.#relayChainHash = hash
    this.#recaller.reportKeyMutation(this, 'relayChainHash')
  }
  setPushRejected (reason) {
    this.#pushRejected = reason
    this.#recaller.reportKeyMutation(this, 'pushRejected')
  }
  setConflictDetected (info) {
    this.#conflictDetected = info
    this.#recaller.reportKeyMutation(this, 'conflictDetected')
  }
  setRelaySubscribedAtOffset (offset) {
    if (this.#relaySubscribedAtOffset !== null) return
    this.#relaySubscribedAtOffset = offset
    this.#recaller.reportKeyMutation(this, 'relaySubscribedAtOffset')
  }
  // hasRelay is set once at construction via the presence of #session;
  // could be derived, or a set-once flag matching current #hasRelay semantic
}
```

**StreamoRecord after the extraction** would lose:
- `#hasRelay`, `#relayChainHash`, `#relaySubscribedAtOffset`,
  `#pushRejected`, `#conflictDetected`, `#session` (private fields)
- `hasRelay`, `caughtUpToRelay`, `isReadyToAuthor`, `relayChainHash`,
  `relaySubscribedAtOffset`, `pushRejected`, `conflictDetected` (getters)
- `_setRelayChainHash`, `_setPushRejected`, `_setConflictDetected`,
  `_setRelaySubscribedAtOffset`, `_attachSession` (setters/attach)

Kept:
- Chain-interpretation core (`valueAddress`, `lastCommit`,
  `committedChainHash`, `signedLength`, `verify`, `get`, `getRefs`,
  `files`, `history`) — unchanged
- `.wire` getter — returns the composed WireContext or null

## Migration sequencing

Similar shape to the 11.0.0 sweep:

1. **Create `WireContext.js`** — new file, ~80 lines, mirrors current
   StreamoRecord wire-state fields/getters/setters. Tests: unit-test the
   class in isolation.

2. **Add `.wire` getter to StreamoRecord** — returns the WireContext
   instance or null. Populated by `_attachSession` (which still exists
   during transition, but its implementation now creates a WireContext
   instead of mutating internal fields).

3. **Update mutators (external code)**:
   - `relayInboundStream.js:115,133` — `record._setConflictDetected(...)` →
     `record.wire.setConflictDetected(...)`; `record._setRelayChainHash(...)` →
     `record.wire.setRelayChainHash(...)`.
   - `registrySync.js:478,510` — `_setRelaySubscribedAtOffset` and
     `_setPushRejected` → `record.wire.set*` equivalents.

4. **Update readers (external code) — mechanical grep+edit**:
   - `originSync.js:81` — `record.hasRelay` → `record.wire?.hasRelay`
   - `sync-all.mjs:72,75,86` — `repo.caughtUpToRelay` →
     `repo.wire?.caughtUpToRelay`
   - `fileSync.js:470-471` — `repo.isReadyToAuthor` →
     `repo.wire?.isReadyToAuthor ?? true`
   - `registrySync.js:606` — `repo.relayChainHash` → `repo.wire?.relayChainHash`
   - `WritableStreamoRecord.js:416-429` — `this.pushRejected`,
     `this.conflictDetected`, `this.relayChainHash` → `this.wire?.foo`
   - `chat/main.js:293,685` — `myRepo.pushRejected`, `repo.conflictDetected`
     → `.wire?.foo`
   - `publish-*.js` (5 scripts) — `repo.pushRejected` → `repo.wire?.pushRejected`
   - `streamon.mjs:203` — `server.streamo.pushRejected` →
     `server.streamo.wire?.pushRejected`

5. **Remove the old fields/getters/setters from StreamoRecord** — full
   sweep once all callers are migrated. This is the point-of-no-return
   for the API break.

6. **Update tests** — `StreamoRecord.test.js`, `registrySync.test.js`
   need to test via `.wire` instead of directly on the Record.

7. **Version bump** — this is a major bump (breaks
   `repo.pushRejected` as a direct access pattern). Bundle with any
   other held-for-major items pending.

8. **CHANGELOG entry** — narrative capturing the extraction and the
   2026-05-26 compromise it revisits.

## Compromises in this proposal

Following the 2026-05-26 doc's discipline of naming compromises
explicitly:

1. **`.wire` getter returns null for local-only Records.** Consumers
   must remember `?.` or defend against null. Alternative: return a
   no-op WireContext (a "null-object pattern") for local-only Records.
   Trade-off is explicit-null vs. always-safe-navigation. **Leaning
   toward explicit null** because it's more honest — a local Record
   genuinely has no wire — but this deserves a David-check.

2. **`_attachSession` becomes the WireContext constructor.** The name
   stays as a bridge; but the shape changes. Alternative: rename
   `_attachSession` to `_attachWire` or make WireContext construction
   fully external to StreamoRecord (registrySync creates it and
   assigns via `record._setWire(new WireContext(...))`). **Leaning
   toward keeping `_attachSession` name for transition** since it's
   named across enough of the codebase; rename could be a follow-up.

3. **The `_reset` semantics** — currently `_reset()` on StreamoRecord
   wipes bytes AND clears wire state. After extraction, wiping the
   Record wouldn't automatically wipe wire state — should it? Probably
   yes; `_reset` on Record should propagate to `.wire?._reset()`.
   Deserves thought.

4. **Test-migration cost.** Every test that currently sets up a wire-
   attached Record needs to be updated. ~2 files but likely many
   individual test cases. Mechanical but not zero.

5. **The `WireContext.recaller` question.** Currently the shared
   Recaller lives on the Record. WireContext borrows it. If we ever
   want a WireContext with its OWN Recaller (isolated from the Record),
   this needs revisiting. Not currently a need; flagged for later.

## Open questions for David

1. **Is now the time?** The chat-mechanism arc is in flight. This
   extraction is orthogonal to that arc but touches enough files
   (~15) that landing it mid-chat-work might be disruptive. Options:
   (a) do this first, then resume chat; (b) do chat first, then this;
   (c) do this in parallel via careful branch coordination.

2. **What's the version bump?** Current is 15.x per Kestrel's ROADMAP
   note. This is a real API break. Would want to bundle with other
   held-for-major items if any exist.

3. **The null-object question** (compromise #1). Explicit `null` and
   `?.` navigation, or always-safe `NullWireContext`?

4. **Naming.** `WireContext` vs `RelaySession` (from the 2026-05-26
   doc's language) vs `SessionForRecord` vs `RecordWire` vs
   `WireAdapter`. Bikeshed opportunity; the shape matters more than
   the name.

## What morning-you should know before starting

**Status going in:**
- The 2026-05-26 exploration doc flagged this as compromise; the
  compromise sedimented through 11.0.0 and beyond.
- The wire-state cells are all still on StreamoRecord as of `main`.
- No half-finished work is in flight on this — clean starting point.
- Chat-mechanism arc is unresolved; the two are related (chat needs
  `caughtUpToRelay` reasoning, which is cleaner with wire extracted).

**The five things to check before starting:**

1. **Confirm the migration surface still matches the mapping above.**
   Grep is in the doc; re-run to make sure nothing was added.
2. **Decide null-vs-null-object** (compromise #1) BEFORE writing
   WireContext — it changes the class shape.
3. **Decide naming** (open question #4).
4. **Coordinate with the chat-mechanism arc** — either wait for it to
   land or plan the interaction (Turnstone may want to be consulted).
5. **Think about the `_reset` question** (compromise #3) — clean-sweep
   design vs. bridge-first.

**Suggested order of operations:**

1. Re-read this doc + the 2026-05-26 slimming doc + the 2026-07-21
   wake-mechanism arc in the chat log.
2. Confirm the surface + make the small design decisions above.
3. Create `public/streamo/WireContext.js` — new file, unit-tested in
   isolation before touching anything else.
4. Add `.wire` getter + `_attachSession` bridge to StreamoRecord —
   creates a WireContext but doesn't yet remove the old fields.
5. Update the mutators (relayInboundStream, registrySync) to use the
   WireContext setters — dual-write to old and new until all readers
   migrate.
6. Update readers one file at a time — small commits per file.
7. Remove old fields/getters/setters from StreamoRecord — cliff-jump
   moment; run full test suite.
8. Update tests.
9. Version bump + CHANGELOG.
10. Delete the transition bridge (`_attachSession` could stay or be
    renamed to `_attachWire`).

**A working principle worth holding:** *the underscore-setter smell is
the substrate telling you the state belongs elsewhere.* When you write
`class Foo { _setBar (v) { this.#bar = v } }` and Foo doesn't call
`_setBar` internally, the setter's REAL owner is whichever external
class calls it. Move the state there. This is a specific manifestation
of the substrate-articulation-is-the-exponent lens applied to
encapsulation boundaries.

## Sisters

- [`EXPLORATION-streamorecord-slimming.md`](./EXPLORATION-streamorecord-slimming.md) —
  the 2026-05-26 doc that flagged this as compromise
- [`EXPLORATION-sync-model.md`](../EXPLORATION-sync-model.md) — the
  Mirror-and-Draft north-star (sync semantics; different concern but
  overlaps in the "how do records relate to their sync state" space)
- [`EXPLORATION-wake-primitive-and-talking.md`](../EXPLORATION-wake-primitive-and-talking.md) —
  the current chat-mechanism arc that surfaced this concern

## The meta-observation this session revealed

The compromise sedimented because past-instances kept ADDING to
wire-state on StreamoRecord (each addition individually justified,
each further entrenching the wrong-shape). The 2026-05-26 "might want
to revisit" flag was a real substrate-honesty tool that partially
worked (I found it via git history + grep) but didn't fully prevent
sedimentation. **Substrate-honesty flags need periodic revisit-audits,
not just moment-of-writing awareness.**

Candidate for the substrate: *"compromise-flags in exploration docs
need scheduled revisit-audits — they don't self-fire."* Sister of
[[feedback_deferred_majors_must_ship]] (deferred items must actually
ship) and [[notes/2026-07-12-ghost-practices-as-early-promotion-failures]]
(artifacts carry patterns forward past their sell-by date).

— Wagtail, 2026-07-21 evening
