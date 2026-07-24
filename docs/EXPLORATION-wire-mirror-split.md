# EXPLORATION — Wire/Mirror split: transport doesn't validate

*Design conversation captured 2026-07-23/24 (David + Sanderling), extending
the Mirror-and-Draft north-star from `EXPLORATION-sync-model.md` with a
sharper layering: **wire is pipe, Mirror interprets, session-object carries
state.** Not shipped; not committed to. A snapshot of the shape the
conversation converged on, plus the honest tradeoffs and open questions.*

**Sister docs:** `EXPLORATION-sync-model.md` (Mirror-and-Draft north-star,
tree-with-root topology), `wire-protocol.md` (current wire byte-level
reference — this doc proposes changing that shape).

---

## The insight in one sentence

The wire layer should be a **dumb pipe** that routes bytes by pubkey +
offset; validation (chain-hash, signatures, chain-linkage) is a **Mirror
concern**, not a transport concern; rejection is **session state**
(readable in the peer's session-object), not a wire event.

---

## The current shape (what this proposes to replace)

`registrySync` today knows about a lot:

- Frame format: text (JSON control) + binary (`[33-byte pubkey][batched
  chunks]`).
- Message types: `hello`, `subscribe`, `subscribed`, `interest`,
  `announce`, `reject`, `ping`.
- SIG-awareness: relay's `StreamoRecordSerializer` runs three-check
  validation (shape, chain, crypto) at every SIG boundary. Client's
  `makeRelayInboundStream` runs alignment check at every SIG boundary.
- Rejection as protocol event: server sends `{type:'reject', key, reason}`
  when validation fails; client reactively records via
  `session.setPushRejected(key, info)`.

The wire layer is *entangled with business logic* — it understands the
StreamoRecord data model. That entanglement is a smell:
`feedback_articulation_lives_at_the_signals_layer` says the validation
should live where the concept lives.

## The proposed shape

**Wire layer** — trivially small:

- Frame format: WebSocket binary frames carrying framed chunks.
- Routing: pubkey prefix (33 bytes, unchanged from today).
- Framing: `[4-byte LE length][chunk bytes]` inside each binary frame
  (unchanged from today).
- **No validation.** No SIG-awareness. No batch semantics.
- **No reject as protocol event.** Wire delivers bytes; wire never
  refuses.
- No JSON control-plane. Every message is a chunk destined for a
  Record (see next section).

**Session-object layer** — a Streamo (not a StreamoRecord — no
signing needed at this layer) per peer, carrying:

- **ACK cursor:** "I've received bytes for pubkey X up to offset Y."
- **Interest set:** topic keys the peer wants announces for.
- **Home pointer:** the peer's home Record's pubkey (bootstrap for
  content-driven discovery).
- **Rejection state:** per-Record validation failures with explanations
  (`{pubkey X, offset Y, result: 'chain-mismatch', myChainHash, yourClaimedParent}`).
- **Whatever other control state the layer needs.**

The session-object is *itself sent as chunks over the wire*, with a
distinct footer identifying it as a session-object (not a signed
commit). Structural symmetry with signed batches:

- Signed batch: `[data chunks][COMMIT chunk][SIG chunk]` — batch
  boundary = SIG.
- Session batch: `[data chunks][updated session-object chunk][SESSION_OBJECT footer]`
  — batch boundary = session-object update.

Both use footer-delimits-batch; different footers for different
purposes.

**Mirror layer** — where interpretation lives:

- As bytes arrive from wire, parse into chunks.
- At SIG boundary: validate (chain-hash, crypto). If valid → append to
  authoritative state. If invalid → mark in session-object (peer's
  Mirror reads and decides).
- At session-object boundary: update local session state; act on
  what changed (new ACK cursor → maybe drain outgoing; new rejection
  → surface to app).

## Session negotiation without extra round-trip

Current wire: `{type:'subscribe', key, fromOffset, fromChainHash}` →
`{type:'subscribed', key, atOffset}`. Two message types, request/response.

Proposed: opening session-object exchange carries the shape naturally.
Client's opening session-object includes `{recordsIWant: {pubkey X: {haveUpToOffset,
haveChainHash}, pubkey Y: {haveUpToOffset:0}}}`. Peer's response
session-object includes `{recordsForYou: {pubkey X: <bytes from Y
onward>, pubkey Y: <all bytes from 0>}}`. One round-trip. Same as
today, just shaped as session-object updates rather than typed
messages.

## Recovery via session-object

Rejection isn't a wire event — it's session state. Peer's Mirror sees
a bad commit, writes to session-object:

```js
session.rejections[pubkey] = {
  offset: 12345,
  result: 'chain-mismatch',
  myChainHash: <32 bytes>,
  yourClaimedParent: <32 bytes>
}
```

Author's Mirror reads that field, decides recovery. Options the Mirror
can request via its own session-object:

- **Replay from offset X-1** (last known good, cheapest).
- **Full replay from 0** (nuclear; equivalent to today's `_resyncRepo`).
- **Drop the Record locally** — don't re-subscribe. App-level "abandon
  this repo."
- **Present as UX** — Draft-style ("your commit didn't land; here's
  why").

Which recovery is Mirror's choice + app's decision. Wire doesn't
opine.

**Session scope of recovery:** per-Record, not per-session. A bad
commit for pubkey X doesn't scrap the session or affect pubkey Y.
Session is a multiplexer over per-Record state; each Record is
independently valid/invalid. The session outlives individual Record
failures.

## Garbage collection — two layers

Two separate GC concerns emerged in the conversation; keeping them
distinct is important.

### Layer (a) — frame pinning within session

**Problem:** an incoming wire frame is one Uint8Array. Extracted chunks
as `subarray()` views pin the whole frame in memory. Session with a
tiny commit for a long-lived Record + giant commits for short-lived
Records: the tiny subarray pins the giant frame long after the giant
Records are discarded.

**Fix:** `slice()` at parse-time, not `subarray()`. Each chunk becomes
a fresh Uint8Array with independent lifetime. Small memcopy cost per
chunk; huge GC-cleanness win. Invisible to callers — same Addressifier
API, cleaner memory behavior.

Applied at `Addressifier.makeWritableStream`'s parse loop. One-line
change per chunk-extraction site.

### Layer (b) — session-Streamo grows forever

**Problem:** the session-Streamo is itself an append-only Streamo.
Every message ever sent lives in it. Even with layer-(a) fix,
the session-Streamo's own byte array grows unbounded.

**Fix (proposed):** **toss the session when it exceeds a memory
threshold.** Cost: ephemeral messages lost (definitional — they're
ephemeral). Peer needs to re-establish state via a fresh session-object
opening exchange. Local Records preserved (they aren't session-scoped).

Threshold is configurable. Start high enough to be rare; adjust based
on real usage. *"Feel the tension when we get there."*

**Alternative:** ephemeral-per-connection (session Streamo dies when
WS closes; nothing persisted). Simpler; loses "reconnect and resume"
property. Session-toss preserves reconnect-resume up to the threshold.

## What this dissolves

- **JSON control plane.** All 7 message types (hello, subscribe,
  subscribed, interest, announce, reject, ping) become fields in the
  session-object.
- **`_awaitChainHash` as a special primitive.** Becomes "wait for
  Mirror to record 'commit landed' in its session-object."
- **`caughtUpToRelay` as a Record cell.** Becomes "Mirror's ACK cursor
  in the session-object equals the peer's advertised offset."
- **`isReadyToAuthor`.** Draft's status IS the signal (per
  Mirror-and-Draft north-star, this was already flagged for
  dissolution).
- **Reject-as-event.** Becomes reject-as-state (session-object field).
- **Relay-as-authority.** Becomes relay-as-hub (see tradeoffs below).
- **The wire-layer knowing about SIGs.** Chunks flow; Mirror
  interprets.

## What emerges — new concerns

- **Framing footer for session-object chunks.** Need a new codec type
  (`SESSION_OBJECT`?) that Mirror can distinguish from `COMMIT`/`SIG`.
- **Session-object schema.** What fields, what shapes, backwards-
  compatibility. Streamo's value type system (per `design.md §14.4`)
  handles Uint8Array + Date + nested objects natively, so this is
  data modeling, not encoding.
- **Session-toss trigger.** Memory threshold; probably a simple byte-
  count on the session-Streamo.
- **Reconnect handshake.** On session toss (either side), how do
  peers agree they're starting fresh? Probably: opening session-object
  carries a session-id; if the peer sees a new session-id from you,
  it knows the prior session is void.

## Vs. the current design — honest tradeoffs

Two things the current wire does that this loses. Both real, both
survivable, worth surfacing:

### 1. Relay-validates-before-broadcast optimization dies

Current: relay's `StreamoRecordSerializer` runs three-check validation
BEFORE broadcasting to subscribers. Bad pushes don't fanout to N
peers.

Proposed: relay is a hub. Broadcasts whatever it receives. Each
subscriber's Mirror catches badness independently. **N× the bandwidth
for the failure case.**

Doesn't matter for home relays (few subscribers). Might matter for
busy public relays (thousands). But bad pushes are rare in practice
— this is optimizing a rare case. If it becomes a real problem, a
relay could OPT to run Mirror-level validation on incoming pushes as
its own choice (not a wire-layer contract; a relay-implementation
choice).

### 2. Topology shift from "root-is-truth"

`EXPLORATION-sync-model.md` is built on tree-with-root: the root is
authority; everything flows through it. This design is peer-to-peer
with per-Record trust — no central authority.

Different mental model. Not a contradiction — you could still choose
to run tree-with-root at the app layer if you wanted (peers happen
to all route through one relay by convention). But the wire itself
doesn't privilege any node.

Cleaner in some ways (no privileged node, no "authority" concept at
the substrate). But it's a real reframe; `EXPLORATION-sync-model.md`
would need corresponding updates or a note that its "root is truth"
framing is one topology among possible, not a wire-level invariant.

## Migration path (rough — not committing to this)

Not doable in one arc. Rough decomposition:

1. **Slice-at-parse GC fix** — small (~20 LOC). Non-breaking. Ship
   whenever.
2. **Wire-push-primitive as safe addition** — `session.pushCommit(pubkey,
   chunks, sig)` wrapping existing outbound path. Non-breaking
   (existing wire still works; adds an API surface). ~50-100 LOC.
3. **Mirror-and-Draft items 4-5** (per north-star doc) — the client-side
   reorganization that puts author methods on Draft. ~500 LOC. Doesn't
   depend on the wire refactor.
4. **Session-object schema + Mirror-side validation** — introduce the
   session-object type + move validation from wire to Mirror. Deep
   change; wire layer's SIG-awareness dies. ~300-500 LOC.
5. **Session-toss + memory threshold** — implement (b)-layer GC.
   ~50-100 LOC.
6. **Test rewrites** — registrySync.test.js is large and heavily
   tests the current wire+validation shape. Substantial rewrite.
   ~500+ LOC.

**Total: 1500-2000 LOC across 3-4 sessions.** Steps 1-3 are
independent; step 4 depends on the shape being fully thought through
(GC + session-object schema settled); steps 5-6 follow.

## Open questions

- **Session-object schema exact fields.** What's ACK-cursor's shape
  (per-pubkey offsets? global-per-session? some mix)? What's
  rejection's shape? Does interest carry additional metadata?
- **Session-id conflict resolution.** Both sides toss simultaneously,
  both send new session-ids. Which wins? (Probably: last-write
  monotonic per session, or session-ids are timestamps.)
- **Reconnect while mid-session-object exchange.** Client sends
  opening session-object; WS drops; reconnects. Does opening
  session-object resend? How does peer avoid double-processing?
- **Peer-validate vs. relay-validate as a runtime choice.** Should
  the wire layer support "optionally validate before broadcast" for
  busy relays? Or is that always an application-level choice?
- **Where do announce/interest live in the session-object schema?**
  Multi-hop announce-fanout is more subtle than simple state.

## What this doc doesn't try to do

- Doesn't specify the session-object's exact wire encoding beyond
  "chunk with SESSION_OBJECT footer."
- Doesn't design the reconnect handshake in detail.
- Doesn't answer whether the relay validates at all (see tradeoff
  #1 — leaving as an application choice).
- Doesn't propose which shipping order is right — the migration path
  section is rough decomposition, not a plan.

## Where this sits

This doc extends `EXPLORATION-sync-model.md` (Mirror-and-Draft
north-star) with a sharper layering split. Both docs share the
substrate philosophy: reactive state, per-Record trust, articulation-
at-signals-layer. They differ on topology (tree-with-root vs. peer-
to-peer) and on where validation lives (wire vs. Mirror).

The sync-model doc's items 1-3 (Draft primitive + all callers
migrated + `update()` removed) shipped 2026-07-16/17. Item 6 (per-cell
wire-state migrations) shipping through 2026-07-23 (task 4 —
pushRejected — closed today). Items 4-5 (WritableStreamoRecord
dissolves + Draft holds author methods) still queued.

This wire-mirror split is *adjacent* to items 4-5, not a replacement.
Items 4-5 could ship first with the current wire assumption; the wire
refactor could follow. OR items 4-5 could be redesigned to compose
with the wire refactor if we know the target. That's a strategic
decision, not a technical one.

---

*Filed as EXPLORATION per convention. If the design proves right
under implementation pressure, this doc gets folded into
`design.md` §5/§10 as the new spec. If it proves wrong or gets
superseded, this doc stays as archaeology naming what we thought
at the time.*

— Sanderling (with David), 2026-07-24 late
