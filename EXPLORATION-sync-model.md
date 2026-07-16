# EXPLORATION — sync model as it ought to work

*Turnstone + David, 2026-07-15. Written to reason through what sync
should look like from scratch, then compare to what we've actually
built. Not a spec — a sketch to iterate on.*

## The setup

A **Streamo Record** is:

- A keypair (identity / pubkey)
- A chain of chunks + SIGs stored as a linear byte-stream
- Anyone with the private key can extend the chain by authoring a SIG
- Anyone can hold a copy of the bytes (a mirror)

**Agents.** In a typical setup:

- One or more **authors** (has the private key; extends the chain by signing)
- Zero or more **peers** (mirrors the bytes; doesn't author)
- Often: a **relay** (a peer other peers connect through for federation)

Author vs peer is a ROLE PER RECORD, not per process. A publisher
of my home Record is an author of it; a browser reading your Record
is a peer of it.

## Authority: upstream is truth (foundational)

Per David 2026-07-15: **the topology is a tree with a single root
authority.** I sign at a leaf and my SIG is *correctly signed* but not
yet *real*. I pass it upstream. My upstream passes further up.
Eventually something comes back down to me — at that point my Record
is a copy of the authoritative chain. Until then, my Record just holds
data that isn't yet interesting from the root's POV.

Rules that fall out:

- Root only accepts correctly-signed updates.
- Root broadcasts everything it accepts to everyone.
- Whatever root says, is true — for that Record.
- "Divergent" (state 4 below) reduces to a single case in this model:
  I made a local commit that root didn't accept (root accepted a
  competing one first). My commit is on a dead branch. Case 4a
  ("wire is bogus") barely happens in the tree — the root IS the
  authority for the branch it's rooting.

Complicated topologies (multi-root, mesh, offline peers) are open.
For the shapes we ship today (one relay per Record), the tree model
holds.

## The atomic sync unit: a chain-tip

Each agent has:

- **Own bytes** — the chunks and SIGs it holds
- **Own tip** — the chainHash of its most recent SIG (its authoritative "where I am")
- **Known peer tips** — per-connection, the tip each connected peer has told us about

Because signatures are chain-anchored (`SIG(N).previousChainHash ==
SIG(N-1).chainHash`), a tip uniquely identifies a chain. Two agents at
the same tip have equivalent state; two agents at different tips have
either an ancestor/descendant relationship or a genuine divergence.

## The 4 sync states

Between self and one wire-peer:

1. **Match.** `self.tip == wire.tip`. Nothing to sync.
2. **I'm behind wire.** `wire.tip` descends from `self.tip`. **Pull** —
   ask wire to send SIGs from self.tip forward, append them.
3. **I'm ahead of wire.** `self.tip` descends from `wire.tip`. **Push** —
   send wire the SIGs from wire.tip forward.
4. **Divergent.** Both descend from a common ancestor but neither from
   the other. Split by role:
   - **4a. I'm the authority.** Wire has a bogus chain (some peer
     published to it differently). Wire should discard its post-ancestor
     content and re-sync from me.
   - **4b. Wire is the authority.** I made local writes based on a stale
     view of wire; someone else pushed to wire in between. **My commits
     are on a bogus branch.** I rebase my SIG's data content onto wire's
     tip, re-sign, retry.

Case 4a/4b asymmetry: the substrate needs to know who's authoritative.
Usually: the keypair-signer wins; for federation, a trusted relay wins.

The **eviction case** doesn't add a new state. It weakens "match"
detection — I might not have older chunks wire has, but I still match
if my tip descends from wire's or vice-versa via the SIGs we both have.
It's an optimization on top of the same model.

## The sync protocol (simple, correct)

**On inbound SIG from wire:**

1. Verify signature (existing code).
2. Check if `SIG.previousChainHash` matches some SIG I already have.
3. If yes:
   - If it matches `self.tip` → I advance directly. State 2 → 1.
   - If it matches an earlier SIG (case 4b, I've been rebased) → my
     newer SIGs are on a dead branch; the substrate's authority wins.
     Discard my dead-branch SIGs, apply wire's new tip. Any local
     changes I had need to be re-applied against the new tip and re-signed.
4. If no → I'm missing intermediate SIGs. Buffer the incoming, ask wire
   to send from a common ancestor forward.

**On local author (making a new SIG):**

1. `SIG.previousChainHash = self.tip` at time of signing.
2. Push SIG (and its data chunks) to wire.
3. Wire either accepts (state 3 → 1) or rejects with "your parent isn't
   my tip" (state 4b — someone raced me).
4. On rejection: pull wire's newer SIGs (which puts me in state 4b),
   rebase my authored data, re-sign, retry.

**No `pendingChainHash` needed. No alignment-check-hack. The chain's own
linkage does all the work.**

## Why the current code has an alignment check

Current design stores bytes for BOTH local-authored AND wire-received
in the same byte-array on the same Record. The `pendingChainHash` in
`relayInboundStream` tries to reconstruct "wire's view of me" separately
from "my own view" — but both views are read from the same bytes, so
they collapse together and the check compares stale-vs-current
snapshots of the same underlying state.

The alignment check *coincidentally* catches some real conflicts because
the timing lines up when authoring races with inbound bytes. But it
ALSO fires false-positives (the race I hit today: pending captured at
zeros because the record was empty, committed advanced to real hash
after archive load, wire's first SIG triggers the mismatch even though
there's no actual conflict).

The `#relayChainHash` field on StreamoRecord is a similar smell —
per-wire state living on the record itself, which mixes concerns.

## What actually needs to change (draft — iterate)

Minimum-viable-fix (unblocks wake-mechanism, doesn't fix the model):

- **Fix A** from earlier: lazy-init `pendingChainHash` at first inbound
  SIG. Papers over the race. Doesn't clean up the model.

Cleanup, in rough order of scope:

1. **Remove `pendingChainHash` from `relayInboundStream`.** Replace
   with per-SIG chain-linkage check: does `SIG.previousChainHash`
   match a SIG in my current chain?
2. **Move `#relayChainHash` off StreamoRecord.** Per-connection state
   belongs in the sync layer (originSync / registrySync), not on the
   record.
3. **Rework the push path.** `WritableStreamoRecord.update`'s retry
   logic might still assume the alignment check exists — review.
4. **Formalize the eviction case.** If a tier evicts old chunks, we
   might lose the ancestor SIGs needed to link an inbound. Two options:
   preserve enough of the chain that we can always follow, OR discard
   our own tip on eviction-conflict and re-sync from wire as a fresh
   peer.

## Empirical finding (2026-07-16 late) — the isReadyToAuthor gap for originSync

The chain-divergence turned out to be **`isReadyToAuthor` failing to
gate for originSync-only records.** Root cause:

- `isReadyToAuthor` returns `true` immediately if `hasRelay` is false.
- `hasRelay` is only flipped true by `_attachSession()`.
- **`registrySync` calls `_attachSession()`; `originSync` did not.**
- Result: originSync-attached records reported `isReadyToAuthor = true`
  even though they hadn't caught up with anything. fileSync's startup
  gate skipped, disk-wins branch fired against empty local state,
  authored a SIG on a fresh chain, wire's actual SIGs then triggered
  the alignment-check with pending=zero (init) vs committed=(local
  sign) → false-positive conflict.

**Fix (this arc):**
1. `originSync.attachSync` calls `record._attachSession(null)` — sets
   `hasRelay=true`; null session is intentional (originSync has no
   session-level resync verb).
2. `caughtUpToRelay` falls through to `relayChainHash !== null` when
   `relaySubscribedAtOffset` is null. First SIG from wire → we're
   caught up. Not as precise as the registrySync watermark, but keeps
   `isReadyToAuthor` from returning true before wire tells us anything.

**What this unlocks:** the auto-shard path fires correctly end-to-end
for the local sub-Record. Home Record commits chain from the right
parent (wire's, not empty).

**Still open:** sub-Records don't have their own wire connection under
originSync (single-record protocol). They need `registrySync` with
`followMounts: true` to sync to a relay. That's the *"collapse
originSync into registrySync"* roadmap item.

## Empirical finding (earlier) — the chain-divergence with streamo.dev

When testing the wake-inbox sharding fix, the publisher's push to
streamo.dev fails with the alignment-check throw *even with a fresh
empty local archive*. Debug output showed: at the first SIG from wire,
`pendingChainHash` was still zeros while `committedChainHash` had
advanced to some non-zero hash (`76f4abde...` in one run). This means
SIGs were being APPENDED to the record before `relayInboundStream`
processed them via its SIGNATURE branch — some path is appending SIGs
directly.

Best hypothesis: streamo.dev's current state of David's home Record has
history that our fresh publisher can't cleanly extend from. Either
prior orphan publishers pushed inconsistent commits, or there's a
race in the initial-catch-up where multiple write paths interleave.

This is separate from the wake-inbox sharding work. Left as an open
investigation in ROADMAP.

## Attempted Fix A that broke a real test

Tried: lazy-init `pendingChainHash` to `null`, capture at first-SIG-time.
Reasoning: capture-at-stream-creation races with archive-load.

Broke: `registrySync.test.js` "subscriber: incoming bytes that diverge
from local archive surface conflictDetected." That test manufactures a
divergence: client has un-pushed local writes, server sends divergent
chain. The OLD code captures pending BEFORE local writes (proxy for
"shared-base state"), so when server's SIG arrives, pending (base) ≠
committed (past client's local write) → correctly detects divergence.
Lazy-init loses that anchor — captures AFTER local writes, so pending
equals committed and the check false-negatives.

So Fix A trades one false-positive for one false-negative. Not a good
trade. **Reverted.** The right fix probably involves either sequencing
guarantee (make sure stream creation happens AFTER archive-load AND
before any local writes) or a per-SIG cryptographic chain-linkage check
(more expensive, requires re-deriving chainHash from previous +
staged-content and comparing to the SIG's declared chainHash).

## Open questions

- **Two authors publishing simultaneously.** How does the substrate
  arbitrate? Currently seems to be first-write-wins-at-relay. Does
  that hold for a peer-to-peer federation with no single relay?
- **Peer authority.** Should peers reject SIGs beyond signature-verification?
  If yes, based on what? (Content policy? Chain-length rules?)
- **Relay migration.** SIGs first published to relay A, later I try to
  push to relay B. Chain state on A and B diverges. Which is authority?
- **Reader-follow of ours:true mounts** (from today's arc). If a reader
  can't follow without the mount key declared in mounts.json, and
  authors derive keys via `keysFor(signerName + '/' + mountPrefix)`,
  the config-shape must always declare the derived key. That's the
  reader-followability constraint we landed on.

## Where this exploration sits

This document is the sketch, not the spec. If it holds up under
iteration, we could either:

- Fold the model into `design.md` and rework the code toward it as a
  major-bump arc, OR
- Keep it as a north-star doc while we ship targeted fixes that
  gradually converge

David's framing: *"probably too much duct tape to push across as is"* —
which means the second path (targeted fixes with a north-star) is
probably the honest one, not a redesign in a single arc.

— Turnstone (post-compact), 2026-07-15 evening
