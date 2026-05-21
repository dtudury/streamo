# streamo changelog

Release-by-release history, newest first. See [ROADMAP.md](./ROADMAP.md)
for what's next.

---

## 8.2.0 — the subscribe handshake carries the client's chain anchor

**The headline.** Reconnecting clients no longer pay for a full
genesis-replay. The `subscribe` JSON now carries
`(fromOffset, fromChainHash)` — the client's `signedLength` and
`committedChainHash`. The server validates the anchor against its
own chain and streams only post-anchor bytes. Three effects:

- *Bandwidth.* A client with archive state that reconnects after
  a long disconnect picks up at its `signedLength` instead of
  byte zero. Browser tabs aren't affected (no archive → empty
  state → same as before); the win is for Node clients with
  `archiveSync` or peer-to-peer setups.
- *Receiver simplification.* `makeRelayInboundStream`'s
  `pendingChainHash` anchors to the local `committedChainHash` at
  writer creation, so each sig from the wire just extends from
  where we already were rather than from genesis. Same correctness;
  cleaner mental model.
- *Wipe self-healing.* If the server has no chain at the claimed
  offset (post-`--reset` deploy, or a peer-to-peer relay that
  never had this key), it accepts without validation. The
  client's bytes flow up through the serializer's chain check,
  which still catches real divergence at SIG arrival. The data
  gets restored automatically — what used to require manual
  `--reset` coordination now self-heals on the next reconnect.

**Backward-compatible.** Old clients without the new fields default
to `(fromOffset: 0, fromChainHash: 32 zeros)` — identical behavior
to 8.1.x. Wire-compat preserved across the version boundary.

**Validation rules** at the server's subscribe handler:

- `fromOffset === 0` → require `fromChainHash` to be 32 zeros (else
  the claim is malformed; reject with `chain-mismatch`).
- `fromOffset > 0` and our `byteLength ≥ fromOffset` → read the
  chainHash at the SIG ending at `fromOffset`; if it matches the
  claim, stream from `fromOffset`; otherwise reject with
  `chain-mismatch`.
- `fromOffset > 0` and our `byteLength < fromOffset` → accept;
  stream from our end (`byteLength`). We can't validate, but the
  serializer's chain check on incoming pushes catches real
  divergence. The wipe-recovery case silently flows the client's
  bytes back up.

**What didn't change.** The receiver's `alreadyHave` defensive check
stays. The relay still broadcasts every accepted chunk to all
subscribers including the original submitter; the echo dedupes via
`alreadyHave`. A future cleanup could skip echoes at the sender
(then remove the check entirely), but it's not blocking and lives
in the "low-glamour cleanups" lane.

**Tests.** 216 → 219:

- `makeReadableStream({ fromOffset })` emits only post-offset chunks.
- The wire's wipe-recovery scenario: server has nothing for a key,
  client carries pre-wipe state, the upward push restores the chain.
- The reconnect-anchored optimization: server validates the anchor,
  streams only the post-anchor tail; the client picks up the
  server's extension transparently.

Plus one existing test (`alignment check catches the push-in-flight
race`) updated to construct truly-shared base bytes — the old test
was implicitly relying on the genesis-start behavior that the
anchor-to-committedChainHash change correctly removed.

**Driver story.** 8.0's relay-as-authority refactor left the wire
still replaying from byte zero — the genesis-fold made the
receiver's pending state implicit and tangled with the sender's
stream position. 8.2 makes the anchor explicit: the client says
where it is; the server validates and serves from there. The
alignment check stays as a defense against the push-in-flight race
(local writes during stream processing), but the math is now
straightforward chain-hash equality on values both sides agree
to anchor at.

---

## 8.1.0 — `session.subscribe` returns the Repo

**The headline.** The everyday "I want this key live" intent now
fits in one call. `session.subscribe(key)` was previously fire-and-
forget (`void`); it now resolves to the opened Repo, doing both the
local `registry.open(key)` AND the wire plumbing in one verb:

```js
const myRepo = await session.subscribe(myKey)
myRepo.attachSigner(signer, 'name')
```

Idempotent: calling again with the same key returns the same Repo
instance, no double-subscription side effects.

**Why this exists.** While driving 8.0.0 in two browser tabs we hit
a real gap: the chat client opened the user's own Repo via
`registry.open(myKey)` and announced themselves to the room, but
never explicitly subscribed to their own key. The server's announce
fan-out skips the sender (`if (sub !== ws)`), so a lone tab's
history never flowed back from the relay — it only arrived when a
second tab logged in, because that tab's announce tripped the first
tab's `onAnnounce` → `subscribe` path. *"Online" wasn't the same as
"synced."* The chat tab's WebSocket was open, but the user's own
Repo wasn't actually plumbed to the wire.

The fix could have stayed at the chat-app layer (and briefly did —
one line, "also subscribe to your own key after announce") but it
surfaced a broader truth: opening a Repo and asking the wire to
sync it are nearly always the same intent. Splitting them across
two verbs creates a foot-gun anyone writing a streamo app can step
on.

**API change.** `session.subscribe` used to return `void`. It now:

1. Opens the Repo in the registry if not yet open
2. Sets up bidirectional wire sync (sends the subscribe control
   message, attaches the reader and the inbound writer)
3. Returns the Repo

Strictly additive — callers ignoring the return value still work
unchanged. The underlying primitives are untouched:
`registry.open(key)` for storage-only contexts (archive-only,
tests, offline tools); the internal `syncKey` for wire setup.

**Migration.** Nothing required. The new everyday pattern collapses
two calls into one:

```js
// Before:
const myRepo = await registry.open(myKey)
// ... later, easy to miss ...
session.subscribe(myKey)

// After:
const myRepo = await session.subscribe(myKey)
```

The chat app itself now reads this way. README + JSDoc updated.

**Tests.** 215 → 216: one new test in `registrySync.test.js`
confirming the return value + idempotency. Existing tests still
cover all the side-effect paths (subscribe messages, wire setup,
follow-callback cascade, two-peer mutual subscribe).

---

## 8.0.0 — the relay is the chain authority

**The headline.** Conflict detection moved from "every client gates
its own inbound stream" to "the relay is the single chain authority
per repo." Two short invariants drove the refactor:

> *what comes down: is always from the top, and is always correct.*
> *what goes up: goes up until it reaches the top.*

Clients receiving the relay's authoritative stream trust + append.
Clients pushing upward go through a per-repo serializer at the relay
that atomically accepts (extends the top) or rejects
(`chain-mismatch` / `verification-failed` / `malformed`). The
detection that used to happen by accident at every client's verifier
now happens deliberately at one point per repo — and the rejection
becomes a real signal the app can recover from.

Alongside the relay refactor, 8.0 lands a layering pass that's been
overdue: **Streamo is a codec, Repo is Streamo + signed chains**.
Everything signature-aware moved off Streamo. The chain-hash formula
got simplified from 2N hashes per signature (a per-chunk fold) to 2
hashes per signature (a single hash of all new bytes). The vocabulary
got cleaned up — `fork` was being used for what's actually a runtime
*conflict*; `accumulator` was a jargon name for a chain hash.

This is a major version because every one of those threads is
breaking. The migration is mechanical, but it's not zero work.

### Layering — Streamo became a pure content-addressable codec

`Streamo` now does exactly one thing: encode/decode JS values as
deduplicated, content-addressable byte chunks. `set(value)` returns
an address; `get(address)` returns the value; same value, same
address, forever. No signing, no verification, no chain bookkeeping,
no SIG-awareness in `valueAddress`. ~319 lines.

`Repo` extends Streamo with all the chain machinery:
`signedLength`, `committedChainHash`, `sign()`, `verify()`,
`makeRelayInboundStream`, `conflictDetected`, `pushRejected`, the
SIG-walking `valueAddress` override, the SIG-aware `append`
behavior, and the chain-hash helpers. ~711 lines.

The line between the two became readable rather than aspirational —
"is this identity-aware?" splits them cleanly. Anyone wanting just
the codec (e.g. for inspecting unsigned bytestreams) can use
`Streamo` directly without inheriting the signing surface.

### Chain hash — two sha256 calls per signature, not 2N

The old per-chunk fold (`fold(prev, chunk)` chained over every chunk
since the last sig) ran 2 hashes per chunk. Each sig committed to
both the bytes and the chunk boundaries — but in streamo, chunk
boundaries are determined by codec footers; you can't merge or split
chunks without changing their content. The "extra" commitment to
boundaries wasn't load-bearing.

The new formula is:

```js
async function chainHashOf (prev, newBytes) {
  return sha256(concat(prev, sha256(newBytes)))   // 2 hashes total
}
```

`Repo.sign()` slices the new-bytes range once and runs two sha256
calls regardless of chunk count. `RepoSerializer._tryApply` does the
same on the relay side. The verifier inside `makeRelayInboundStream`
no longer needs an inner-loop `await foldChunk` — it stages chunks
and hashes once at SIG arrival.

**Wire format change — breaking.** Any `.bin` archive file written
by an older version has SIG chunks whose chainHash was computed
under the old formula. They won't verify after upgrade. Wipe and
re-sync — see migration below.

### Relay-as-authority — `RepoSerializer` + `ConnectionAccumulator`

At every relay (in-process via `attachStreamSync({ isAuthority:
true })`), each repo gets a singleton `RepoSerializer` shared across
all WS connections to that repo:

```
RELAY:
  RepoSerializer (per repo, shared across connections)
    submit(batch) → atomic chain extension or reject
  ConnectionAccumulator (per WS, per repo)
    parses framing → builds batches → submits

CLIENT (receive from relay):
  makeRelayInboundStream — trust + append + alignment check
    no chain check (relay validated)
    no crypto check (relay validated)
    alignment catches push-in-flight race → conflictDetected

CLIENT (push):
  unchanged — repo.makeReadableStream → WS
  on relay reject: {type:'reject', key, reason} → repo.pushRejected
```

The serializer is the "top." Pending = simple: a `submit()` awaits
the previous submit's promise before running. JS's event loop
serializes; no separate queue object, no early-rejection state. If
two clients submit racing batches, both get processed in arrival
order; the second one (chained off the now-stale top) is rejected
with `chain-mismatch`. Slow on contention, simple to reason about.

Three new reasons the relay can reject: `chain-mismatch` (sig's
chainHash doesn't extend the top), `verification-failed` (sig's
crypto didn't verify), `malformed` (sig wasn't a SIGNATURE codec or
batch didn't parse). All three flow back to the client as a
`{type: 'reject', key, reason}` JSON control message, landing on
`repo.pushRejected = { reason }` reactively.

The receiver alignment check (chain-hash equality between
`pendingChainHash` and `committedChainHash`) catches the
push-in-flight race: a client commits locally + pushes; the relay
sends down other bytes before knowing about the push; the incoming
bytes would land at addresses our local store already occupies. The
check rejects the incoming batch before any corrupted append
happens, raising `repo.conflictDetected`.

This closes the gap noted as future work in 7.x's ROADMAP — relay-side conflict detection is real now, not just per-client.

### Vocabulary — fork/branch/conflict/merge per streamo's actual model

Streamo isn't git. Words drifted toward git semantics; this release
walks them back:

- **fork** = a new Repo with a lineage note (deliberate, recorded;
  `Repo.merge(source, { remoteParent })` is the operation)
- **branch** = an addressed-but-non-head value within a Repo (a tool
  for clients to save earlier states; not a separate history line)
- **conflict** = the runtime "these bytes can't be appended" failure
  (what 7.x had called "forkDetected")
- **merge** = a commit referencing prior values from anywhere (cites
  `remoteParent`; the merging Repo doesn't depend on the source after)

API renames following the model:
- `repo.forkDetected` → `repo.conflictDetected`
- `Signature.accumulator` → `Signature.chainHash`
- error message text follows: *"signature chainHash does not match
  the local chain"*

### Removed: things that weren't used

- `Streamo.makeVerifiedWritableStream()` — superseded by
  `Repo.makeRelayInboundStream()` for the receive-from-relay path,
  and by the relay's `RepoSerializer` for the validate-incoming-push
  path. The old method conflated both concerns.
- `Streamo.verificationFailed` reactive flag — the relay verifies
  crypto now; the client doesn't surface verification failures
  because it doesn't perform the verification.
- `ConflictError` + `conditionalSet` — the optimistic-concurrency
  API surface that never found a real caller. Removed; we'll re-add
  with a real use case behind it.
- `GENESIS_ACCUMULATOR` constant — `new Uint8Array(32)` inline at
  the three seed sites is just as clear and saves a named import.
- Reactive flag `forkDetected` and its setter — renamed (see above).

### Migration

For consumers of `@dtudury/streamo`:

- **Update reactive watchers**:
  `repo.forkDetected` → `repo.conflictDetected`.
  Code listening for `repo.verificationFailed` should listen for
  `repo.pushRejected` instead (the new "the relay said no" signal).
- **Read sig fields by the new name**: `sig.chainHash` (was
  `sig.accumulator`).
- **If you held a Streamo and called sign/verify**: move to Repo.
  `streamo.sign(signer, name)` → `repo.sign(signer, name)`.
  Streamo no longer exposes signing.
- **If you used `makeVerifiedWritableStream`**: for receive-from-relay,
  use `repo.makeRelayInboundStream()`. For raw archive load (no
  verification, no signing), `streamo.makeWritableStream()` is fine
  (it's the same byte-append path with no SIG awareness).
- **If you caught `ConflictError`**: remove the catch. The error is
  gone along with `conditionalSet`.
- **If your relay handles inbound pushes**: pass `isAuthority: true`
  and a `serializers: Map<keyHex, RepoSerializer>` to
  `attachStreamSync` / `handleRegistryPeer`. The reject message
  channel is wired automatically.

For operators of a streamo relay (or anyone with cached `.bin`
archives):

- **`.bin` files written before 8.0 will not verify after upgrade**
  because the chainHash formula changed. The migration is "wipe
  and re-sync": stop the relay, `rm .streamo/<keyHex>.bin`, start
  the relay back up, let clients re-push. We're not providing a
  format-conversion tool — the simpler path beats the cleverer one
  at the scale streamo aims at.

### Tests

209 → 215. New tests:

- `RepoSerializer.test.js` (5) — clean accept, chain-mismatch
  reject, sequential queue under contention, pipelined commits from
  one client, forged sig rejected
- `registrySync.test.js` (2 integration) — relay refuses a divergent
  push from a second client; relay accepts a clean push and replays
  to other subscribers
- `Repo.test.js` (1) — `makeRelayInboundStream` chain-hash-equality
  alignment check rejects the push-in-flight race before any
  corrupted append
- Plus tests renamed for vocabulary + tests updated to use Repo
  where they previously used Streamo for verifier flows.

`Streamo.test.js` lost the obsolete `makeVerifiedWritableStream` /
`forkDetected` / `verificationFailed` tests (5 obsolete) — net
delta is +6 tests covering more meaningful surface.

### Acknowledgments

This release lands a thread that's been open through multiple
sessions — vocabulary drift was first noticed weeks ago, the
relay-authority gap was filed as future work in 7.0's ROADMAP,
and the chain-hash simplification was the original intent of the
6.0 hash-chain work that got obscured by a per-chunk fold. The
8.0 commit sequence is one focused day's worth of "all these
threads converge here."

---

## 7.6.1 — mount hardening: louder failure for unkeyed siblings; no-recaller mode works again

Two protective changes on top of 7.6.0's fine-grained watcher boundaries:

- **Multiple unkeyed function-components at the same parent now throw
  a clear error** instead of silently churning instances on every
  render. The position-based fallback key (`__pos:N`) was only ever
  safe for singletons; when more than one unkeyed function-component
  shares a parent and upstream shape changes (a conditional emits
  `null`, a list shrinks, etc.), positions drift and instance lookup
  breaks. The error names both components and tells you to add
  `data-key="…"`. Singletons (`mount(h\`<${App}/>\`, …)`) keep
  working unchanged.

- **Static rendering (no recaller) works again for function-
  components.** 7.6.0 made the instance machinery mandatory — but
  the instance needs a watcher to register against, so calling
  `mount(h\`<${App}/>\`, container)` without a recaller threw with
  *"Cannot read properties of undefined (reading 'watch')"*. Fixed:
  when no recaller is provided, function-components invoke inline
  (the legacy non-isolated path) and skip the instance/watcher
  dance entirely. Same shape as plain HElement vnodes in
  no-recaller mode.

**Two new internal tests** also landed, covering existing behavior
that the 7.6.0 release didn't yet exercise: nested cleanup (drop a
three-level subtree, verify the recursive walk tears down nested
watchers) and component-swap-on-key (same `data-key` bound to a
different component function — old instance tears down, new takes
over). 205 → 209 tests.

---

## 7.6.0 — fine-grained watcher boundaries: components own their reactivity

**The headline.** Each function-component invocation
(`<${Component} data-key=… />`) is now its own watch boundary. Reads
inside the component body register on that component's own recaller
watcher, not on whatever outer scope is rendering. When a reactive
read mutates, only the components that actually read it re-fire —
siblings and ancestors stay untouched.

Before this change, a single root watcher per `mount()` walked the
whole vnode tree top-down on every reactive mutation. The recycler
made the DOM writes cheap, but the *work* of walking the tree and
re-invoking every function-component happened on every fire. At
TodoMVC scale that's microseconds and invisible; at large-list
scale it was the next thing to come for.

**What changes for users.** Nothing API-shaped — same `mount`, same
`h`, same data-key convention. The improvement is observable as
behavior:

- A list of N items where one item's state mutates → only that
  item's body re-runs (was: all N).
- A nested component (`<${Outer}>` wrapping `<${Middle}>` wrapping
  `<${Inner}>`) whose inner reactivity mutates → only `Inner`
  re-fires (was: all three).
- A dropped component's watcher is torn down immediately; if its
  reactive sources later mutate, no ghost render fires against a
  detached element.

**The implementation.** A new `ComponentInstance` class lives
inside `mount.js`, one per `(parent, key)`. Each instance owns:
its component function, last-seen props, current DOM element,
last-rendered vnode, and a `recaller.watch` scope. The
`parentTriggered` flag distinguishes the two re-fire paths —
parent reconcile vs async recaller flush — so the work happens
exactly once either way (parent-triggered: build pass terraforms;
async: watcher terraforms itself in place).

Per-parent instance registries (`WeakMap<parent, Map<key,
ComponentInstance>>`) handle lookup; recursive subtree cleanup
unwatches nested instances when a DOM subtree is removed.

**Three tests pin the contract.** `h.mount.test.js` adds:

- *sibling isolation* — two components reading separate cells; a
  mutation of one cell does not re-run the other component.
- *nested isolation* — Outer/Middle/Inner, mutate Inner's cell,
  Middle and Outer's bodies don't run.
- *teardown on drop* — a dropped component's watcher does not fire
  on subsequent mutations of its old deps.

205 tests passing (203 → 205, plus 12 existing mount tests still
green).

**Constraint worth knowing.** Function-components in lists must
declare a `data-key` for instance lookup. Without one, the
fallback is position-based — fine for a singleton (e.g.
`mount(h\`<${App}/>\`, …)`), brittle if multiple unkeyed
components share a parent. This is the same rule that already
existed for DOM recycling; fine-grained boundaries lean on it
harder. CLAUDE.md continues to document the convention.

**What this enables.** Real fine-grained updates that scale to
large workloads; safe per-component memoization (each instance
has its own dep tracking); closer alignment with the mental
model newcomers bring from React/Vue. Future explorations
(memo-with-invalidation, per-instance-keyed memo across lists)
get cleaner now that the boundary exists.

---

## 7.5.0 — multi-home serving: every pushed repo is a public URL

**The headline.** Any repo a streamo relay holds is now addressable
as a public site at `/streams/<keyhex>/<path>`. Push your fork to
`streamo.dev` via `--origin streamo.dev`, and your fork is live at
`https://streamo.dev/streams/<your-key>/` immediately. No relay-side
configuration. No admin step. The author signs commits locally, the
bytes flow up via origin sync, the URL serves.

This is the multi-tenant property the dumb-pipe split was reaching
toward. The relay holds bytes; the URL pattern resolves any held
bytes to a public URL. The relay doesn't know what's being hosted —
it just serves whatever the registry holds at whatever path that
repo's `files` key contains.

**What changes for users.**

- The home repo keeps its privileged `/` mount (unchanged).
- Plus it's now also addressable at `/streams/<homekey>/`, serving the
  same bytes via the multi-home path.
- Any *other* repo the relay holds (forks, side-projects, anything
  pushed via origin sync) becomes addressable at
  `/streams/<thatkey>/`. If the repo has `files/index.html`, that's
  the homepage; assets at `files/foo.css` etc. work.
- Repos without an `index.html` fall through to the legacy JSON view
  at `/streams/<keyhex>` — backwards-compat preserved.
- `/streams/<keyhex>/raw` (raw bytes endpoint) is preserved as-is;
  it's skipped by the multi-home middleware so a file literally named
  `raw` would be shadowed (real-but-rare collision).

**Library API.** New named export `serveFromRegistry`:

```js
import express from 'express'
import { serveFromRegistry } from '@dtudury/streamo/repoFileServer.js'

const app = express()
app.use('/streams/:keyhex', serveFromRegistry(registry, { filesKey: 'files' }))
```

Mounts as a prefix; Express strips the prefix before delegating to
`serveFromRepo` under the hood. The middleware:

- Validates `:keyhex` as 66-char hex; falls through if not.
- Opens the repo from the registry (creates an empty one if no bytes
  are yet pushed — same obsecurity model as the existing routes).
- Delegates to `serveFromRepo` with the stripped sub-path.
- Falls through (calls `next()`) on missing repos, missing files,
  and the `/raw` sub-path so legacy routes win.

**Internally**, `serveFromRepo` gained a `pathFromReq` option that lets
callers override how the lookup path is derived from the request.
`serveFromRegistry` uses it indirectly (via Express's prefix-strip)
but the hook is also useful for custom routing schemes.

**190 tests** (was 189): +1 multi-home smoke test covering the
trailing-slash case, raw-bytes preservation, missing-file 404, and
that a fork's bytes serve at its own URL distinct from the primary.
The `smoke.test.js` `startServer` helper was extended to accept a
key-aware factory so tests can build registries with multiple repos.

**Why this matters.** Streamo just became a thing you can *publish*
on, not just sync through. A streamo-backed website used to require
its own relay (because the page-as-Repo middleware only knew one
home). Now a single public relay can host any number of independent
sites, each owned by a different keypair, each at its own URL. The
relay literally cannot tell what it's hosting — it doesn't have the
signing keys for any of it. Same dumb-pipe pitch, deeper realization.

**Migration notes.**

- *Existing relays* — no action needed. The home repo's privileged `/`
  mount is preserved; `/streams/<homekey>/` serves the same bytes
  via the new path. Existing `/streams/<key>` JSON view and
  `/streams/<key>/raw` raw-bytes endpoints are preserved.
- *Existing forks* — anyone who pushed a fork to a relay (via
  `--origin streamo.dev` etc.) gets a public URL retroactively. No
  re-push needed.
- *Custom Express apps using `serveFromRepo`* — keep working; new
  consumers can opt into `serveFromRegistry` for multi-home.

---

## 7.4.0 — presence is ephemeral; the relay can drop its signer

**The headline.** Chat-room membership is no longer a signed list on a
chain. Peers discover each other live via the existing
`announce`/`interest` ephemeral layer, with one new primitive: the
relay tracks current announces per (topic, ws) and **replays them to
peers expressing fresh interest**. Lifetime is "currently connected,"
not "ever announced" — on disconnect, the peer's announces are
dropped. Newcomers learn about already-broadcasting peers without
anyone heartbeating.

This dissolves what was left of the chat-room's smart edge:

- `chat-server.js`'s `onAnnounce → members` write is gone — was
  redundant with the chat client's own announce-back path, which is
  what was carrying real-time discovery already.
- The chat client renders the thread from per-author repos (as
  before); the explorer's "members" section now renders from a live
  `currentMembers` LiveSource populated by announces.
- Streamo.dev's existing `members` array (historical signed data)
  keeps loading via the chat client's legacy `follow: members` path,
  so old chat history remains readable. The roster naturally
  retires as those historical members fall away.

And the library + CLI gain a **relay-only mode** so the public-facing
server can hold no keys at all:

- `StreamoServer.create({ publicKeyHex })` opens a repo by pubkey
  with no signer derivation — `files()` and other write paths throw
  with helpful messages.
- `bin/streamo.js --home-key <pubkeyhex>` (env: `STREAMO_HOME_KEY`)
  bypasses the credential prompts; refuses `--files` /
  `--merge-from` up front because both want to commit. Banner shows
  a `MODE: relay-only (no signer)` row so the running shape is
  obvious.
- `chat/server.js` detects relay-only mode from env (set
  `STREAMO_HOME_KEY` without `STREAMO_USERNAME`) and skips the
  journal seed + fileSync entirely. The same binary, two startup
  shapes selected by config. The existing `npm run dev` / `npm run
  prod` workflows are unchanged — they fall into the legacy
  all-in-one path when credentials are present.

**Why this matters.** The dumb-pipe split is now a deployment-shape
choice, not an architecture problem. Deploy the relay with
`STREAMO_HOME_KEY` on the public box; run the author process with
your credentials wherever you like (your laptop, a separate user on
the same machine, a CI job triggered by a webhook). Sign commits
locally, push via `--origin streamo.dev`, the relay archives and
serves. Merge IS the deploy — no script needed (though `npm run
deploy` still works for shipping streamo itself).

**Library API.** New `StreamoServer.create` signature accepts
either credentials or `publicKeyHex`:

```js
// Author — derives signer, can commit
const server = await StreamoServer.create({
  name, username, password,
  dataDir, keyIterations
})

// Relay-only — opens repo by pubkey, no signer
const server = await StreamoServer.create({
  publicKeyHex,
  dataDir, keyIterations
})
```

**189 tests** (was 180): +4 for the announce-replay primitive (late
interest replays current announces; replay doesn't echo own
announces; disconnected peers drop from replay; replay covers
multiple announcers), +5 for the StreamoServer relay-only mode
(publicKeyHex propagates, `files()` rejects without a signer,
mode-mixing rejected, malformed pubkey rejected, credentials mode
no-regression).

**Migration notes.**

- *Existing relays* — no action needed. With credentials in env,
  `chat/server.js` runs in legacy all-in-one mode; the only visible
  change is a `[chat] mode: ...` log line at startup and the
  retirement of `[chat] new member: …` lines (members no longer
  written).
- *To run a relay without a signer* — set `STREAMO_HOME_KEY` in
  your env file, remove `STREAMO_USERNAME` / `STREAMO_PASSWORD`,
  restart. The relay opens the home repo's archive and serves
  bytes; an author process elsewhere supplies the signed commits.
- *Existing chat-room data* — append-only chains preserve history.
  Your relay's `home.value.members` array stays where it is; new
  joins simply don't append to it. The chat client still walks it
  for backwards compat.

---

## 7.3.0 — merge primitive + all-npx fork-and-serve

**The headline.** Forking a streamo-backed site into your own signed
repo is now one command. No `git clone`, no `npm install`, no
project-local script:

```bash
npx @dtudury/streamo \
  --name homepage --username alice \
  --merge-from streamo.dev --merge-from-key files \
  --files ./mysite --files-key files \
  --web 8081
```

You type five flags and a password, and you have a signed pure-copy
fork of streamo.dev's homepage running on `:8081` with files
mirrored to disk for editing. Re-running is idempotent (merge step
skipped because the repo isn't empty); your edits become signed
commits the same way any other streamo content does.

**Library API.** A new method on `Repo`:

```js
await repo.merge(source, {
  from: 'files',            // path on source to read (default: whole value)
  into: 'files',            // path on target to write (default: same as from)
  policy: 'replace',        // only 'replace' implemented; 'theirs'/'ours'/'throw' reserved
  remoteParent: { host, repo, dataAddress? },  // REQUIRED for Repo-source
  message: '…',             // optional; defaults to 'fork from <host>' / 'merge from <host>'
})
```

Incorporates a slice of `source`'s value into this repo as a single
signed commit with `remoteParent` cited. Two source shapes:

- **In-memory `Repo` instance** — caller provides `remoteParent`
  context (Repo class doesn't store its own host/keyhex)
- **URL string** — `http(s)://host[:port]/streams/<keyHex>` or
  shorthand `host[:port]`. The CLI fetches the snapshot via HTTP,
  loads into a temp Repo, falls through to the in-memory path.
  `remoteParent.host` and `remoteParent.repo` are *auto-filled* from
  the resolved URL.

Two natural shapes fall out of one primitive:

- **Pure-copy fork** — empty target + remote citation → no local
  parent, has `remoteParent`. "I'm starting my chain from their
  value."
- **Pull-overwrite** — existing chain + remote citation → both
  `parent` and `remoteParent` set. "I'm continuing while pulling
  this in from over there."

Only `policy: 'replace'` is implemented in this release. The three
descending policies (`'theirs'`/`'ours'`/`'throw'`) are reserved in
the API signature — adding them later doesn't change the surface.
Their semantic questions (absent-vs-deleted, Uint8Array equality)
deserve real workloads to settle defaults.

`Repo.commit` also gained `options.date` for back-stamping (used
internally by `streamo-history` seeding and merge replay scenarios).

**CLI flags.** `--merge-from <url>` (env `STREAMO_MERGE_FROM`) runs
the merge *only when the local repo is empty*; idempotent on re-run.
`--merge-from-key <key>` (env `STREAMO_MERGE_FROM_KEY`) optionally
slices a sub-key from the source value. Both new flags are
documented in the README CLI section.

**Onboarding.** [FIRST_STEPS.md](./FIRST_STEPS.md) reshaped around
the one-command flow — 4 steps (see, fork+serve, edit, find your
fork in the explorer) instead of 6 across two tools. The CTAs on
the README and homepage updated to match ("from zero to your own
signed fork in one `npx` command"). The
[`scripts/fork-homepage.js`](./scripts/fork-homepage.js) script
stays as a worked scripting example of using `Repo.merge()`
directly from Node.

**REPL exposure.** `--interactive` REPL gains `merge` as a
shorthand for `streamo.merge(...)`, alongside the existing `get` /
`set` / `connect` / `ls` shorthands.

**CLI polish.** The password prompt switched from
`questionNewPassword` (double-prompt for confirmation) to
single-entry hidden input. The deterministic password→key model
makes confirmation security-theater (typo'd password = wrong key
on the wire, not data loss). Friction on every re-run.

**TLS-aware `--origin`.** The `--origin` flag now accepts either
URL shape (`wss://host[:port]` / `ws://host[:port]`) or
`host[:port]` shorthand with auto-detect (port 443 → wss, no port
→ wss, other port → ws — same heuristic `Repo.merge`'s URL
parser uses). This makes the round-trip story work end-to-end
without a new flag: `outletSync` opens the user's repo on
handshake via `registry.open` (archiveSync-backed), so chunks
flowing up via origin sync are *automatically* persisted on the
relay's disk and addressable at `<host>/streams/<your-key>`.
The previously-drafted `--publish-to` flag was retired — byte
publishing falls out of the existing protocol; only TLS support
was missing.  Exported `parseOrigin(hostPort)` from
`StreamoServer.js` for callers and tests.

**`bin` field shape.** `"bin": "./bin/streamo.js"` (string) instead
of `"bin": { "streamo": "./bin/streamo.js" }` (object). Functionally
equivalent for installed packages but resolves more reliably via
`npx` for scoped packages.

**Testing.** Added `assert.rejects(fn, msg?)` to the testing utility
as the async counterpart to `assert.throws` — needed because
`async` functions wrap body-throws into rejected promises rather
than raising them synchronously. Existing `throws` unchanged.

**Tests.** 180 passing, up from 159. 12 new in `Repo.test.js`
(merge shape, slicing, citation, error cases, custom message),
2 new in `smoke.test.js` (URL-source via real HTTP server: full
URL form + host shorthand with `/api/info` discovery), 7 new in
`StreamoServer.test.js` for the `parseOrigin` helper.

**What's next.** Two threads, sized differently:

- *FIRST_STEPS step 5* (small, post-publish) — extend the
  all-`npx` flow with `--origin streamo.dev`, verify the bytes
  arrive on streamo.dev's disk, document the
  `<host>/streams/<your-key>` URL as the fifth step.
- *Dumb-pipe + smart-edge split* (bigger) — separate the
  public-port relay process (npx, no signer) from the application
  logic process (chat semantics, journal seeding, etc.) so the
  public-facing surface is small, simple, and signer-less.  See
  ROADMAP.

---

## 7.1.0 — Page-as-Repo: the homepage is a signed streamo you can fork

**The headline.** The relay's homepage is no longer a static file on
disk — it's the bytes of a signed repo, served straight from the home
log's `files` key. Edit a file in `public/homepage/` and your change
is a signed commit; the next HTTP request serves the new bytes; every
visitor with the public key can sync the whole chain. With one
command (`npm run fork-homepage`) any user authors their own
pure-copy fork of the page with a `remoteParent` citation back to the
relay, ready to serve and edit locally.

**Why this matters.** Streamo's pitch has always been "no server
holds authority over your data or your identity." But until now, the
relay's most visible artifact — its public face — was the one thing
on the server-side that streamo *didn't* author. Page-as-Repo closes
that loop. The website is now made of the same primitive the rest of
streamo uses; fork-able by anyone with a keypair; served the same way
any other repo gets served. The streamo project bootstraps onto its
own substrate.

**The arc, six pieces that compose:**

- **`serveFromRepo` middleware** — Express middleware that maps
  `req.path` → `repo.value[filesKey]` and responds with the right
  MIME type. Strong content-addressed ETags derived from
  `lastCommit.dataAddress + path`; 304 on `If-None-Match` match.
  HTML responses get an importmap injected that binds bare
  specifiers like `@dtudury/streamo` to a configurable library
  path — so a forked homepage on another relay self-resolves
  without edits.
- **`fileSync` gains `options.filesKey`** — the sync can now mount
  at a sub-key on the repo's value, leaving siblings (chat
  `members`, `journalists`, `entries`) untouched.
- **`remoteParent` on commit records** — `Repo.commit(working,
  message, { remoteParent })` accepts an optional
  `{ host, repo, dataAddress }` citation. The local chain stays
  single-author-signed; the remote citation is a footnote with
  cryptographic teeth (any peer with the cited stream can verify
  the value was at that address). The OBJECT codec encodes only
  present keys, so existing chunks stay bit-identical and old
  clients decode new commits as records without the field. Two
  natural shapes fall out: *pure-copy* (no local parent + a
  remote citation → "I'm starting my chain from their value")
  and *mixed* (existing parent + a remote citation → "I'm
  continuing my chain while recording a pull from over there").
  `Repo.commit` also got `options.date` for replaying
  pre-existing history with back-stamped timestamps.
- **Explorer renders `remoteParent`** — the commit metadata kv
  table grows a row when present, with a chip-link that
  navigates to the cited commit on the other chain. Same-host
  citations subscribe-then-navigate (new `open-foreign-at`
  action); cross-host citations are plain anchors in a new tab.
- **`streamo-history`** — a streamo whose commit chain mirrors
  the project's git log. `scripts/seed-history.js` walks
  `git log --first-parent --reverse` and replays each git commit
  as a streamo commit with value
  `{ sha, tree, parents, author, body }` and the git committer
  date back-stamped via `options.date`. Idempotent: re-runs
  append only the tail. The chat home now lists the history repo
  in `journalists`; the explorer's `follow` callback walks
  `journalists` too, and the home view shows them as cards — so
  the explorer now lights up with 231 signed commits the moment
  you boot the demo.
- **`scripts/fork-homepage.js`** — the first-user fork experience.
  Prompts for credentials, derives a keypair via PBKDF2, fetches
  the relay's home via `/streams/<key>/raw`, makes a pure-copy
  commit on the user's local repo with `remoteParent` set, prints
  the exact CLI command to serve the fork. Same mechanism any
  identity (including Claude's) would use; the script is just
  the ergonomic wrapper.

**Onboarding.** New [FIRST_STEPS.md](./FIRST_STEPS.md) walks any
user from clone to their own signed fork of the homepage in
~10 minutes (six steps; the fork is step 3). README gains a "Why
streamo?" section between intro and core ideas — a "things you
don't have to build" table (auth, API, sync, storage, backups,
multi-device, backend) + a "streamo fits if you…" audience list
(indie devs, personal-site folks, data-sovereignty builders, AI
tinkerers). The homepage gets a "first steps →" CTA above the
footer + a footer chip.

**CLI / API additions** *(all additive, no breaking changes):*

- `--files-key <key>` flag (env `STREAMO_FILES_KEY`) — mount
  fileSync at a sub-key
- `--web` auto-wires `serveRepoFiles` when `--files` is set, so
  `npx @dtudury/streamo --web --files=. --files-key=files` is the
  new one-liner for "serve my repo as a website"
- `serveFromRepo(repo, options)` exported via subpath import
- `npm run seed-history`, `npm run fork-homepage` script aliases
- `package.json`: `engines.node: ">=20"`, `homepage`, `bugs.url`,
  normalized `repository` to `{type, url}` object, and `bin`
  simplified to string form so `npx @dtudury/streamo …` resolves
  the binary cleanly for scoped packages

**Caveats.** Live-editing the public homepage from localhost while
prod is also running risks the multi-device write conflict from
"known limitations" (same keypair, two writers). Operational
workflow for now: stop prod before live-editing dev, or edit only
via prod. The structural fix (fork-detection-with-error or chunk-
level content addressing) is tracked there. Also: collapsing
FIRST_STEPS to an all-`npx` flow (no `git clone` + `npm install`
required) is queued as the next active thread — fold the fork-
homepage capability into the binary as `--fork-from <relay>`.

**Tests.** 159 passing, up from 121 in 7.0.0. New:
`repoFileServer.test.js` (25 unit + 2 HTTP smoke),
`fileSync.test.js` (5, including the critical "lastCommit exists
but no value at filesKey → disk wins, doesn't wipe" edge), 6
remoteParent/date tests added to `Repo.test.js`.

---

## 7.0.0 — Operation Obsecurity: the relay stops enumerating

**Breaking change.** The registry-sync wire protocol no longer carries
a `catalog` message in either direction, and the `filter` option is
gone. Pre-7.0 clients connecting to a 7.0 relay (or vice versa) will
sit in a non-fatal stall — they read each other's frames as unknown
JSON types and never auto-subscribe — so a coordinated upgrade is
needed. The name is a portmanteau of "security" and "obscurity":
private repos remain syncable by anyone who knows their key, but the
enumeration mechanism that listed them all is gone.

**Why.** Before this release, the relay's `catalog` message announced
every repo the relay happened to be storing — every cached private
repo's public key, leaked to anyone who opened a WebSocket. Clients
applied a `filter` to choose which ones to mirror, but the leak was
already done by the time the filter ran. The catalog was load-bearing
for discovery in early streamo, but as soon as the relay started
caching repos for users beyond its own home, "what's in there?"
became an answer the relay was giving out for free.

**What changed:**

- **`hello` is the new bootstrap.** A peer configured with a `home`
  repo (any relay; servers, typically) sends `{type: "hello", home:
  "<hex>"}` immediately after the `"registry"` handshake. The receiver
  auto-subscribes to that key — no out-of-band coordination required
  to learn the relay's public face.
- **Cascade discovery replaces enumeration.** The `follow` callback
  fires reactively on the home repo's value; walking `home.members`
  and calling `subscribe` on each member key is the streamo idiom.
  The cascade fans out from `hello` through content — every peer the
  relay exposes is reachable through some chain of `members` arrays.
- **Everything else is opt-in by key.** A client that knows a private
  repo's key can still call `session.subscribe(keyHex)` and the relay
  will serve the bytes. The protocol no longer announces that the
  relay even has that repo — knowledge of the key is the entire
  access-control surface for unlisted repos.
- **Removed from the wire**: the `{type: "catalog", keys: [...]}`
  message in both directions, the on-open re-broadcast of catalog
  changes, and the `filter` option (it was only ever a filter on the
  catalog).
- **Consumer cleanup.** `public/apps/chat/main.js` and
  `public/streamo/chat-cli.js` shed the now-vacuous `filter: k => k
  === rootKey` option. The chat is unchanged behaviorally — the home
  IS the chat room, so auto-subscribing to `hello.home` lands them at
  the same repo.
- **Explorer registry view (`#/`)**. Reshaped around the new model: a
  home card on top (the repo delivered by `hello`), a members cascade
  beneath it, and a paste-a-key input as the door for everything off
  the public list. The old "every repo we've seen" list is gone.

**The arc.** Operation Obsecurity landed in four commits, each
green-tested in isolation: (A) server announces `hello { home }`
purely additively; (B) catalog filters to home + members, reactive
on member changes; (C) catalog message removed entirely, client
auto-subscribes on hello; (D) explorer registry view matches.
Six `registrySync.test.js` tests were rewritten around the new
protocol shape — most notably "private repos do not sync without
explicit subscribe" replaced the old "filter prevents unwanted
syncing," because the security claim itself sharpened.

**Caveats.** Two writers with the same keypair still fork chains
(unchanged from 6.0; called out in `MEMORY.md`). The local `.streamo`
dataDir is forward-compatible — no on-disk format change — but
deployed relays and clients must be upgraded together to talk again.

**Test architecture.** 121 tests, all passing. No new test files;
six tests in `registrySync.test.js` were rewritten to match the new
protocol.

---

## 6.0.0 — hash chain #1: only the author writes to her repo

**Breaking change.** The signature scheme is replaced with a SHA-256
hash chain over chunks. All pre-6.0 stores are incompatible — old
archives must be deleted (or their authors must re-sign their data
into the new format). The wire layout of the SIGNATURE chunk and the
`Signature` value-class shape both changed; bumping the major version
is the honest signal.

**Why.** The pre-6.0 receive path had a structural hole: in a
`[commit_chunk, bad_sig]` sequence the commit landed in the store
*before* the sig failed verification. An untrusted peer with no
signing key could nudge data into a relay's dataDir whose author
never authorized it. We caught this in production after journalled
chunks ended up in an author's chain that her keypair had never
signed.

**What changed:**

- **Running accumulator.** Every Streamo carries a 32-byte chain
  value, folded as `acc' = sha256(acc || sha256(chunk))` starting
  from a 32-byte zero seed and re-seeded to the most recent SIG's
  accumulator after each SIGNATURE lands. The accumulator
  cryptographically commits to every chunk ever appended in order —
  no MMR, no inclusion proofs, just a single hash that says "this is
  the chain so far."
- **SIGNATURE is now a fixed 97-byte chunk**: `[accumulator(32) |
  signature(64) | footer(1)]`. No length prefix, no `partReaders`,
  no `wordReaders`. A relay reading just the last 97 bytes of a
  store knows the current accumulator without parsing anything else.
- **`sign()` signs the accumulator**, not a byte range. `verify()`
  is pure crypto — it does ECDSA verify and nothing else, since the
  accumulator is carried inside the signature record.
- **`makeVerifiedWritableStream` stages.** Incoming non-sig chunks
  are folded into a tentative accumulator but *not* appended. When
  a SIGNATURE arrives, both checks fire (chain match + crypto
  verify); if either fails the staged batch is discarded. The store
  is never polluted with unsigned bytes. This closes
  `[commit, bad_sig]` entirely.
- **Stateless relay verification.** A relay that wants to verify
  the next append needs only the most-recent 32-byte accumulator,
  not the prior byte stream. The "cold relay accepts the next
  commit from a logged-in author" path becomes a 32-byte read
  rather than a full-Repo replay.

**Caveats and follow-ups.** Two-writers-same-keypair (an author
writing from two machines in parallel) still produces forked chains
— this release does *not* fix that, and it's a separate footgun
called out in `MEMORY.md`. The local `.streamo` dataDir is wiped on
upgrade; deployed relays need their dataDir wiped too before clients
can talk to them again.

**Test architecture.** `sync.test.js` and `registrySync.test.js`
previously relied on the "plain data chunks pass through even with
fake keys" loophole — that loophole is now closed by design, so the
tests use real signers derived from a shared `Signer` whose pubkeys
match the repo IDs. 121 tests, ~2.3s.

---

## 5.1.0 — claudeSync, WSS, the relay loses authority over Claude

The headline: a streamo network now hosts more than one author cleanly,
and one of those authors can be a Claude — writing from her own
machine, with her own keypair, to a TLS-terminated relay that
holds her pubkey but not her password. Server-as-relay-not-gatekeeper
extended to its honest conclusion.

**`claudeSync` — Claude as a peer of the network.** A small module
(`public/streamo/claudeSync.js`) that opens a local Repo, syncs it
upstream via `originSync`, and exposes a higher-level API
(`appendJournalEntry` today; presence pings, commit comments later).
Built on `originSync` (single-stream primitive) rather than
`registrySync` because Claude has exactly one log to push. The
relay's home repo carries a `journalists` array of pubkeys; the
homepage walks every key in it via `registrySync`'s `follow`
callback and merges entries by date. Different authors, different
chains, one timeline.

**`originSync` is WSS-aware.** Takes an optional `protocol` (`'ws'`
| `'wss'`, default `'ws'`); pass `'wss'` to talk to a TLS-terminated
relay cross-host. `registrySync` already auto-derived `wss://` from
`location.protocol` in the browser; `originSync` is the matching
piece for Node callers.

**Mixed-content fixes for HTTPS-hosted pages.** Every browser client
now derives `ws://` vs `wss://` from `location.protocol`, and falls
back to port 443 instead of 80 when served over HTTPS — so a page
at `https://streamo.dev` doesn't try to open `ws://streamo.dev:80`
and get blocked.

**Homepage walks every journalist.** `public/index.html`'s journal
section subscribes via `follow` to all pubkeys in the home repo's
`journalists` array, merges their entries by `at`, renders the
newest five with author chips linking to the explorer. The home
repo's own author is always in the list; additional journalists
configured via `STREAMO_JOURNALISTS` (comma-separated) on the
chat-room server.

**Chat app and explorer caught up to the current voice.** The chat
app's HTML is now a thin loading shim (same pattern as 5.0.1's
explorer); body content lives inside one `mount(...)` call against
`document.body`, one `h` template. The explorer's at-view owns its
own factory wiring + its own `atTab` state via a `context.js`
module of singletons every other view imports from; `main.js`
shrinks to orchestration.

**Production deployment guide.** `SELF_HOSTING.md` walks the
hardening + Caddy + systemd + DNS recipe end-to-end, recovered
from the actual streamo.dev setup.

**Backward compat.** No breaking changes. `originSync`'s new
`protocol` arg is optional and defaults to `'ws'`. The
`journalists` field is additive. Existing Repos and `.env` files
keep working as-is.

---

## 5.0.1 — explorer polish

Explorer-internal cleanup; no public API changes. If you're using
streamo as a library and not running the explorer app, this is a
no-op for you.

**The explorer's index.html is now a loading shim.** The whole page
— header, conn pill, view sections — lives inside one `mount(...)`
call against `document.body`. index.html shrinks to a small body
with "connecting to streamo…" and the script tag; mount() replaces
it on first paint. Side effect: the connection-status pill is
reactive (a `connection` key on the explorer's state liveObject)
instead of imperatively-managed.

**CSS lives in its own file.** `apps/explorer/explorer.css`
replaces the 600-line `<style>` block in index.html. Same pattern
as `proto.css`; index.html drops from ~22KB to ~500 bytes.

**Routing memoized.** `view()` (the URL-to-route parser) caches by
hash; multiple consumers in the same render share one regex run.
Also dropped a redundant `kind` field — presence of `keyHex` IS
the route discriminant.

**Reuse-by-type table tucks into a `<details>`.** The
chunks/bytes/leverage breakdown under the byte strip is secondary
information; collapsed by default now, expand-on-click. Less
visual noise on narrower screens.

---

## 5.0.0 — one Recaller, many subsystems

Single thrust. The reactive substrate finally lives by one principle:
a `Recaller` is a *shared coordination point*, and every reactive
subsystem registers on it via its own `(target, key)` namespace.
Repo data, app UI state, async caches, custom-element components,
and the URL itself are all `(target, key)` consumers on the same
recaller. The old "wire up cross-recaller bridges everywhere"
mental tax disappears. Five breaking changes (see *Migrating*
below) and a substantial internal cleanup behind them.

**One Recaller, by default.**

- *`RepoRegistry` owns the bridge.* Pass your app's recaller via
  `new RepoRegistry(undefined, { recaller })` and the default
  factory creates Repos that *share* that recaller. Reading any
  repo's state inside a slot now auto-subscribes the slot to chunk
  arrivals — no `dep()` ceremony, no separate bridge module.
  Iteration, `get(keyHex)`, and `size` self-report on
  `(registry, 'keys')`, so slots iterating the registry auto-
  subscribe to new-repo opens too.
- *`bridgeRegistry` retired.* The module is gone; its job is built
  into `RepoRegistry`. Custom factories that want reactivity
  should pass `registry.recaller` into their `new Repo(...)`.

**The LiveSource agenda landed.**

- *App-level state is a `liveObject`.* The explorer's UI state
  collapsed from three ad-hoc signals + two mutable lets into one
  `liveObject({ atTab, hovered }, { recaller })`. Hello + journal
  got the same treatment for `loginSig` / `editSig`. The signal +
  `reportKeyAccess`/`reportKeyMutation` boilerplate dissolves.
- *Async caches are `liveObject`s.* The explorer's signature
  verify cache is a `liveObject` keyed by `${keyHex}:${sigAddress}`
  — async resolution fires the specific key; only badge slots
  that touched that signature re-run. Same shape for the
  expand/collapse state of the three trees, keyed by
  `${tree}:${keyHex}:${address}`.
- *The URL is a `liveLocation`.* The new `liveLocation` factory
  (lifted out of the `apps/location/` demo into the kit) wraps
  `window.location` as a LiveSource. The explorer's route lives
  there now instead of in a shadow copy of viewKind/keyHex/address.
- *`dep` / `fire` retired.* Slots subscribe via the reads they
  already do. The explorer's `main.js` no longer has either; the
  RepoRegistry methods of the same name are gone too.

**LiveSource-shaped constructors all match.**

Same shape across the kit:

    liveObject(target, { recaller, name })
    new RepoRegistry(factory, { recaller, name })
    liveLocation({ recaller, name })
    new Streamo({ recaller, name })       ← was new Streamo(recaller)

`Streamo.clone(addr, recaller)` becomes `clone(addr, { recaller,
name })` for the same reason.

**`StreamoComponent` can opt into a shared Recaller.**

    defineComponent(name, fn, { recaller })

Closes the last cross-recaller footgun. Components that pass the
app's recaller compose with app-level signals instead of being
isolated. Default unchanged — no `{ recaller }` means each instance
mints its own as before.

**Codec internals: `r` per-call, not in closure.**

Every codec's `encode` / `decode` and every helper in `codecs.js`
takes the registry interface `r` as a leading argument; nothing is
captured. `asRefs`'s mutation-impossibility is now a property of
*which `r` the entry point dispatches with* — `#readOnlyR` has no
`append`, so codec helpers that would materialize inline parts as
chunks (`getPartAddress`) return undefined rather than mutate. The
old `#readOnlyDepth` counter and `#runReadOnly` scope dissolved.
The ROADMAP "reference-quality clarity" thread closes — every item
in it has landed.

**Explorer: same app, twelve focused files.**

The 1764-line `apps/explorer/main.js` decomposed into a 257-line
orchestrator + eleven sibling modules (format, shapes, walking,
verify, render, analytics, trees, sections, interactions, byte-
stream, at-view). `main.js` reads top-to-bottom as a map of the
app — imports, factories, routing, mount, click delegation.
External behavior identical; internal cognitive footprint -85%.

### Migrating

**`bridgeRegistry` is gone.** Replace

    const { dep, fire } = bridgeRegistry(registry, recaller)

with

    const registry = new RepoRegistry(undefined, { recaller, name })

and drop the `dep()` calls from slots that read repo state — they
auto-subscribe via the shared recaller now. If a subsystem genuinely
needed a re-render trigger that wasn't repo-bound (verify cache,
tree toggle state), make that subsystem a `liveObject` rather than
threading a `fire` callback through it.

**`new Streamo(recaller)` → `new Streamo({ recaller, name })`.** Same
for `new Repo(recaller)`. The positional form was the only LiveSource-
shaped constructor that didn't take options; now they all match.

**`Streamo.clone(addr, recaller)` → `clone(addr, { recaller, name })`.**

**`Streamo.watch / Streamo.unwatch` removed.** Callers use
`streamo.recaller.watch(...)` / `streamo.recaller.unwatch(...)`
directly — honest about what's actually reactive (the recaller is
what holds the subscription; the streamo is just one thing it
watches).

**Custom codecs that built on `makeCodecs(r)`.** `makeCodecs()`
takes no args. Codec method signatures gained `r` as a leading arg:

    encode(v, asRefs)          →  encode(r, v, asRefs)
    decode(code, asRefs)       →  decode(r, code, asRefs)

Helpers (`inlineOrAddressPart`, `encodeMultipart`, `decodeParts`,
`getPartAddress`) shifted the same way. If you've only used the
public `CodecRegistry` API (no custom codecs), this is transparent.

---

## 4.0.6 — transparency + finish

Two thrusts. The explorer surfaces streamo's own mechanics — reuse,
structure, value-as-chunk-tree both directions, byte content rather
than type names. The chat and the broader visual surface pass through
a typography revision that drops the prototype feel and lands on a
streamo-native register.

**Explorer: reuse and economics, made visible.**

- *Dedup-leverage indicator on the byte-stream header* — "(N bytes ·
  M chunks · K× via reuse)" tells the compression story at a glance.
  Always shown, even at 1.00×, because honest is better than coy.
- *Per-codec table* under the byte strip — chunks, bytes, and
  leverage per codec type. The DUPLE row's "3.4×" surfaces the dedup
  work the chunk graph is doing under the hood. Graph roots (COMMIT,
  SIGNATURE) get "—" instead of "0×" because they're not reuse
  candidates by design.
- *Per-value economics footer* on every value-tab page — for the
  chunk you're viewing: subtree size, dependency size, naive cost,
  savings, leverage. Honest variants for graph roots (no reuse
  possible) and single-use values (no reuse yet).
- *Per-chunk reuse count in the inspector* — "in N commits" appended
  after the bytes/percentage line when N > 0.

**Explorer: chunk-graph as a symmetric pair.**

- *Storage tab* became a chunk-graph tree rooted at the current
  chunk, walking DOWN through `directReferences`. Surfaces the
  duples the value tab hides as scaffolding. Each row: codec chip +
  clickable @addr + value preview + collapse toggle.
- *Refs tab* — the twin going UP. Walks `directReferrers` until it
  hits graph roots (commits, signatures — the chunks nothing else
  references). Same row shape; the leaves of this tree are the
  roots of the chunk graph.
- *Storage tab cleaned up* — `chunkContextSection` and
  `referrersSection` (partial one-level views) removed; the refs
  tab does it all. Storage = "what this chunk is made of," refs =
  "what uses this chunk." Clean mirror.
- *DUPLE preview suppressed in tree rows* — "Duple(left, right)"
  was re-rendering the duple's two children one line above where
  they already live. Tree structure carries that information now.

**Bytes, not type names.**

- *Uint8Array previews show contents* — printable ASCII as `"alice"`,
  non-printable as hex (`61 6c 69 00`), truncated past 8 bytes with
  the full length pinned. The whole reason to walk down into chunks
  is to see the bytes; being told there are bytes is the wrong
  answer.
- *Three-row byte chart* for WORD/UINT8ARRAY previews AND the raw
  chunk-bytes section in the value tab — hex / character / decimal
  stacked one column per byte, monospace-aligned in an olive-tinted
  card. The chunk-bytes section adds offset labels in the left
  column and 16 bytes per row, traditional hex-dump width.

**Codec chip in the inspector.**

- The persistent header under the byte strip now leads with a
  colored chip (`[OBJECT]`, `[STRING]`, `[SIGNATURE]`) using the same
  cat-* palette the strip itself uses. Reads as "looking at the
  inspector = looking at the strip" in one glance. Black text on
  bright codes (amber, lime, yellow), white on saturated mid-tones —
  WCAG-luminance-correct, not just "white text everywhere."
- Commit chunks display "COMMIT" in the chip, even though the codec
  is OBJECT — same logic the rest of the explorer uses for the
  dropdown / banner / kindBanner.

**Scroll-to-current-chunk on navigation.** Clicking a commit in the
dropdown (or anywhere else that navigates) now smoothly scrolls the
byte strip to bring the new current chunk into view. Tracked per
container via `dataset.lastCurrent` so it only fires on actual
change, not on every chunk arrival.

**Typography pass — moving past the prototype.**

- `proto.css` body font changed from `cursive` (Apple Chancery on
  macOS, Comic Sans on Windows) to `system-ui, -apple-system,
  sans-serif`. The pre-existing comment in proto.css already said
  "Replace per-app when the app is ready to grow up" — streamo grew
  up.
- `--radius` simplified from `2px 8px 3px 7px / 7px 3px 8px 2px` to
  a clean `6px`. The asymmetry was a hand-drawn flourish; chips,
  inputs, cards, the byte-strip-container all now read precise.
- Homepage app cards lost the offset 2D hard shadow, gained a 1px
  rule border that darkens to ink on hover. Less rough; more
  finished.

**Chat: streamo-native ritual.**

- *Accent color* aligned to streamo blue (`#1d4ed8`). No more
  two-blues clash with the rest of the project.
- *Identity-as-color.* Each participant gets a deterministic hue
  derived from their publicKey. Same key always renders in the same
  color, everywhere, for everyone — visual identity = cryptographic
  identity. Bubble accent strips and sender labels take the hue;
  the chat header's "(username)" carries a small swatch showing your
  own color.
- *Date separators* between messages from different days — "today"
  / "yesterday" / weekday for the past week / locale dates for
  older. Only emitted when the day actually rolls over.
- *Empty-state message* when no one has said anything yet, beating
  the old behavior of staring at literal nothing.

**Documentation reorganization.**

- *Created `CHANGELOG.md`* (this file). Release history moved here
  from ROADMAP. ROADMAP is now future-focused: current state +
  what's next + known limitations + "the longer view" (renamed from
  "beyond 1.0", which was version-pegged in a way that ages poorly)
  + loose ideas.
- *Caching relay server* design captured under "the longer view" —
  the multi-session architecture conversation, including the
  broadcast-only-from-upstream invariant, the asymmetric trust
  model, and live-website hosting as the first concrete deployment.
- *Stream-commitment cryptography* entry — the natural successor to
  the relay's write-verification problem (Merkle accumulator over
  the byte stream, no cached history needed to verify writes).
- *Repo size — practical caps and lifecycle* under known
  limitations, reasoning through the UX bands (2 MB chat-shaped,
  5-10 MB longer-form, 50+ MB needs different infrastructure) and
  the successor-ref lifecycle pattern.

---

## 4.0.5 — instrument panel + brand

Nine commits past 4.0.4. The thread holding them together: make the
explorer a stable *instrument panel* that doesn't lose your context,
and give streamo a real visual identity to anchor it.

**Reactive infrastructure that paid back immediately:**

- *`mount`: recursive reconcile.* Recycled elements now have their
  descendants reconciled in place (data-key first, then tag-pool),
  not trash-and-rebuilt. DOM identity, scroll state, focus, and any
  external attachments survive on every level — not just the outer
  recycled element. This is what unlocks the rest of this list.
- *Signal decomposition in the explorer.* Three signals replace one
  bridge: `viewKindSignal` (kind/keyHex — repo switch only),
  `bridge` (chunks, address, tab, async — everything else), and
  `hoverSignal` (strip hover preview). Each slot reads exactly the
  signals it depends on; intra-repo navigation no longer re-runs
  the outer mount slot, which means the at-view <section> (and the
  byte strip inside it) stays alive across clicks. Combined with
  recursive reconcile, the strip is essentially permanent until you
  switch repos.

**Explorer polish riding on that foundation:**

- *Live hover preview.* Hovering a chunk in the byte strip peeks the
  page content below tabs at that chunk's value/storage; mouseout
  reverts. The strip itself, the selector, and the tabs all stay
  put — only the content area updates.
- *Persistent chunk inspector.* A header line under the strip names
  the current chunk's codec, address, length, and percentage of the
  stream. Quiet by default; lights up to follow hover.
- *Commit-reachability index.* The storage tab's "reachable from"
  block now correctly reports which commits can reach a chunk —
  even when the chunk is referenced via `dataAddress` or `parent`,
  which are FLOAT64 number values rather than `asRefs` (BFS from
  each commit's `dataAddress` through `asRefs` builds the index).
- *→ glyph on commit pointers.* The `dataAddress` and `parent` rows
  in the commit kv table show a "→ @addr" pill that reads as
  navigable; without the arrow, the pointer looked like any other
  numeric value.
- *Storage tab: position context + codec colors.* "byte X of Y"
  framing on every chunk, with a covering-sig hint and the strip
  palette extended into the storage chrome.
- *Scrollbar-gutter: stable.* The chrome no longer shifts when
  content grows past the viewport.

**Brand identity:**

- *Yin-yang basketball seam mark* — seven named circles, every curve
  provably-related to every other point; nothing freehand. Replaces
  the 🌊 emoji everywhere it appeared.
- *Lockup pattern.* `[mark + streamo]` is a clickable home link, with
  page titles as a separate `<span>` after a `·` separator. Used on
  the explorer, chat, and homepage.
- *Color.* The mark is filled with `#1d4ed8` — readable on dark
  monitors without losing the streamo blue.

**Homepage:**

- *Journal feature.* The home repo's `entries[]` array now renders
  live on the homepage with a "see all entries in the explorer →"
  link. Updates as new entries land.

---

## 4.0.x — explorer reshape

A multi-day pass over the repo explorer. Each step was small; together
they reframe the tool around the user-meaningful unit (a commit) and a
git-like URL space, while fixing one real correctness bug along the way.

**Real bug fix (`Streamo.js`, regression-tested):** `#signedLength` only
advanced inside `sign()`. Loading a streamo from disk (archiveSync) or
streaming chunks in from a peer left it at zero, so the next local
`sign()` would re-sign all of history with `signedFrom=0`, producing a
sig whose claimed coverage collided with every prior sig. Fixed by
hooking into `Streamo.append()` — every sig chunk advances the cursor,
no matter which path delivered it. Old over-covering sigs still verify
(over-covering is harmless, just wasteful); new commits accumulate
cleanly going forward.

**Explorer reshape — shipping in the npm tarball as the demo:**

- *URL space.* `#/repo/<hex>` is now shorthand for `at HEAD`, the
  symbolic ref that resolves at render time to the most-recent commit.
  Pinned addresses are `at/<num>`. `RepoView` is gone — `AtView` covers
  every page in a repo. Browser back/forward and shareable URLs work
  for every state including dropdown selection.
- *Commits as the unit, not signatures.* The dropdown enumerates
  commits (HEAD, HEAD-1, …) — 16 messages stay 16 dropdown rows even
  when batched into one signature. Each commit has its own page; the
  verifying sig is the credential, not the unit. Sigs are still
  browseable at `at/<sig-addr>` but the page there is auxiliary.
- *Detached state.* Like git's detached-HEAD: when the current address
  isn't a commit (drilled into a Duple, a sig, raw bytes), the selector
  summary shows a neutral "detached" card. The body still lists every
  commit so you have an always-present way back. UI doesn't shift
  between commit pages and storage drilling.
- *Consistent banner.* A `kindBanner` at the top of every value tab
  identifies "what this is" — `signed commit` / `commit (unsigned)` /
  `signature chunk` / `object · 7 fields` / `duple` / `string` / etc.
  Variants: green `verified` for commits or sigs with a valid covering
  sig; dashed `unsigned` for commits awaiting one; default neutral for
  storage codecs.
- *Direct kv tables for commit content.* The polished inline-packed
  headline ("today 14:32 · parent @X · commit chunk @Y") is replaced
  with the same labelled-row table the Object branch uses — every
  field on its own row with addresses as clickable links. A
  verification table follows, linking to the covering sig.
- *Draggable byte-strip.* Modestly zoomed (`ZOOM=2 + MIN_PX=8`) so
  even 1-byte chunks are clickable; horizontally scrollable; click-drag
  to pan with grab/grabbing cursors. Auto-scrolls to HEAD on first
  render and stays pinned to the right edge unless the user drags
  off. Hovering any element with a `data-addr` smooth-scrolls the
  matching chunk into view in the strip. (No minimap — dropped in
  favor of single-strip simplicity. Easy to add back.)

**Other small fixes:**

- Chat client (web + cli) now stores message timestamps as `new Date()`
  instead of `Date.now()`, so they round-trip through the DATE codec
  and render as dates everywhere. Old number-stored messages keep
  rendering correctly thanks to coercion-tolerant display paths.
- Cross-view DOM recycling fix: each top-level view is wrapped in a
  data-keyed `<section>` so mount's tag pool can't keep stale text
  children when you switch between views.

**Foundation work that fell out:**

- *`bridgeRegistry` (new public API).* The cross-recaller bridge —
  forwarding repo-level mutations onto an app-level Recaller so a mount
  slot can read from many repos and re-render on any-repo-changed — is
  now a one-liner: `const { dep, fire } = bridgeRegistry(registry,
  recaller)`. Both chat and explorer use it; ~10 lines of boilerplate
  removed from each. design.md §9 explains why each Repo has its own
  Recaller and why mutation must be synchronous (rAF wrapping was a
  real failure mode — see below).
- *`mount` recycle bug.* Recycling elements by `data-key` only patched
  static attrs and reused inner DOM verbatim, so static `${value}`
  interpolations captured at first mount stayed stale forever. Chat
  survived only because each message has a unique data-key (no
  recycling with new content); the explorer's stable per-repo data-keys
  hit the bug hard. Fix: when an element is recycled, clean up the
  subtree's watchers, clear inner DOM and outer attributes, then apply
  fresh attrs and mount fresh children. Outer node identity is
  preserved (so document position survives); inner state is rebuilt.
  Correctness over speed; the recursive-reconcile follow-up is parked
  in `THREADS.md` for when someone hits the perf cliff.
- *`Streamo.append` advances the signed cursor on EVERY signature*,
  not just sign()'s own. Loading from disk or peer-streaming was
  leaving `#signedLength` at 0, so the next local `sign()` claimed
  coverage from byte 0 — producing redundant over-covering signatures.
  Fixed and locked in by a regression test.
- *Async correctness in the reactivity bridge.* The explorer's `fire()`
  used to wrap its `reportKeyMutation` in `requestAnimationFrame`
  guarded by a `scheduled` flag. When the tab lost focus, queued rAFs
  were throttled, the flag stayed `true`, and every subsequent
  mutation became a no-op until the rAF eventually drained — the
  display would freeze until the user came back to the tab. Mutate
  synchronously; the Recaller's own `nextTick` flush already coalesces.
- *Streamo-typed value displays.* Every primitive (string, number,
  date, boolean, null/undefined, Uint8Array) renders with type-specific
  visual identity instead of being flattened through `JSON.stringify`.
  Strings get green smart-quoted mono frames; dates render as `<time>`
  elements with 📅 + tabular-num clock; numbers, booleans, etc. each
  have their own pill. Colors echo the byte-strip codec palette so the
  visual language carries across the page. Composite expansion
  (depth-controlled object/array rendering) is parked in `THREADS.md`
  as the next polish.
- *Detached commit selector.* The selector dropdown is now visible on
  every at-view, not just signed-commit pages. When the address isn't
  a commit, the summary shows a neutral "detached" card (mirroring
  git's detached-HEAD). Body still lists every commit, so the
  always-present way back is one click. UI no longer shifts between
  commit pages and storage drilling.

---

## 4.0.0

4.0.0 closes a long-standing design wart: **`asRefs` could mutate the streamo
during a read.**

The story: `getPartAddress` in `codecs.js` was called from `DUPLE.decode` to
return a child's chunk address. For inline-multi-byte children that didn't
have a separate chunk address yet, the only way to "give back an address"
was to `r.append(code)` — materializing them. That branch ran from any read
path that asked for refs. In practice it almost never fired, because
`Streamo.set` internally calls `asRefs` during writes which pre-materializes
along any path that gets touched. But the code path existed, which means a
peer that *only* read (e.g., the explorer) could in principle grow its local
stream — and a future change in encoding behavior could surface this.

The fix makes mutation **structurally unreachable** from `asRefs`:

- `CodecRegistry` keeps a `#readOnly` depth counter, exposed to codecs via
  `r.readOnly`. The public `asRefs(addr)` increments the counter around its
  internal `decode(addr, true)` call. `getPartAddress` checks the flag and
  returns `undefined` for the inline-multi-byte case instead of appending.
- Inline addresses come back as `undefined`. Callers that need addresses for
  navigation (the explorer, `Repo.getRefs`) handle that case by rendering
  the child without a navigable link.
- `Streamo.set` and `setRefs` switched to a new internal `_asRefsForWrite`
  that bypasses the counter; their materialization is appropriate because
  they're already inside a write op.

Regression test in `Streamo.test.js`: builds a peer streamo via raw
`makeWritableStream` (so no internal `set` runs to pre-materialize), walks
every reachable address calling `asRefs`, asserts `byteLength` does not
change. **Reading is now mathematically incapable of mutating the
streamo** — protection lives in the function, not the caller.

Breaking: any external caller that somehow relied on `asRefs`'s old side
effect would now see `undefined` for inline children. None known; the
previous behavior was a bug, not a feature.

Explorer: object/array views handle `undefined` child addresses by
rendering the row non-clickably with the decoded preview pulled from the
parent and an "(inline)" tag.

---

## 3.1.0

3.1.0 is a codec contract pass — investigating `codecs.js` (the largest source
file, historically the most-fixed area in the predecessor project) found two
real bugs and a handful of behaviors worth pinning. New `codecs.test.js`
exercises 17 scenarios covering primitives, boundaries, composites, dedup, and
the deliberate quirks.

**Fixed:**

- `Duple.flat()` used `Array.prototype.flat()` which silently flattened **any**
  nested array a caller had stored, not just the internal Duple tree. Effect:
  `[3, [4, 5, 6]]` was round-tripping as `[3, 4, 5, 6]`. Encoding was already
  correct — only the decode side was lossy. Replaced with explicit Duple-only
  walk. Old chunks now decode correctly under the new code.
- `new Uint8Array(0)` had no codec — WORD requires ≥1 byte, UINT8ARRAY
  requires >4. Added `EMPTY_UINT8ARRAY` at the **end** of the codec list so
  existing footer values don't shift; old data unaffected.
- Empty class instance (`new (class {})()`) had no codec because EMPTY_OBJECT
  rejected non-`Object.prototype` objects but OBJECT didn't. Made consistent;
  both now accept class instances (with type info lost on round-trip, same as
  before for non-empty class instances).

**Pinned (not bugs, just deliberate quirks now documented):**

- `-0` round-trips as `0` (UINT7 path).
- Class instances always lose their prototype.
- Object key insertion order is part of the chunk identity — `{x:1, y:2}` and
  `{y:2, x:1}` are different chunks. Dedup is by bytes, not semantics.
- Sparse arrays round-trip as sparse via the `length`-key encoding trick.

---

## 3.0.0

3.0.0 fixes a signature-coverage off-by-one in `Streamo.sign` / `verify`.

**The bug.** `sign` sliced bytes as `(signedLength, before - 1)` (exclusive
end), dropping one byte from coverage — specifically the footer of the last
chunk before the signature. `verify` and `makeVerifiedWritableStream`
mirrored the same exclusive end, so signatures still validated, but a
flipped byte at that exact index would not have been caught.

**The fix.** All three sites now slice `(signedLength, before)` — the full
pre-signature byte range. Regression test in `Streamo.test.js` independently
computes the expected signature over the full range using RFC 6979
deterministic ECDSA and asserts byte-equality against `sign`'s output.

**Breaking.** Signatures created with 2.x cover a different byte range and
will not verify under 3.x (and vice versa). Existing `.streamo/archive/`
data still reads but its signatures will fail verification — fine for
fresh dev environments, ugly if shared between clients on different
versions. New code talks to new code.

The 3.0.0 release also includes everything from the recent rich-explorer
work: hash routing, signature/changed-paths visibility, address-aware
drilldown, raw-bytes hex dump, and 20s WebSocket keep-alive pings.

---

## 2.0.0

2.0.0 was a surface and correctness pass on top of 1.0:

- **Cleaner package surface** — `index.js` exposes named exports, `exports` /
  `files` / `main` are explicit, test files no longer ship in the npm tarball.
  Imports go from `'@dtudury/streamo/public/streamo/Streamo.js'` to
  `'@dtudury/streamo'`.
- **Signer determinism made explicit** — derivation switched from
  `deriveKey + exportKey + slice(32)` (which silently relied on the WebCrypto
  HMAC-default key length) to `deriveBits(..., 256)`. A known-answer test pins
  the byte output. **Breaking**: identities derived in 1.x do not match 2.x.
- **Recaller `unwatch` bug** — a watcher already queued in `#pending` could
  resurrect itself on the next flush. Fixed; regression test added.

Below is the underlying capability surface (unchanged in 3.0.0):

**Core data layer**
- `Streamo` — reactive, content-addressed, append-only byte store with a
  self-describing codec. Same value always encodes to the same bytes; dedup and
  diffing are free.
- `Repo` — every write is a signed commit. Message, date, data address, parent.
  The full history is always there. `attachSigner(signer, name)` enables
  automatic signing after every commit; concurrent commits are batched safely.
- `Signer` — deterministic secp256k1 keypairs from username + password via PBKDF2.
  No key files to manage; same credentials always produce the same identity.
- `Recaller` — fine-grained reactive dependency tracker. Watchers re-run only when
  the exact paths they accessed are mutated. Efficient and precise.

**Sync layer**
- `registrySync` — bidirectional multi-repo sync over a single WebSocket. Catalog,
  subscribe, and content-driven discovery via `follow`. Works in both Node and the
  browser.
- `outletSync` / `originSync` — server and client sides of a peer connection.
- `archiveSync` — persists chunks to binary files on disk. Repos survive restarts.
- `fileSync` — mirrors a repo's value to/from the local filesystem.
- `s3Sync` — replicates chunks to S3-compatible object storage.
- Ephemeral messaging layer — `interest` / `announce` for peer discovery without
  any persistence.

**UI layer**
- `h` — tagged template literal parser. Turns `` h`<div class=${cls}>...` `` into a
  virtual tree of `HElement` / `HText` / slot nodes.
- `mount` — reactive DOM renderer. Slots that are functions re-run automatically
  when the data they read changes. No virtual DOM diffing — only the exact nodes
  bound to mutated paths update. Watcher cleanup is precise: removed nodes are
  unwatched before removal so watchers never accumulate. Elements are recycled
  across re-renders by `data-key` (exact) then tag (positional fallback), so user
  input and focus survive list reorders. SVG namespaces propagate automatically —
  `` h`<svg><path/></svg>` `` just works. `class` accepts an array
  (`['btn', isActive && 'active']`) or an object (`{btn: true, active: false}`).
- `StreamoComponent` — base class for hot-reloadable custom element components.
  Function components (`(props) => nodes`) work directly as tags in `h`. For
  hot-reloading, `componentKey(prefix, address)` and `defineComponent(name, fn)`
  pair a content address to a unique custom element name — a new file version gets
  a new name, stale elements are naturally orphaned and cleaned up.

**Apps**
- Chat — full p2p messaging app. Each participant owns their own signed message
  stream. `public/apps/chat/server.js` is **the all-in-one demo entry point** —
  it's both a chat room and a static-file server, serving the homepage, the
  chat app, and the explorer on one port. Its public key is the room address,
  its member list is in its own repo, and it has no special authority over
  anyone's data. Runs in the browser and from the terminal (`chat-cli.js`).
  Message history persists across page reloads via server-side archiving.
- Explorer at `public/apps/explorer/` — read-only browser for the live
  registry. Click a repo → see its commit history → click a commit → see the
  value at that point. Hash-based routing so refresh / bookmark / back-button
  all work.
- Homepage at `public/index.html`.
- `StreamoServer` — reusable class that wraps signer, registry, and all sync
  methods behind a clean API. `bin/streamo.js` is now a thin CLI parser on top
  of it; `public/apps/chat/server.js` is a standalone chat server using the
  same class.
- `npm run dev` — runs `public/apps/chat/server.js` against `.env.dev`,
  the canonical "play with the repo" entry point. `npm run prod` runs the
  same server against `.env.prod` (lives only on the production host).
