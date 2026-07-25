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

**local** — a `StreamoRecord` you can write to (has `set`, `commit`,
`sign`, `attachSigner`). Not a separate class; just a StreamoRecord
attached to Mirror.

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
- **WritableStreamoRecord dissolves.** `mirror.local` IS a StreamoRecord
  that supports authoring (has `set`, `commit`, `sign`, etc.). The
  11.0 type-level "observer can't push" guard becomes "if you don't
  have Mirror, you don't have `local`, you can't push" — dissolved at
  the container level rather than the class level.
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
| author capability check | class type (`instanceof WritableStreamoRecord`) | `mirror.local.hasSigner` |
| chain-hash validation | server-side `StreamoRecordSerializer` | client-side Mirror validation |
| relay-inbound stream | `makeRelayInboundStream` on Record | Mirror's divergence handler + `Streamo.makeWritableStream` |
| landing signal | `_awaitChainHash(target)` | watch `mirror.remoteLength >= X` |
| readiness for author | `isReadyToAuthor` (derived) | Mirror exists → can author |
| reject/conflict | `pushRejected` / `conflictDetected` cells | Mirror's divergence event |
| Draft class | (facade around Writable) | (dissolves) |

Net LOC direction: substantial reduction. Draft rewrite estimate was
~1000-1500 LOC across 2-3 sessions; Mirror-with-local estimate is
~300-500 LOC across 2 sessions. WritableStreamoRecord, Draft.js,
relayInboundStream.js, and eventually StreamoRecordSerializer.js all
delete.

---

## Migration path (rough)

Smaller than the Draft-rewrite plan:

1. **Precursor: add `Streamo.chunks()` accessor** — same as before, ~10
   LOC. Actually may not be needed at all if `slice(0, byteLength)` +
   `makeReadableStream` cover it. Re-evaluate.
2. **Add `Mirror` class** — wraps a StreamoRecord as `.local`, adds
   `remoteLength` cell, adds reactive push + divergence handler. ~150
   LOC.
3. **Update `registry.get(pubkey)`** to return Mirror instead of
   StreamoRecord. Compat shim: Mirror can expose the StreamoRecord's
   read methods (via delegation to `.local`) so existing callers keep
   working. Callers that specifically read `.set()`/`.commit()` migrate
   to `.local.set()`/`.local.commit()`. Bulk touch across callers.
   ~200 LOC.
4. **Delete WritableStreamoRecord.** Author capabilities are on
   `mirror.local` which is a StreamoRecord — so StreamoRecord needs
   the author methods merged in (or `local` is specifically a
   WritableStreamoRecord that stays around internally as a subclass).
   Design choice: probably merge into StreamoRecord and delete Writable
   — matches the Draft dissolution.
5. **Delete relayInboundStream.js** — logic moves into Mirror's
   divergence handler. ~200 LOC deleted, ~100 LOC added to Mirror.
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
