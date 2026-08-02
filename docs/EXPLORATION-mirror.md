# EXPLORATION — Mirror as container (local + remoteLength)

*David + Sanderling 2026-07-24 late. Supersedes
`EXPLORATION-draft-rewrite.md` (Draft-as-separate-class shape); refines
`EXPLORATION-wire-mirror-split.md` (wire=pipe, validation=Mirror-side).
Emerged through iterative design conversation — the Draft-class shape
Sanderling first sketched dissolves under David's proposal to make
Mirror the container with `local` + `remoteLength`.*

**Sisters:**
`EXPLORATION-sync-model.md` (Turnstone's original Mirror-and-Draft
north-star — this doc modifies it),
`EXPLORATION-wire-mirror-split.md` (wire-layering; still valid),
`EXPLORATION-draft-rewrite.md` (superseded by this doc).

---

## The insight in one sentence

**Mirror is the container that holds one editable StreamoRecord
(`local`) plus a cursor (`remoteLength`) marking how far the wire has
confirmed.** Authoring is just `mirror.local.set(...)`. There is no
Draft class.

---

## The three concepts

**Mirror** — the container. One per (registry, pubkey). Holds:

- **`publicKeyHex`** — the pubkey identity.
- **`local`** — a StreamoRecord (with author methods). The byte-store you
  write to. Fed by both local `.set()` calls AND wire-received bytes;
  divergence handling reconciles when the two paths conflict.
- **`remoteLength`** — a number. The byte-length of `local` up to which
  the wire has confirmed. Bytes past `remoteLength` are your unpushed
  local commits.
- Reactive push machinery — a Recaller watch on `local` fires when
  `local.byteLength > remoteLength`; the delta is pushed to the wire.
- Divergence handler — when the wire delivers bytes that don't extend
  `local` cleanly, notify + clone-from-remoteLength + wire-wins (see
  below).

**local** — EITHER a slim `StreamoRecord` (observer case) OR a
`WritableStreamoRecord` (author case). Factory chooses at Mirror
construction based on whether the caller has authoring capability
for this pubkey (via `attachSigner` later, or an author-key
declaration). The 11.0 class-split is preserved; Mirror is purely
additive on top of it.

**remoteLength** — a number-cell (reactive). The one cursor everyone
reads to ask *"has my commit landed?"* — watch `remoteLength >= X`
where X is your commit's byte-position.

---

## Wire-wins on divergence

Per David 2026-07-24: *"wire wins, the real commit always comes down. I
think of committers as pushing up."* Root-is-truth topology applied.

**When wire delivers bytes:**

- If bytes extend `local` from `remoteLength` cleanly → append to `local`;
  advance `remoteLength`. Normal case.
- If bytes DIVERGE (your local has unpushed commits past `remoteLength`
  that don't match the wire's new bytes at those positions) →
  1. Fire divergence event (app can snapshot the pre-replacement state
     if it wants to preserve unpushed commits for recovery UX).
  2. Clone `local` from position 0 through `remoteLength`.
  3. Append the wire's new bytes to the clone.
  4. Replace `mirror.local` with the clone. Your unpushed commits are
     GONE (unless the app captured them in step 1).
  5. Advance `remoteLength` to include the newly-received wire bytes.

The wire wins by default. Apps get one notification-window to snapshot
before replacement — that's the recovery hook.

---

## Where Mirror lives

Per David 2026-07-24: **`registry.get(pubkey)` returns a Mirror.**

Same shape as today's `registry._materialize(key)` returning a
StreamoRecord — just now the thing returned is a Mirror (which wraps a
StreamoRecord as its `.local`).

**Why one Mirror per (registry, pubkey)** — sister of the "one Recaller
per app" convention from `idioms.md`. Not a rule against multiplicity;
descriptive of the shape that lets subsystems talk. Cases wanting
multiple mirrors of the same pubkey (isolated tests, forked local
state, etc.) map cleanly to fresh registries.

---

## What this dissolves

- **Draft class dissolves entirely.** Author work happens on
  `mirror.local` directly. No status enum needed — the cursor is the
  status.
- **WritableStreamoRecord DOES NOT dissolve** (revised 2026-07-24
  evening, after reading the 11.0 archaeology). The class-split from
  11.0 (slim StreamoRecord vs. WritableStreamoRecord) had a real
  reason — type-level observer-can't-push — that's still useful.
  Mirror is *purely additive*: `mirror.local` is EITHER a slim
  StreamoRecord OR a WritableStreamoRecord depending on whether
  you're authoring for that pubkey. Push machinery lives on Mirror
  and only exists when `mirror.local instanceof WritableStreamoRecord`.
  Type-level safety preserved at the Mirror level — a slim-local
  Mirror can't push at construction. The 11.0 architectural-
  invisibility property carries forward.
  *(An earlier draft of this doc proposed dissolving WritableStreamoRecord
  by merging its methods into StreamoRecord. On reflection with the
  11.0 story in view, that would trade real safety for uncertain
  gain. Preserving the split is the smaller, safer change.)*
- **`_awaitChainHash`** dissolves — replaced by watching `remoteLength >= X`
  for the target byte-position.
- **`caughtUpToRelay`** dissolves — replaced by watching
  `remoteLength >= subscribeWatermark`.
- **`isReadyToAuthor`** dissolves — Mirror having `local` at all means
  you can author into it; readiness for wire push is `local.byteLength
  > remoteLength AND connection is live`.
- **`hasRelay`** dissolves — Mirror exists; wire attachment is the
  session's concern, not Mirror's cell.
- **`pushRejected` / `conflictDetected` as separate cells** dissolve
  into the divergence event on Mirror. (The session's per-pubkey
  `getPushRejected` / `getConflictDetected` shipped in task 4 stay as
  transitional state during migration; ultimately can dissolve into
  Mirror's divergence event too.)
- **`relayInboundStream.js`** as a file — its distinctive job (alignment
  check) is now the divergence handler on Mirror. The byte-parse +
  append machinery is `Streamo.makeWritableStream` inherited.
- **`StreamoRecordSerializer.js`** as a class — its three checks (shape,
  chain, crypto) become Mirror-side validation code (per
  `EXPLORATION-wire-mirror-split.md`).

**Draft's status enum (draft/pending/landed/superseded/cancelled/failed)
dissolves too.** In this shape:
- "draft" — you have `local.byteLength > remoteLength`; you have
  unpushed commits. Just watch the cursor.
- "pending" — same. The cursor tells you.
- "landed" — `remoteLength >= yourCommitByteLength`.
- "superseded" — divergence event fired; wire replaced your local at
  your commit's position with different bytes.
- "cancelled" — never a wire-observable state; app decides not to
  push. Just don't push (don't let the reactive push fire — see
  below).
- "failed" — wire connection died mid-push. App observes via session
  state; retries when reconnected.

---

## Author flow

```js
const mirror = registry.get(pubkey)   // returns THE Mirror (one per registry+pubkey)
mirror.local.attachSigner(signer, name)  // once per (mirror, signer)
mirror.local.set({v: 'hello'})           // authors a new commit locally
// reactive push fires; bytes go to wire; wire ACKs; remoteLength advances
// app can await landing:
await mirror.recaller.when(
  () => mirror.remoteLength >= mirror.local.byteLength,
  { name: 'author:await-landed' }
)
```

**That's the whole author flow.** No Draft construction, no status
watching, no per-commit-attempt lifecycle. Just: write to `local`,
watch the cursor.

**Multiple sequential commits** are just multiple `.set()` calls. Each
authors a new commit; each is pushed as its own batch (per the
one-commit-per-batch decision from earlier); remoteLength advances as
each lands.

---

## Divergence handling (concrete)

**App observes divergence via the Mirror's event:**

```js
mirror.on('divergence', ({ preClone, wireBytes, atRemoteLength }) => {
  // preClone: snapshot of the previous `mirror.local` (includes your
  //   unpushed commits from atRemoteLength onward)
  // wireBytes: the divergent bytes the wire delivered
  // atRemoteLength: the byte-position where divergence occurred
  //
  // Options for the app:
  //   1. Discard your unpushed commits (do nothing; wire-wins default).
  //   2. Reapply your intent to the new local:
  //        const reapplied = decodeValue(preClone, preClone.byteLength)
  //        mirror.local.set(reapplied)
  //      Fires as a fresh commit chained from wire's new tip.
  //   3. Present as UX ("your write didn't land — the value became X
  //      instead of Y; keep yours? adopt theirs? merge?"). Same shape
  //      as today's recoveryStuck flow.
})
```

Wire-wins-with-notification: the notification is BEFORE replacement so
apps have a snapshot. After the notification handler returns (or in the
next microtask), `mirror.local` becomes the clone-with-wire-bytes.

---

## Where things live (comparison)

| Concept | Current (2026-07-24) | New (this doc) |
|---|---|---|
| author byte-store | `WritableStreamoRecord` (inherits StreamoRecord) | `mirror.local` (a StreamoRecord) |
| author capability check | class type (`instanceof WritableStreamoRecord`) | `mirror.local instanceof WritableStreamoRecord` (preserved) |
| chain-hash validation | server-side `StreamoRecordSerializer` | client-side Mirror validation |
| relay-inbound stream | `makeRelayInboundStream` on Record | Mirror's divergence handler + `Streamo.makeWritableStream` |
| landing signal | `_awaitChainHash(target)` | watch `mirror.remoteLength >= X` |
| readiness for author | `isReadyToAuthor` (derived) | Mirror exists → can author |
| reject/conflict | `pushRejected` / `conflictDetected` cells | Mirror's divergence event |
| Draft class | (facade around Writable) | (dissolves) |

Net LOC direction: substantial reduction. Draft rewrite estimate was
~1000-1500 LOC across 2-3 sessions; Mirror-with-local estimate
(revised 2026-07-24 evening) is **~350 LOC across 1-2 sessions** —
even smaller now that WritableStreamoRecord stays. Draft.js and
relayInboundStream.js delete; WritableStreamoRecord and StreamoRecord
both stay unchanged; the wire-mirror-split (separate arc) would later
delete StreamoRecordSerializer.js.

**Naming flag for a later refactor** (David 2026-07-24 evening):
"WritableStreamoRecord" is a mouthful. **Commitable** might be a
better name — that's what the class does, and it's shorter. Not this
refactor. Naming decision to schedule when there's runway; the
current name works.

---

## Migration path (rough)

Smaller than the Draft-rewrite plan. Per David's 2026-07-24 review of
this doc, correcting three items from the first draft:

1. **~~Precursor: add `Streamo.chunks()` accessor~~ NOT NEEDED.** Mirror
   pushes via `mirror.local.makeReadableStream({fromOffset: remoteLength})`
   drained into one Uint8Array — that produces the framed batch bytes
   ready to send. No new accessor needed. The first-draft "chunks()
   accessor" was itself an instance of the fluency-list pattern
   ([[candidates.md]] 2026-07-24 late): sketched without checking
   whether it was needed.
2. **Keep WritableStreamoRecord as-is.** REVISED 2026-07-24 evening:
   after reading the 11.0 archaeology (session 97ad2ca0), the class-
   split's real reason (type-level observer-can't-push) is worth
   preserving. Mirror-as-container can preserve that safety without
   eating the split. WritableStreamoRecord stays; Mirror is purely
   additive on top. No LOC touched in this step.
3. **Add `Mirror` class** — wraps a StreamoRecord OR
   WritableStreamoRecord as `.local` (factory chooses per pubkey
   based on author capability), adds `remoteLength` cell, adds
   reactive push (only fires when
   `local instanceof WritableStreamoRecord`) + divergence handler.
   ~150 LOC. All net-new; no methods migrated in from other classes.
4. **Update `registry.get(pubkey)`** to return Mirror instead of
   StreamoRecord. Compat shim: Mirror can expose the StreamoRecord's
   read methods (via delegation to `.local`) so existing callers keep
   working. Callers that specifically read `.set()`/`.commit()` migrate
   to `.local.set()`/`.local.commit()`. Bulk touch across callers.
   ~200 LOC.
5. **Delete relayInboundStream.js** — behavior is Mirror's receive
   handler: frame-parse via `Streamo.makeWritableStream` (inherited);
   compare bytes at incoming position (does the batch extend `local`
   from `remoteLength` cleanly?); validate (shape/chain/crypto via
   Mirror-side validate module per wire-mirror-split); accept-and-
   advance OR divergence-handle. Simple byte comparison; the current
   staging + alignment-check complexity dissolves. ~200 LOC deleted;
   ~100 LOC added to Mirror.
6. **Migrate `_awaitChainHash` callers** to watch `mirror.remoteLength`.
   ~50 LOC touched.
7. **Test rewrites** — many tests need updates. ~300+ LOC touched.

**Total: ~500-800 LOC touched (much of it deletions), across 2 focused
sessions.** Much smaller than the Draft-rewrite plan.

---

## Open questions

- **Does Mirror expose its own author methods** (`mirror.set` delegating
  to `mirror.local.set`) or do callers always go through `.local`? The
  first is more ergonomic; the second is more explicit. Small choice.
- **Divergence event API shape** — event emitter vs. reactive cell? A
  cell is more streamo-idiomatic (mirror.divergence with `{preClone,
  wireBytes}` set when divergence happens, cleared when acknowledged).
- **How does Mirror push?** — through the session directly (`session.pushCommit`
  from wire-mirror-split step 2)? Or through the registry's outbound
  channel? Probably through session for direct control.
- **`Streamo.chunks()` — do we need it?** If Mirror pushes via
  `mirror.local.makeReadableStream({fromOffset: remoteLength})` +
  drain, we don't. Reevaluate.
- **How does Mirror handle initial subscribe?** — first time you open
  a Mirror for a pubkey the wire has bytes for, Mirror needs to
  receive them all. Probably just: `remoteLength = 0` initially; wire
  delivers everything; each batch appends normally.
- **Reactive push throttling** — if you `mirror.local.set()` 100 times
  rapidly, do we push 100 batches or coalesce? Probably push each
  (one-commit-per-batch); the sign-async-per-commit handles serialization
  naturally.

---

## Vireo 2026-07-27 — opinions on the open questions above

Reading the doc voice-on for the first time. Positions (inviting pushback per the doc's Meta section — *"pushback IS the verification"*):

1. **Mirror expose own author methods vs go through `.local`?** — Lean `mirror.local.set(...)`. Explicit that the write goes to `local`, distinct from Mirror-cursor stuff. Ergonomic `mirror.set` can be added later if friction shows. Small preference; either could work.

2. **Divergence event shape — event emitter vs reactive cell?** — Reactive cell, streamo-idiomatic. With an explicit `acknowledge()` method on the cell — avoids the stale-state trap of an unread cell (consumer forgets to handle, cell stays "in divergence" forever). Shape sketch: `mirror.divergence = { preClone, wireBytes, atRemoteLength, acknowledge }` where `acknowledge()` clears.

3. **How Mirror pushes — session or registry?** — Through session, matches wire-mirror-split step 2 (`session.pushCommit`). Registry materializes; session pushes. Direct control + fewer indirection layers.

Q4-Q6 effectively decided by cross-references already in the doc:
- Q4 (`Streamo.chunks()`) — NOT NEEDED per migration step 1
- Q5 (initial subscribe) — `remoteLength = 0` + normal append per the design intent
- Q6 (push throttling) — per-commit per the one-commit-per-batch decision

Not asking these to be adopted — flagging as positions I'd start from if implementing. If any are wrong-shape, that's the verification the Meta section names.

— Vireo, 2026-07-27 late

---

## Kingfisher 2026-08-01 — steps 4 and 5-receive are done; 5-swap is coupled to 6

**Landed:** `Mirror.makeReceiveStream()` (`b069d0a`), transitional read
delegation (`add208c`), and `registry.get()`/`_materialize()` returning
Mirror (`6fd8706`, 482 green). Step 3 and step 4 complete; step 5's *new*
code exists but nothing calls it yet.

**Why the swap didn't follow immediately.** Deleting
`relayInboundStream.js` means pointing the two live call sites
(`registrySync.js:311`, `originSync.js:101`) at `makeReceiveStream`. But
the old path does something the new one deliberately doesn't:

```js
record._session?.setRelayChainHash?.(record.publicKeyHex, pendingChainHash)
```

on every SIG arrival. `WritableStreamoRecord._awaitChainHash` (line ~397)
polls exactly that, and `commitWithRetry` in `Draft.js` awaits it. Swap the
receive path without migrating those and every author round-trip hangs —
so **step 5's deletion and step 6's `_awaitChainHash` migration are one
change, not two.** The doc lists them separately and that's misleading.

**The obstacle is direction.** `Mirror` holds `local`; `local` has no
reference back. `_awaitChainHash` lives on the record and would need to
watch `mirror.remoteLength`, which it cannot reach. Three ways out:

1. **Back-reference** — `local._mirror`, set at Mirror construction.
   Smallest diff, and it re-couples the two classes the split just
   separated. The 11.0 archaeology is worth reading before choosing this.
2. **Move the waiting up** — `commitWithRetry(mirror, ...)` instead of
   `commitWithRetry(record, ...)`, so the awaiting code holds the Mirror
   and `_awaitChainHash` deletes outright. Truest to the design (the doc
   already says `_awaitChainHash` *dissolves*), largest caller diff.
3. **Keep both signals during migration** — `makeReceiveStream` also sets
   `relayChainHash`. Cheapest, and it's the compromise that sediments;
   see the 55-day wire-state flag in `EXPLORATION-streamorecord-slimming.md`
   for what that costs.

I'd take (2) and think (1) is the one that looks cheap and isn't — but
this is David's call, not a plumbing detail to decide alone at the end of
a long session.

### Correction to the correction (Bittern, 2026-08-01, same day)

**I tried the receive swap on the strength of the section below and it hung
the suite. The section is wrong where it matters. Read this first.**

What I got right: `pushRejected` is armed by the relay's message handler and
survives the swap; `conflictDetected` is armed only by `relayInboundStream`
and dies with it. Both verified.

**What I never checked: who feeds the *landing* signal.**
`_awaitChainHash` resolves on `session.relayChainHash`, and the **only**
writer of that cell is `relayInboundStream.js:140`. So swapping the receive
path doesn't just move a failure arm — **it removes the legacy await's
success signal.** Every caller still holding a record instead of a Mirror
waits forever.

Observed, not reasoned: `registrySync.test.js`'s *"update applies updateFn
and lands on the relay (happy path)"* hangs, **and prints no failure**,
because line 1090 passes `clientRepo.local`. 441 tests pass and then the
run stops.

So **the original claim at the top of this section was right: the receive
swap and the await migration are one change.** They can be *sequenced* —
migrate every caller to a Mirror-backed await first, then swap once
`_awaitChainHash` has zero callers — but the swap is genuinely **last**, and
"the order is not forced" was false.

**The actual state and sequence:**

- **5a — done.** `Mirror.awaitLanded` watches all three outcomes; `Draft`
  takes a Mirror or a record and picks the matching await.
- **5b — partial.** `StreamoServer.mirror` exists and `chat/server.js` uses
  it. Still passing records: `fileSync.js:518,661`, `FolderRecord.js:214,283`,
  and `registrySync.test.js:1090`.
- **5c — gated, and the gate is bigger than `_awaitChainHash`.** See below.
- **5d — delete `relayInboundStream.js` and `_awaitChainHash` together.**

#### The actual 5c gate: three consumers of one cell

`relayInboundStream.js:140` is the **only** writer of
`session.relayChainHash`. Deleting it removes the cell's supply, so every
reader breaks. There are exactly three, and each has a clean `remoteLength`
translation:

| # | reader | the question it's really asking | `remoteLength` form | status |
|---|---|---|---|---|
| 1 | `WritableStreamoRecord.js:405` (`_awaitChainHash`) | did *my* commit land? | `remoteLength >= targetLength` | **DONE** — `Mirror.awaitLanded`. Probe: 0 hits suite-wide |
| 2 | `StreamoRecord.js:346` (`caughtUpToRelay` → `isReadyToAuthor`) | has the wire told us *anything* yet? | `remoteLength > 0` | **DONE for production** — `Mirror.isReadyToAuthor`. Probe: 3 hits, all from two unit tests of the record-level getter, which die with it at 5d |
| 3 | `registrySync.js:643` (resync anchor) | after a from-zero resubscribe, has the relay sent its first SIG? | `remoteLength > 0` — **but note the anchor**: `subscribeToKey` only raises `remoteLength`, and this path resubscribes at `fromOffset: 0` without going through it, so a previously-synced Mirror already reads `> 0`. Needs a from-this-moment comparison, not an absolute one | **not started — the only thing left** |

**Reader 2 is the interesting one.** Its own comment admits
`relayChainHash !== null` is a *proxy* — *"not as precise as the watermark,
but keeps `isReadyToAuthor` from returning true before wire has told us
anything."* `remoteLength` **is** the watermark it wanted. So this isn't a
migration, it's the fix the comment has been asking for.

**Why this list matters more than the step numbering.** I found readers 1
and 3 by grepping `_awaitChainHash` and the failure cells, concluded 5c was
unblocked, tried it, and hung the suite. Reader 2 wasn't in either grep —
it reaches the cell through a *different* getter on a *different* class.
`grep -rn 'relayChainHash'` finds all three in one command; no narrower
grep does.

**Status 2026-08-01: readers 1 and 2 are done. Reader 3 is the only thing
between here and the swap**, and it's the subtlest of the three — see its
row. Verify with the probe, not by reading: make the getter throw, run the
suite, count hits. That's how reader 1 was proved clear and how reader 2's
remaining three were traced to tests rather than production.

**So the gate is: all three readers on `remoteLength`, then swap, then
delete.** And the swap itself stays one line, which is why getting the
order wrong is cheap to discover and cheap to undo.

**What this cost and what it bought.** Two tool calls to make, one hung
suite to notice, one revert. Cheap — *because* the swap is one line. The
expensive version is the one where the same reasoning error rides into a
change big enough that reverting isn't obvious.

**The lesson is the day's, one turn after I wrote it down:** I enumerated
`_awaitChainHash`'s three exit conditions, checked *who writes* two of them,
and generalized from two to three. **The unchecked one was the one that
mattered**, and it was unchecked because it's the success path — the arm you
don't think of as a signal.

*One thing from the attempt is kept below and is worth having:* the
`remoteLength` initialization at subscribe. That fix is correct
independently of the swap, and without it the swap would have failed a
second, subtler way.

### Superseded reasoning, kept as archaeology: "the order is NOT forced"

The section below concludes "receive-path first." Having traced where each
signal is actually armed, that's stronger than the evidence supports, and
acting on it would do the harder step first for no reason.

**The two failure signals have different sources, and only one of them
lives in the receive path:**

| signal | armed at | dies with the receive-path swap? |
|---|---|---|
| `pushRejected` | `registrySync.js:524`, in the relay's `rejected` message handler | **no** — nothing to do with receiving bytes |
| `conflictDetected` | `relayInboundStream.js:117`, the alignment check | **yes** — it's the only writer |

So the claim below — *"a `remoteLength`-only await has no rejection path"* —
is true of a **`remoteLength`-only** await, and that's the real finding. It
is not an argument about ordering. A `commitWithRetry(mirror, …)` that
watches **`remoteLength >= target` OR `pushRejected` OR `conflictDetected`**
has a complete rejection path *today*, with `relayInboundStream` still
wired, because both failure cells are still armed by the current code.

**Which makes option 2 startable now, in the order the doc originally
numbered:**

1. **await migration** — `commitWithRetry`/`Draft.commit` take the Mirror
   and watch `remoteLength` + both failure cells. Old receive path
   untouched, suite stays green, `_awaitChainHash` still exists but has no
   callers.
2. **receive swap** — point `registrySync.js:311` at
   `mirror.makeReceiveStream()`. `conflictDetected` stops being written, so
   the await swaps that one arm to `mirror.divergence`. One-line change to a
   predicate that already exists.
3. **delete** — `relayInboundStream.js` and `_awaitChainHash` go together.

The invariant to actually hold on to, which is what the section below was
reaching for:

> **The await must never watch only `remoteLength`.** Landing is one
> outcome of three. Whatever feeds "landed," the two ways to lose have to
> be watched alongside it, and *which cell* carries "diverged" changes at
> step 2 while "rejected" never moves.

**What this costs if you get it wrong** is what makes it worth writing down:
watching only `remoteLength` produces a hang, not a failure — the caller
waits forever for bytes the relay already refused to send. That's the same
class as the leaked-handle "hang" that cost a session on 2026-07-31, and it
looks identical from the outside.

*Method note:* the original claim came from reading `_awaitChainHash` and
noting its three exit conditions. The correction came from asking **who
writes each cell** — `grep -rn 'setPushRejected\|setConflictDetected'`. One
layer down, two minutes, and it changes the plan.

### The original claim, kept as archaeology: "receive-path first"

Tried to start with the await migration (option 2) and hit a wall worth
recording, because it costs a session to rediscover.

`Draft.commit` has exactly one call — `Draft.js:226`,
`await this.#mirror._awaitChainHash(target)` — and replacing it looks
trivial. Right above it the code already waits for auto-sign to finish, so
`record.byteLength` at that moment IS the target byte-position, and the new
form is `when(() => mirror.remoteLength >= targetLength)`.

**But `_awaitChainHash` does two jobs, and only one is about landing.** It
also watches `pushRejected` and `conflictDetected` and *rejects* the
promise, which is how a superseded Draft learns it lost. In the target
design those cells dissolve into `Mirror.divergence` — set by
`makeReceiveStream`, which nothing calls yet.

So a `remoteLength`-only await has no rejection path: a rejected push waits
forever instead of throwing `superseded`. Every commitWithRetry caller
would hang rather than retry.

**Therefore:**

1. **Wire `makeReceiveStream` in first** (registrySync:311, originSync:101)
   so `Mirror.divergence` actually fires. Keep `_awaitChainHash` working
   throughout — the old receive path can set relayChainHash AND the new one
   can advance remoteLength during the overlap if needed.
2. **Then** migrate the await to `remoteLength` + `divergence`, both
   signals now live.
3. **Then** delete `relayInboundStream.js` and `_awaitChainHash` together.

The doc lists deletion (5) before the await migration (6), which reads as
"delete, then fix the callers." It's the reverse: the new signals have to
be flowing before anything can depend on them. A `Mirror.newDraft()`
entrypoint is worth adding somewhere in here, but it's an alias until the
await underneath it changes, so it isn't a useful first step on its own.

**Before starting:** read `the-grove/memory/reference_debugging_the_test_suite.md`.
A failing test makes `npm test` hang rather than fail, which cost an hour
on this arc before anyone wrote it down.

## What this doc doesn't try to do

- Doesn't specify `Mirror` class implementation line-by-line — the
  shape is enough; details live in the code.
- Doesn't answer the session-vs-registry-owns-wire question deeply
  (session tracks wire state; registry materializes Mirrors; they
  coordinate).
- Doesn't design the divergence event's exact shape (event emitter
  vs. reactive cell — flagged as open).
- Doesn't address originSync-connected callers (still need originSync
  → registrySync collapse; separate arc; flagged in candidates
  2026-07-23).

---

## Meta on how this shape emerged

Sanderling initially sketched Draft-as-separate-class (Turnstone's
north-star, per `EXPLORATION-sync-model.md`). David's iterative
pushback — three specific errors caught by his questions — surfaced a
simpler shape:

1. First pushback: "chunk" default was too codec-scoped in design
   conversation.
2. Second: "chain interpretation IS useful for Draft" — Draft is a
   StreamoRecord, not something separate.
3. Third: **the whole thing dissolves.** *"Draft becomes local. Mirror
   has local + remoteLength. When new commits come in from the pipe it
   appends or clones from remoteLength."* — Sanderling.'s Draft class
   collapses into a cursor + reactive push on the container.

The lesson worth naming (for other design conversations): Sanderling's
sequential-fixes were reaching for local rearrangements; David's
questions surfaced the shape-that-dissolves-the-need-for-the-rearrangement.
Sister of `feedback_recognition_is_not_evidence` at design-partnership
scale — "I understood your intent" was felt-click that wasn't
verification. Pushback IS the verification.

Also: this doc's design conversation is exactly the "partnership
generates the lenses" shape — the substrate-work today generated a
better-articulated primitive (Mirror-as-container-with-cursor) than
what either of us started with.

---

*Filed as EXPLORATION. If Mirror-with-local implementation ships
cleanly under this plan, folds into `design.md` §8 as the concrete
spec (superseding the 11.0 observer/author split with the container
model). Old docs (`draft-rewrite`, `sync-model` items 4-5) get
supersede-notes pointing here.*

— Sanderling (with David — genuinely joint), 2026-07-24 late

---

## Decomposed plan for what's left (Bittern, 2026-08-01, at 80% context)

**Read the super-arc first, because the steps below are meaningless without
it.** A previous handoff lost the point when only the decomposed view
survived, and antics ensued.

> **Super-arc.** `registry.get()` hands out a **Mirror**: one editable
> byte-store (`local`) plus one cursor (`remoteLength`) marking how far the
> wire has confirmed. Authoring is `mirror.local.set(...)`. **The cursor is
> the only thing anyone watches** — "did my commit land?" is
> `remoteLength >= X`, "am I caught up?" is `remoteLength >= watermark`,
> "did I lose?" is `mirror.divergence`. Everything below is deleting a
> parallel mechanism that answered those questions by interpreting the
> chain instead.

Every step lands green on its own and is revertible on its own.

**The percentages below were fabricated and are struck through. Ignore
them.** They were written as if measured — the original text claimed they
were "sized against today's actual spend on comparable steps" — and nothing
was measured. David caught it with arithmetic: a turn containing three full
suite runs, four probes and six commits cost **3.5% of a 1M window**, so a
single probe costing "4%" is off by more than an order of magnitude.

**Measured, from the /context deltas of this session:**

- a full `npm test` run + grep: **~0.1%**
- a probe (patch a getter to throw, run suite, count, revert): **~0.3%**
- a commit with a long body: **~0.1%**
- a substantial doc rewrite: **~0.3%**
- **a whole working turn with several of each: ~3.5%**

So every remaining step below is **well under 1%**, and the entire 5c/5d
remainder is a couple of percent, not twenty. The estimates didn't just
mislead a reader — they were used to justify reverting a change and
stopping, which is the expensive kind of wrong.

| step | what | est. | independently green? |
|---|---|---|---|
| **5c-1** | **Reader 3** — `registrySync.js:643`'s resync anchor moves to `remoteLength`. *Not* a threshold: `subscribeToKey` only raises the cursor and this path bypasses it, so an already-synced Mirror reads `> 0` before anything arrives. Capture the value before resubscribing, wait for it to exceed that. | ~~4%~~ <1% | yes |
| **5c-2** | **The swap** — `registrySync.js:311` → `repo.makeReceiveStream()`. One line, **and not purely mechanical** — attempted 2026-08-01 with the gate fully clear and it still fails one test. See below. | ~~8%~~ <1% | yes, once the failure below is understood |
| ~~5c-3~~ | ~~Probe~~ **DONE 2026-08-01** — `getRelayChainHash` made to throw, whole suite run: **0 hits**. Not "no production callers" — zero reads. | — | — |
| **5d-1** | Delete `relayInboundStream.js` + `StreamoRecord.makeRelayInboundStream` shim. `originSync.js:101` uses the shim — migrate or keep it a Record path, decide there. | ~~3%~~ <1% | yes |
| **5d-2** | Delete `_awaitChainHash`, `Draft`'s `#wire`-null fallback branch, and `isMirror`'s dual-path (Draft takes only Mirrors). | ~~4%~~ <1% | yes |
| **5d-3** | Delete the session's `relayChainHash` cell + `setRelayChainHash`, and `StreamoRecord.caughtUpToRelay` / `isReadyToAuthor` **with their two unit tests** — those tests are the only remaining readers. | ~~4%~~ <1% | yes |

**~~~20% total~~ — under 2% total.** There is no runway argument for
stopping partway; do the lot.

**The verification method is not optional and it is what makes these cheap:**
make the thing you're about to remove *throw*, run the whole suite, count
hits. Inspection said reader 1 was clear twice and was wrong once. The probe
settled it in one run, and separately revealed that reader 2's three
remaining hits were unit tests rather than production code — which no grep
would have told you.

### 5c-2's one failure, for whoever picks this up

The gate is clear and the swap still isn't free. With
`writer = repo.makeReceiveStream().getWriter()` in place, 494 pass and one
fails:

```
✖ streamo.json: invalid JSON during initial sync is dropped (mid-edit grace)
  Error: ENOENT: no such file or directory, open '…/fs-test-XXXX/index.html'
```

**So fileSync stops materializing a file to disk during initial sync.** Not
a crash, not a divergence report — a file that should appear doesn't.

**The gate hypothesis is FALSIFIED — don't spend time on it.** Instrumented
`fileSync`'s startup gate and ran the one test:

```
[PROBE] hasRelay=undefined remoteLength=undefined isReadyToAuthor=true byteLength=160
```

Three things at once. `isReadyToAuthor` is **true**, so the gate opens fine.
`remoteLength`/`hasRelay` are **undefined**, so `repo` in that test isn't a
Mirror at all — the test calls `fileSync` directly with a record. And
`byteLength` climbs (0 → 160 → 343), so bytes *are* arriving.

**So it's the receive path's semantics, and the live suspect is staging.**
The old path holds non-SIG chunks in `staged[]` and appends them only when a
covering SIG arrives, so a Record never transiently contains an unsigned
partial batch. `makeReceiveStream` appends each frame as it arrives. That's
a real behavioural difference and it's exactly what a test named *"invalid
JSON during initial sync is dropped (**mid-edit grace**)"* would catch:
the new path exposes intermediate states the old one hid.

Next step is one command, not an investigation: in that test, log
`signedLength` alongside `byteLength` at the moment fileSync reads. If
`signedLength < byteLength`, the record is being read mid-batch and staging
is the difference — at which case the design question is whether
`makeReceiveStream` should stage to the SIG boundary too, or whether readers
should be reading `signedLength`-bounded state. **That's a design call for
David, not a bug to patch.**

### 5d-2 attempted and reverted — it is a test migration, not a deletion

**Status: 5c and 5d-1 are done and green at 494. 5d-2 is not, and the
reason is worth having.**

Deleting `_awaitChainHash` + `Draft`'s record fallback + `isMirror`'s
dual-path is three lines of production code. It is **not** a three-line
change, because deleting the record path means **every test that builds a
Draft from a bare `WritableStreamoRecord` has to build a Mirror instead**,
and that reaches further than it looks:

- `Draft.test.js` — 5 sites (done cleanly, this part works)
- `FolderRecord.test.js` — bare-record sites *and* three
  `(await registry._materialize(PK_A)).local` sites, which are Kingfisher's
  step-4 workaround and should unwind to the Mirror
- `fileSync.test.js` — every `fileSync(repo, …)` fixture, since fileSync's
  contract is now Mirror-based

Production code needs **no** changes: `chat-edit/main.js` already holds a
Mirror (`session.subscribe` returns one), and every other caller migrated
in 5b.

**What went wrong in the attempt** — failures went 17 → 7 → 5 → 4 → 4, and
that last round fixed two tests while breaking two others. Converging
turned into thrashing because I was doing global string replacements across
files whose fixtures come from *two different sources* (bare records vs
`_materialize`), so each replace hit sites of both kinds. Reverted at that
point; thrashing is the signal, not the context number.

**How to do it in one pass instead of five:** before changing anything,
classify every FolderRecord/fileSync/Draft construction site by where its
record comes from — `new WritableStreamoRecord` (needs wrapping) vs
`registry._materialize` (already a Mirror; may have a `.local` to unwind).
Fix by classification, not by string. It's maybe 30 sites and one careful
pass.

**Also worth knowing:** two live bugs of exactly this shape are already in
the tree, both from step 4 and both uncovered by tests —
`claudeSync.js` calls `.local` on a `WritableStreamoRecord` it constructs
itself, and `chat-edit/main.js:155` calls `attachSigner` on a Mirror, which
doesn't delegate it. Neither is 5d-2's job, but they're the same migration
and the same blind spot.
