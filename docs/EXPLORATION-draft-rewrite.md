# EXPLORATION — Draft rewrite (Mirror-and-Draft items 4-5)

> **⚠️ SUPERSEDED 2026-07-24 late** by
> [`EXPLORATION-mirror.md`](./EXPLORATION-mirror.md).
>
> David's design conversation later on 2026-07-24 dissolved the Draft-
> as-separate-class shape this doc plans. The new shape puts a `local`
> StreamoRecord + `remoteLength` cursor inside a Mirror container;
> authoring is `mirror.local.set(...)`; no Draft class needed. Migration
> becomes substantially smaller (~500 LOC instead of ~1500).
>
> This doc preserved as archaeology of the design journey — the
> Draft-as-separate-class shape was Sanderling's initial sketch;
> David's pushback surfaced the container shape that dissolves the
> need for a Draft class. See the newer doc's "Meta on how this shape
> emerged" section for the specific pushbacks that surfaced the shift.

*Sanderling 2026-07-24, after realizing during hands-on scoping that
"Draft rewrite" is bigger than Turnstone's item-4 sealed answer
suggested — because David's 2026-07-23 morning frame rejects that
compromise. This doc plans the rewrite done per the north-star.*

**Sisters:** `EXPLORATION-sync-model.md` (Mirror-and-Draft north-star),
`EXPLORATION-wire-mirror-split.md` (wire = pipe layering; where this
doc's design converges architecturally), `Draft.js` + `WritableStreamoRecord.js`
(current shapes).

---

## The target shape (north-star)

**Mirror** = read-only observer of wire-authoritative bytes.
- Extends Streamo/StreamoRecord (chain reads).
- Byte-store advances ONLY from wire (or archive replay).
- No `set`, no `commit`, no `sign`, no `attachSigner`, no
  `makeWritableStream`-for-local-authoring.
- Still has: `makeRelayInboundStream` (receives wire bytes),
  `newDraft(signer)` (factory).

**Draft** = ephemeral author-work object, one per commit-attempt.
- Holds a **working Streamo** (scratch byte-store for encoding).
- Holds a **signer + signerName**.
- Holds `pendingValue`, `parentChainHash` (snapshotted from Mirror at
  construction).
- `.set(v)` mutates pendingValue.
- `.commit({message, date})`:
  1. Encode pendingValue into working Streamo (`checkout` + `set` on
     scratch).
  2. Encode commit record `{message, date, dataAddress, parent}` into
     working Streamo.
  3. Compute chainHash: `sha256(parentChainHash || sha256(newBytes))`.
  4. Sign chainHash with signer → SIG chunk.
  5. Extract all new chunks from working Streamo (from the point after
     parent).
  6. Call `session.pushCommit(pubkey, [...chunks, sig])`.
  7. Await Mirror advancing to the sig's chainHash (via
     `session.getRelayChainHash(pubkey)` reactive watch).
- Status transitions: draft → pending → landed / superseded / cancelled
  / failed. Same as today's Draft facade.

**WritableStreamoRecord** = dies. All its methods either move to Draft
(author-side) or dissolve (no longer needed).

---

## Method-by-method migration table

| Current location | Method | New location | Notes |
|---|---|---|---|
| WritableStreamoRecord.js | `attachSigner(signer, name)` | Draft (as constructor arg) | Signer is Draft-scoped; no more Record-attached signer. |
| WritableStreamoRecord.js | `hasSigner` | Draft (derived from `#signer !== null`) | Trivially true within Draft. |
| WritableStreamoRecord.js | `defaultMessage` field | Draft constructor option | `mirror.newDraft(signer, {defaultMessage: 'web'})`. |
| WritableStreamoRecord.js | `#signing`/`#signPending` batching | Dissolves | Each Draft = one commit = one batch on the wire (enforced by Draft's ephemeral model; see "One commit per batch" below). |
| WritableStreamoRecord.js | `set(...args)` | Draft.set(v) | Simpler API: Draft.set takes the whole value or a path+value. |
| WritableStreamoRecord.js | `setRefs(...args)` | Draft.setRefs(v) | Symmetric. |
| WritableStreamoRecord.js | `checkout()` | Draft internal (private) | Draft uses working Streamo; checkout is impl detail. |
| WritableStreamoRecord.js | `commit(working, message, opts)` | Draft.commit({message, date, remoteParent}) | Merges into the Draft's commit lifecycle. |
| WritableStreamoRecord.js | `merge(source, opts)` | `Draft.fromRemote(url, opts)` static | Constructs a Draft prepopulated with the merge value. |
| WritableStreamoRecord.js | `sign(signer, name)` | Draft internal (private) | Called during Draft.commit; not a public method. |
| WritableStreamoRecord.js | `_awaitChainHash(target)` | Draft internal (private) | Called during Draft.commit; watches `session.getRelayChainHash(pubkey)`. |
| WritableStreamoRecord.js | `locallyAuthoredOffset` field + `_markAuthoredAtOffset` | Dissolves | Concept doesn't apply — Mirror only holds wire bytes; "which bytes I authored" is Draft-scoped and ephemeral. |
| WritableStreamoRecord.js | `_reset()` | Dissolves | Draft is ephemeral; no reset needed. Mirror never has local writes to reset. |
| WritableStreamoRecord.js | `fetchSnapshot(url)` static | Utility export (unchanged) | Used by `merge`; can move to Draft.js as `Draft._fetchSnapshot`. |
| WritableStreamoRecord.js | class itself | Deleted | ~468 LOC removed. |

**Stays on StreamoRecord (Mirror):**
- All chain-reads (`lastCommit`, `committedChainHash`, `signedLength`,
  `valueAddress`, `get`, `getRefs`, `files`, `history`, `parent`,
  `ancestor`, `verify`).
- `makeRelayInboundStream` (wire-inbound writer — Mirror receives here).
- `newDraft(signer, signerName)` (Draft factory).

**Dies on StreamoRecord:**
- `_reset()` (per above — nothing to reset).
- `hasSigner` on Record (only Draft has signer now).
- All the wire-state getters that ALREADY moved to session (per items 6):
  relayChainHash, relaySubscribedAtOffset, conflictDetected,
  pushRejected. Already done through task 4. `hasRelay`, `caughtUpToRelay`,
  `isReadyToAuthor` still there per prior analysis — dissolve alongside
  this arc.

---

## What Draft's internal shape looks like

```js
class Draft {
  // Ephemeral state
  #status = 'draft'          // draft | pending | landed | superseded | cancelled | failed
  #error = null
  #recaller                  // shared with mirror for reactive status
  #targetChainHash = null    // set at commit(), watched for landed

  // Author state
  #signer                    // required at construction (or throw at commit)
  #signerName
  #pendingValue

  // Snapshotted from mirror at construction
  #mirror                    // for reading current value + parentChainHash + session ref
  #parentChainHash           // mirror.committedChainHash at construction
  #parentValueAddress        // mirror.valueAddress at construction

  // The scratch byte-store for encoding
  #working                   // new Streamo({name: 'draft-scratch'})

  // Options
  #defaultMessage

  // Public API
  get status(), get pendingValue, get parentChainHash, get error
  set(valueOrUpdater), setRefs(pathOrRefs)
  cancel()
  async commit({message, date, remoteParent})

  // Static
  static async fromRemote(url, opts)
}
```

**The commit lifecycle (concrete steps):**

```js
async commit(options = {}) {
  // Guard
  if (this.#status !== 'draft') throw ...

  // Precheck: mirror still at expected parent?
  if (!arraysEqual(this.#mirror.committedChainHash, this.#parentChainHash)) {
    this.#setStatus('superseded')
    throw ...
  }

  this.#setStatus('pending')

  // 1. Encode pendingValue into working
  const workingValueAddr = this.#working.encode(this.#pendingValue).materialize(this.#working).address

  // 2. Encode commit record
  const commitRecord = {
    message: options.message ?? this.#defaultMessage,
    date: options.date ?? new Date(),
    dataAddress: workingValueAddr,
    parent: this.#parentValueAddress ?? undefined,
    remoteParent: options.remoteParent
  }
  const commitAddr = this.#working.encode(commitRecord).materialize(this.#working).address

  // 3. Extract new bytes from working (all bytes in working since it's fresh)
  const newBytes = this.#working.slice(0, this.#working.byteLength)

  // 4. Compute chainHash from parent + new bytes
  const chainHash = await chainHashOf(this.#parentChainHash, newBytes)

  // 5. Sign
  const compactRawBytes = await this.#signer.sign(this.#signerName, chainHash)
  const sig = new Signature(chainHash, compactRawBytes)

  // 6. Encode sig chunk
  this.#working.encode(sig).materialize(this.#working)

  // 7. Extract chunks to send
  const chunks = this.#working.chunks()  // NEED: public accessor for chunks

  // 8. Push via wire-push-primitive
  const session = this.#mirror._session
  if (!session) {
    // Sessionless: locally-authored, no wire — mark landed
    this.#targetChainHash = chainHash
    this.#setStatus('landed')
    return { chainHash }
  }
  const sent = session.pushCommit(this.#mirror.publicKeyHex, chunks)
  if (!sent) {
    this.#error = new Error('WS not open')
    this.#setStatus('failed')
    throw ...
  }

  // 9. Await mirror advance (via session.getRelayChainHash)
  await this.#recaller.when(
    () => arraysEqual(
      session.getRelayChainHash(this.#mirror.publicKeyHex) ?? new Uint8Array(32),
      chainHash
    ),
    { name: 'draft:await-relay-advance' }
  )

  this.#targetChainHash = chainHash
  this.#setStatus('landed')
  return { chainHash }
}
```

**The subtlety worth naming:** step 7 needs `this.#working.chunks()` — a public accessor for the internal chunk array. Addressifier's `#chunks` is currently private. Two options:
- (a) Add a public `chunks()` method to Addressifier (or Streamo). Small addition. Non-breaking.
- (b) Iterate via `makeReadableStream({fromOffset: 0})` and collect framed bytes. Works but wraps + unwraps framing.

Option (a) is cleaner; add it as a small precursor commit.

---

## One commit per batch (design decision 2026-07-24)

The current wire allows multiple commits per batch — `WritableStreamoRecord`'s
`#signing`/`#signPending` machinery batches concurrent commits when a
second commit is issued while the first's SIG is still being computed;
both end up covered by one SIG. `ConnectionAccumulator` accepts however
many chunks arrive before a SIG as one atomic batch.

**The Draft rewrite enforces one-commit-per-batch.** Rationale (David +
Sanderling 2026-07-24):

- Draft's ephemeral model already implies it — one Draft = one commit-
  attempt. Draft.commit produces exactly one batch. Symmetric.
- Rejection semantics simpler: "this batch's commit was rejected" vs.
  "one of N commits in this batch was rejected, and by chain-linkage
  the rest are also invalid."
- Wire parsing simpler for the receiver: one SIG boundary = one commit
  by contract, not by convention.
- Signing cost isn't load-bearing at streamo's scale (ECDSA ~ms;
  human-scale authoring). Optimization not needed.
- Relying on signing-timing to enforce one-commit-per-batch is fragile
  under load — two rapid `.set()` calls could theoretically both land
  before the first SIG completes. Enforce structurally, don't rely on
  timing.

**Enforcement:** `Draft.commit()` produces one batch containing
`[data codec-chunks][COMMIT codec-chunk][SIGNATURE codec-chunk]`. If
author wants N commits, they construct N Drafts, each producing its
own batch. Serial by construction (via the mirror's chainHash pointer
advancing after each landed commit).

**What dies with this:** `WritableStreamoRecord`'s `#signing`/
`#signPending` machinery. Nothing else — external callers don't
observe the batching today (it's transparent), so removing it doesn't
break their contracts.

## Sessionless path (fileSync archive-only)

Currently `_awaitChainHash` bypasses when `!this._session` — resolves cleanly. Draft.commit's step 8 needs the same: if `mirror._session === null`, we're in archive-only mode; mark landed without pushing.

**But the archive still needs the bytes!** Currently:
- WritableStreamoRecord.commit writes bytes into Mirror's byte-store.
- archiveSync watches Mirror's chunk additions and persists.

In the north-star Draft world:
- Draft's bytes never touch Mirror.
- For archive-only mode, WHERE do bytes land?

**Option A** — archiveSync watches Draft directly. Complex; Drafts are ephemeral.

**Option B** — Draft in sessionless mode DOES write bytes into Mirror's byte-store. Special case; violates the "Mirror only receives from wire" invariant.

**Option C** — introduce a "loopback session" — a virtual session where `pushCommit` immediately calls `mirror.makeRelayInboundStream` with the pushed bytes. Sessionless Draft still pushes, but the push loops back locally.

**Recommend: Option C.** Preserves the invariant (Mirror only receives from a "session-shape" — loopback is one kind). Composable. Symmetric with how originSync attaches a null session (per Wagtail's current-session note).

This is one of the loose ends this arc will need to close.

---

## Migration path (rough — real work)

Broken into commits that each ship a coherent partial state:

1. **Precursor: add `Streamo.chunks()` accessor.** ~10 LOC. Non-breaking.
2. **Precursor: add `chainHashOf` as a module export.** Currently a
   local function in WritableStreamoRecord.js. ~5 LOC to move.
3. **New Draft class implementation** (draft.js rewrite). ~300 LOC. Old
   Draft facade still exists as `LegacyDraft` for callers to migrate
   off.
4. **Update `Mirror.newDraft(signer)`** to return new Draft instead of
   LegacyDraft. Test-drive by migrating one caller at a time. ~50 LOC
   per caller.
5. **Introduce loopback-session for sessionless mode.** ~50 LOC.
6. **Migrate all callers off WritableStreamoRecord's set/commit/sign
   API** to use `Mirror.newDraft().commit()` pattern. Big touch —
   fileSync, chat, publish scripts, tests. ~200 LOC.
7. **Delete WritableStreamoRecord class.** ~468 LOC removed. Update
   ~15 import sites.
8. **Update `caughtUpToRelay`/`isReadyToAuthor`/`hasRelay`** to
   dissolve per Mirror-and-Draft north-star — Draft's `.status` is
   the authoring-readiness signal. Remove the fileSync gate that
   uses `isReadyToAuthor`. ~50 LOC. May require Draft to expose an
   "await landed" convenience (already does — commit() awaits).

**Total: 1000-1500 LOC touched, spread across 6-8 commits, ideally
2-3 focused sessions.** Steps 1-2 could ship together as a small
precursor (safe, non-breaking). Steps 3-4 together — introduce new,
migrate first caller as smoke-test. Steps 5-7 together — bulk migration
and delete. Step 8 as a natural close.

---

## Test strategy

`WritableStreamoRecord.test.js` doesn't exist as a distinct file; the
tests are folded into `StreamoRecord.test.js` and `registrySync.test.js`.
Some of those tests exercise:
- Author flow (set → auto-sign → outbound drain)
- `_awaitChainHash` behavior
- `pushRejected` / `conflictDetected` handling during author retry

For steps 3-4 (new Draft alongside old): tests can migrate incrementally.
Old tests keep passing during the transition; new tests exercise the
new Draft.

For step 7 (delete WritableStreamoRecord): tests that specifically
tested WritableStreamoRecord as a distinct class type will fail. Use
`.skip` with `// unskip when WritableStreamoRecord fully migrated` per
the standing agreement with David.

**Skipped tests to un-skip target:** should be zero when this arc is
done. Any test that stays skipped past that point represents a real
regression in coverage; the doc should flag which tests those are so
they're not lost.

---

## Where this converges with EXPLORATION-wire-mirror-split.md

The Draft rewrite (this doc) and the wire-mirror-split (sister doc)
converge at Draft.commit's step 6-9:
- Draft.commit calls `session.pushCommit(pubkey, chunks)` — the wire-
  push-primitive from wire-mirror-split step 2 (already shipped
  `e0b536b`).
- Draft.commit awaits via `session.getRelayChainHash(pubkey)` — the
  session-state primitive.

Under CURRENT wire (with SIG-awareness and reject-as-event), Draft's
push goes through the same three-check validation the peer runs today.
No changes to wire semantics; Draft just uses the primitive that
exists.

Under FUTURE wire (mirror-side validation from wire-mirror-split step
4+), Draft's push goes through, wire doesn't validate; Mirror-side
validation kicks in. Same Draft code; different wire semantics.

**Which means:** Draft rewrite can ship WITHOUT the wire-mirror-split
being done. It composes with either the current wire or the future
wire.

That's the sequencing insight: Draft rewrite (this doc) and wire-mirror-
split (sister doc) can ship independently. Do Draft first; do wire-mirror-
split when we're ready. They meet at pushCommit + session state, both
of which already exist.

---

## Open questions

- **`Streamo.chunks()` shape:** return `Uint8Array[]` of raw chunks?
  Or return an iterator? Or something with offset info too?
- **`chainHashOf` as module export:** where does it live — `Signer.js`?
  `Signature.js`? new `chain.js`?
- **`Draft.fromRemote(url)` API:** exact signature. Currently
  `WritableStreamoRecord.merge(source, opts)` — how much of that
  interface transfers?
- **Sessionless loopback exact shape:** what does the "loopback
  session" object look like? Does it expose the full session API
  (getRelayChainHash, etc.)? Or a minimal subset?
- **`registrySync`'s reader-drain path with the new Draft:** currently
  the drain sends bytes as Records accumulate them. In the Draft
  world, `pushCommit` is the outbound path; the reader-drain becomes
  used only for RESUME (server subscribes to client's own bytes when
  reconnecting). Verify.

---

## What this doc doesn't try to do

- Specify exact new-Draft.js line-by-line — the migration table + commit
  lifecycle sketch are the contract; details live in the implementation.
- Design the "loopback session" object — flagged as an open question.
- Address items 4-5 for repositories authored via originSync (not
  registrySync) — that flows from the "collapse originSync into
  registrySync" roadmap item; separate arc.
- Redesign `checkout()` — the concept transfers into Draft as an
  internal detail, not a public API.

---

*Filed as EXPLORATION. If step 3 (Draft rewrite) executes cleanly under
this plan, this doc gets folded into `EXPLORATION-sync-model.md`'s items
4-5 section as the concrete spec. If the plan proves wrong under
implementation pressure, this stays as archaeology.*

— Sanderling, 2026-07-24 late
