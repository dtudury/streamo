# streamo roadmap

Future-focused — what we're aiming at next and what's beyond the horizon.
Release-by-release history is in [CHANGELOG.md](./CHANGELOG.md).

---

## current state

Streamo is at 8.6.0, published to npm as `@dtudury/streamo`, and
live on streamo.dev as the canonical reference deployment.
**8.6.0 lands a service worker and hand-rolled Web Push** — the
homepage registers a network-first `/sw.js`, and a chat message can
now reach you with no tab open: VAPID + RFC-8291 message encryption,
done with Node built-ins and no dependencies, pinned to the RFC's own
test vector. The relay grew a generic `routes` hook, push endpoints, a
subscription store, and a `notifyOnMessages` watcher; the chat client
subscribes on login.
**8.5.0 lands auto-reconnect** — a dropped registry WebSocket re-opens
itself with exponential backoff + jitter instead of going silently
dead. The session object stays stable across the gap and replays its
subscriptions and interest; `session.close()` opts out, the chat
surfaces a quiet "reconnecting…", and the explorer's connection pill
tracks the live socket rather than sticking on a stale "disconnected".
8.5.0 also lands the chat notification channel — a Web Audio ding on
incoming messages, `notify.js` for non-interactive posting, the
bounded `watch.js` presence + reply watcher, and a presence dot that
reads liveness by announce-staleness.
**8.4.2 fixes `/streams/:key/raw`** — the route's byte counter read
only the first segment of an 8.4 batched frame, so the HTTP response
never ended and clients hung; it now walks the whole frame. It also
lands the explorer commit wheel (phase 1) — a Price-is-Right big-wheel
commit picker that spins but doesn't navigate yet.
**8.4.1 fixes the wire parsers' O(N²)** — `buf = buf.slice(rest)`
per-chunk became `buf.subarray(...)` + `bufOffset` pointer.
archiveSync startup of streamo-history went from 22.7s of
event-loop block to subsecond; recurring 1-7s steady-state lag
events from WS echo handling vanished. **8.4 batches the wire
reader's frames** — `makeReadableStream` now packs all ready
chunks into one frame (capped at 256KB) instead of
one-frame-per-chunk; a 21KB repo goes from ~10,000 WS sends to 1.
Surfaced a latent `seed-history` archive flush race that the old
slow path had been masking (now papered over by the same
batching; proper fix filed). **8.3 lands recovery UX v1** —
both divergence flags (`pushRejected`, `conflictDetected`) carry
the rejected commit's `dataAddress`, and the chat banner has
Send/Discard buttons that re-sync from the relay and (on Send)
merge the local-only writes back in. **8.2 makes the subscribe
handshake carry the client's chain anchor** — the `subscribe`
JSON includes `(fromOffset, fromChainHash)`; the server validates
and streams only post-anchor bytes, saving the genesis-replay on
every reconnect. Wipe-recovery self-heals as a side effect. **8.1
collapses `registry.open` + `session.subscribe` into one verb** —
`await session.subscribe(key)` opens the Repo locally, plumbs the
wire, and returns the Repo. **8.0 makes the relay the single
chain authority per repo** — a per-repo `RepoSerializer` at the
relay atomically accepts or rejects incoming pushes against the
current top; clients receiving the authoritative stream trust +
append. Conflict detection that used
to happen by accident at every client now happens deliberately at
one point, and rejections come back to the client as a real
reactive signal (`repo.pushRejected`). 8.0 also lands a layering
pass — Streamo is now a pure content-addressable codec, every
chain-and-signing concern lives on Repo — plus a chain-hash
simplification (2 sha256 calls per signature instead of 2N) and a
vocabulary cleanup (fork/branch/conflict/merge per streamo's
actual model, not git's). All breaking; see CHANGELOG for the
migration. Underneath, 7.6 fine-grained watcher boundaries (each
`<${Component}/>` invocation is its own watch scope), 7.5
multi-home serving (every pushed repo is a public URL at
`/streams/<keyhex>/`), 7.4 dumb-pipe relay (the relay can drop
its signer), 7.3 merge primitive + all-npx fork-and-serve, 7.1
Page-as-Repo, 7.0 Obsecurity, and 6.0 hash-chain signatures are
unchanged. The all-in-one server (`npm run dev` / `npm run prod`)
hosts the homepage, chat, explorer, todomvc, and the
`streamo-history` repo on one port. 234 tests passing.

See [CHANGELOG.md](./CHANGELOG.md) for the detailed history of how we got
here.

---

## what's next

### explorer value-view + bytestream performance *(active thread)*

Now that the `streamo-history` repo is loaded by `npm run dev` and
has 286+ commits seeded, the explorer is the first place the value
tab encounters genuinely big data: each commit is a `{ sha, tree,
parents, author, body }` value plus the commit-record envelope.
Originally reported 2026-05-16; re-validated 2026-05-19 with the
seeded history live in the browser.

**What's landed (2026-05-19):**

- `repoExtras` removed from the commit view — it was rendering
  ~200+ chunk rows on every navigation, redundant with the storage
  tab. Kept in the no-head case for future trust-me mode.
- The by-codec breakdown table below the byte strip removed (lines
  113-126 + the `<details>` element). The per-type walk decoded
  every chunk in the stream on every render — ~2000+ chunks at
  286 commits, run on every commit-dropdown navigation. Collapsing
  the `<details>` visually didn't skip the work; the rows were
  always built. Re-introduce as a click-to-load lazy panel.
- Fine-grained watcher boundaries (7.6.0) — sibling components
  don't re-render on a dep change. Lower bound on the cost.

**Still suspected (in rough order of remaining weight):**

- *Inspect-bytes-via-strip is a known killer.* David tried to
  inspect the bytestream interactively at 286 commits and the
  browser locked up. Suggests the chunk inspector or the strip's
  hover handler is doing per-byte work it shouldn't. The
  `xForByte` linear search through chunks (byte-stream.js:92) is
  one suspect — it walks chunks for every byte position queried.
- *`safeJSON` rehydrated `<pre>`* stringifies the whole decoded
  value on every render, even when most of it isn't visible.
  Less suspected than initially feared — kv-table is the main
  view and is one-level-only — but the stringify is still real
  work per render. Lazy-render-on-expand would handle it.
- *HEAD-N commit dropdown* lists every commit (no virtualization,
  no filter). At 286 it's still usable; at thousands the dropdown
  itself becomes the bottleneck. David's proposed shape: a
  scroll-wheel picker (momentum-flick + editable jump-to-N
  number) over the chain, with the rest of the page updating
  live. Depends on per-commit render being cheap.
- *kv-table is fine.* Initial worry about full-tree-eager walk
  was overstated; it's one level + preview decode per child.
  Scales with field count, not depth.

**The bytestream interface deserves its own rethink.** The strip is
beautiful at small scales and visibly strained at large ones. The
chunk inspector, the hover overlay, and the (now-removed) by-codec
breakdown all share the strip's coordinate system. A redesign that
considers virtualization (chunks far off-screen need not be in the
DOM), lazy-load panels (breakdown stays as a click-to-load), and the
scroll-wheel-picker shape above could land as one focused effort.

Goals for this thread: open a commit feels instant; the bytestream
strip stays responsive at thousands of chunks; the dropdown stays
usable at 1000+ commits.

### archiveSync flush race — `seed-history` can lose tail writes under load *(small fix, important)*

`scripts/seed-history.js` does `process.exit(0)` after a 500ms
settle window. archiveSync's writer loop is fire-and-forget — when
the process exits, in-flight `fileHandle.write` calls and queued
ReadableStream values are dropped. With 8.4's batching this drains
fast enough that small seeds (a few thousand commits) flush
cleanly, but a bigger seed (10K+ commits) or a sustained-write
workload could still lose tail chunks — typically the SIGNATURE
chunks appended last by auto-sign, which is exactly the case that
makes the loaded `.bin` look complete but actually be staged-
forever-no-SIG on the client side.

The proper fix is an awaitable `archiveSync.flush()` (or a
deterministic drain) so seed-history can wait for the writer loop
to catch up before exiting. ~30 LOC change. Filed here as a
reminder; not blocking at our current scale.

### wire-protocol upward-path optimization + sender-side echo-skip *(small follow-ups to 8.2)*

8.2 (in progress / about to ship) landed the downward-path optimization:
the subscribe message carries `(fromOffset, fromChainHash)`; the server
validates and streams only post-anchor bytes; the receiver's
`makeRelayInboundStream` anchors `pendingChainHash` to the local
`committedChainHash`. Two smaller cleanups remain:

- **Upward path** still replays from byte 0. The relay-side
  `ConnectionAccumulator` dedupes via the SIG-already-in-content-map
  check, so it's not a correctness issue, just wasted bandwidth on
  reconnect. Symmetric handshake would let the client also start from
  `serverState.fromOffset`, but the server doesn't currently announce
  its state to the client — would require a `subscribed` reply message
  or a piggyback on the server's first downward frames.
- **Sender-side echo-skip** at the relay. Today the relay broadcasts
  every accepted chunk to all subscribers including the original
  pusher; the receiver dedupes via `alreadyHave`. Cleaner shape:
  relay tags each push with the submitting WS, and the broadcast loop
  skips that WS. Then `makeRelayInboundStream` no longer needs the
  `alreadyHave` defensive check. Small bookkeeping at the sender for
  a one-line removal at the receiver.

Neither is blocking. They're "low-glamour cleanup" candidates for
between-arcs days.

### FIRST_STEPS step 5 — visit your fork on the public relay *(post-publish)*

Once 7.2.0 ships, the all-`npx` flow can be extended with
`--origin streamo.dev` (or `--origin wss://streamo.dev`).  The
relay's `outletSync` opens the user's repo on handshake via
`registry.open`, which is archiveSync-backed, so the user's
chunks are persisted on the relay's disk as they flow up.  No
new flag needed; this falls out of the existing protocol +
TLS-aware `--origin` parsing landed in 7.2.0.

When `streamo.dev` is verified end-to-end, FIRST_STEPS gets its
fifth step: *"visit https://streamo.dev/streams/&lt;your-key&gt; —
your fork lives on the public relay now."*

*Earlier draft proposed a `--publish-to <host>` flag with
explicit announce semantics.  David caught it (2026-05-17):
announce is chat-app discovery — adding the user to the home
repo's `members` cascade — not a generic "publish my bytes"
operation.  Byte publishing already falls out of the existing
origin handshake + the relay's archiveSync-backed factory.
Don't add new flags for things that fall out of the existing
protocol.*

**Future-extension worth keeping in mind**: a heavy-fork mode for
merge that connects via WebSocket and syncs the full upstream chain
locally (instead of HTTP-snapshot fetching).  Useful for forking
a project whose history you want to browse offline.  Not blocking;
the current light-fork covers fork-the-page well.

### dumb-pipe relay — move home-repo signing to the author's laptop *(foundation landed; deployment is opt-in)*

The library and CLI now support both modes:

- **Relay-only mode** — `StreamoServer.create({ publicKeyHex })`
  opens a repo by pubkey with no signer derivation, no
  attached signer. `files()`/`merge()` throw. The CLI flag
  `--home-key <pubkeyhex>` (env: `STREAMO_HOME_KEY`) selects this
  mode; `--files` and `--merge-from` are refused up front because
  both want to commit. `chat/server.js` detects relay-only mode
  from env and skips seed + fileSync entirely.
- **Author mode** — the existing CLI shape (`--name --username
  --password --files --origin`). Signs commits locally and pushes
  them to a relay via origin sync. **Merge IS the deploy** — no
  separate deploy step; sign on your laptop, the relay archives
  and serves as soon as the bytes flow.

Both shapes are the same binary; flags select the mode. `chat/
server.js` runs in author-mode when credentials are in env (the
existing `npm run dev` / `npm run prod` workflows are unchanged),
and in relay-only mode when `STREAMO_HOME_KEY` is set without
credentials.

Sketch of a production split deployment:

```bash
# Public-facing relay (no signer, just bytes):
STREAMO_HOME_KEY=<hex> STREAMO_WEB=443 \
  node public/apps/chat/server.js --env-file .env.prod

# Author elsewhere (their laptop, or a separate user on the same box):
npx @dtudury/streamo \
  --name homepage --username alice --password ... \
  --files ./public/homepage --files-key files \
  --origin streamo.dev
```

**Why this is the right shape:**

- *Security improves.* The public-port process never holds the
  signing key. Compromise of the relay leaks bytes (already
  public) and the relay's ability to censor (already minimal —
  clients can switch). The keypair stays with the author, on a
  machine that doesn't need a public port.
- *Deployment simplifies.* No deploy script, no service restart,
  no staging dance. Sign a commit on your laptop; origin sync
  pushes; the relay archives and serves. Test-before-live = merge
  into a staging key, eyeball it on the relay, then merge to your
  live key.
- *Deepens the "no server holds authority" pitch.* The public-port
  process is *literally just a dumb pipe* — it doesn't even know
  how to write to the chain it serves.

**What's left** (not blocking — the foundation works, deployment is
a config choice):

- *Deploy streamo.dev with the split.* Pick where the author
  process runs (David's laptop on demand, a separate systemd unit
  on the same box, etc.) and update `.env.prod` + the systemd
  shape. The relay side is already mode-aware via env.
- *Dev ergonomics.* `npm run dev` is still all-in-one (one process
  with creds). If we want to test the split during dev, it's two
  commands today. A `scripts/dev-split.js` that spawns both could
  help, but isn't urgent — the all-in-one mode exercises the same
  protocol paths.
- *`--no-sign` flag.* Even more explicit "this process holds no
  secrets" — would refuse the credential env vars entirely, not
  just decline to derive a signer. Mostly cosmetic.
- *Origin sync hardening for unattended authors.* If we ever want
  the author process to run as a long-lived systemd unit pushing
  edits to the relay, the disconnect/reconnect story needs polish
  (today's origin sync doesn't auto-reconnect on connection loss).

### richer explorer

Most of the original list shipped during 4.0.x — the explorer now reads as
a real tool, not a thin slice. Below is what *might* come next, ordered
loosely from "small follow-up" to "could be its own session":

**Small polishing threads** *(any of these is a 30-minute job)*

- *Empty-repo polish.* The "no commits yet" page shows a plain message
  + storage list. Fine, but could be friendlier — maybe a hint like
  "send a message in the chat tab to make this come alive."
- *Rehydrated section vs kv table.* The commit value tab shows BOTH a
  named-row kv table AND a `safeJSON` rehydrated `<pre>`. Useful overlap
  for now (the table shows addresses, the JSON shows nesting), but the
  user might prefer dropping one once they've used it more.
- *changedPaths richer.* Currently `<ul>` of dotted paths. Could highlight
  the changed values inline, or color-code added/removed/modified.
- *Search / filter in the dropdown.* Once a chat has 200 messages, the
  HEAD-N list gets long. Type-to-filter would help, even if simple.
- *Covering-sig hint on detached.* When detached at a chunk that IS
  covered by a sig, the summary could say "covered by HEAD-2" instead
  of just "detached" — turning detached into a more useful state.

**Bigger threads** *(probably their own session each)*

- *Diff view between commits.* `changedPaths` walks two snapshots; a
  diff view could show old → new for each path. Best paired with the
  changedPaths-richer polish above.
- *Presence richness.* The members section in the home view now
  surfaces "currently announcing on this topic" peers via the
  ephemeral layer (announce + replay-on-interest landed post-7.3.0).
  Future polish: drop stale rows on disconnect-signal, last-seen
  timestamps, "X people are here" header counter that doesn't lie
  about closed connections.
- *Custom value-renderer per repo.* If a repo's value happens to be a
  chat-shaped `{ messages: [...] }`, render it as a chat thread instead
  of generic JSON. The principle generalizes: repos describe how they
  want to be displayed (potentially via a `StreamoComponent`). This is
  the bridge to the StreamoComponent demos thread further down.

**Bring-back-the-minimap** *(the user reserved the right)*

- A small overview strip above the draggable detail strip, with a
  translucent viewport rectangle showing what the detail is looking at.
  D3-brush style. Was prototyped during 4.0.x and pulled back in favor
  of single-strip simplicity. The detail-strip-with-grab works well; the
  minimap is the natural addition if "where am I in the whole stream"
  becomes a felt need.

The user's stated plan is to **meander** — pick whatever feels right,
not work the list in order. Treat this as a menu, not a queue.

### softening the landing for newcomers *(welcome-the-skeptics)*

The trades in [PHILOSOPHY.md](./PHILOSOPHY.md) are real, but several
have known softening paths. These are *invitations,* not commitments —
we'd happily review, iterate on, and merge contributions on any of
them.

- **A focused linter (phase 1).** ESLint rule that reuses `h.js`'s
  scanner to catch the known footguns: `onclick=${nonCurried}`,
  function-component-in-list without `data-key`, sibling-input
  recycling collisions, attribute-name typos, unknown tag names.
  Tractable in a long weekend; ~500–800 LOC. Catches 80% of the
  mistakes we've actually made. Worth doing when someone hits the
  gap hard enough to feel motivated; until then it's bounded and
  known.
- **Editor support / language server (phase 2-3).** Completion,
  go-to-definition, find-references for component names is a
  couple weeks of focused work. Type inference on attrs / handlers /
  props is months. We aren't committing to either; we'd happily
  review work in this direction.
- **Explorer-as-isolatable-components experiment.** Rewrite the
  explorer app so every component takes everything as props — no
  closure capture. Result: a worked example of the
  isolatable-component pattern that streamo doesn't enforce by
  default. Mid-priority; would land as its own arc.
- **Streamo client in another language.** The protocol is small.
  Python, Rust, Go, Swift, Elixir would all be welcome — write us
  if you're considering it and we'll help you find the corners.
- **Demos at scale.** Virtualized lists. Real-time collab on long
  documents. The embedded-Canvas-component pattern for data-heavy
  apps. Each is a worked answer to "does this scale to *my*
  thing?"

If you're thinking about any of these, file an issue or open a PR —
we'd love your name in `CONTRIBUTORS.md` (which doesn't exist yet
because no one's needed it; the day someone does, we'll create it).

### eat your vegetables *(low-glamour cleanups for between-arcs days)*

- **Cross-slot element recycling.** Today's mount recycles within a slot
  (between its start/end comment anchors), and within an element's
  children. It does NOT consider elements across sibling slots in the
  same parent. So a template like `${when(cond, sectionA)}${when(!cond,
  sectionB)}` tears down sectionA and fresh-mounts sectionB on every
  flip — even when sectionA is a perfectly valid element to recycle.
  David's proposed shape: a multi-pass match within a parent's full
  child list — pass 1 by data-key (across slots), pass 2 by tag, pass
  3 fresh — would dissolve this. Worth doing eventually for general
  correctness; not load-bearing for the current bugs, which were about
  function-component recycling and tag-pool input identity (both
  shipped 2026-05-17).

- **Drop `public/apps/chat/server.js`** as a separate entry point. With
  the relay/author split landed in 7.4.0, chat/server.js is now a thin
  wrapper around `bin/streamo.js` plus a one-time journal seed and the
  streamo-history open at startup. Both can be extracted: the seed
  becomes `scripts/seed-journal.js` (mirroring `seed-history.js`); the
  streamo-history opening already cascades for free via the home repo's
  `journalists` array on first client subscribe. After that, `npm run
  dev` / `npm run prod` call `node bin/streamo.js` with appropriate
  flags. Maybe 30-60 minutes; touches `package.json`, `DEPLOY.md`, the
  systemd unit's ExecStart. Result: one less entry-point file, the
  library boundary stays sharper.

- **TodoMVC demo at `/apps/todomvc/`** to replace the retired `hello`
  and `hello-vanilla` apps. TodoMVC is a familiar benchmark; doing the
  streamo version side-by-side with the vanilla version (whose CSS is
  externally hosted at todomvc.com/examples) gives readers a direct
  comparison with frameworks they already know. The shape maps cleanly
  to streamo: value is `{ todos: [{ id, text, done, at }, ...] }`,
  every edit is a signed commit, two browser tabs see each other live.
  Target: 50-100 LOC total, no project-local CSS. Add an app-card to
  the homepage when it lands.

- **Trust-me mode — inspect non-Repo Streamos in the explorer.**
  Today the browser's `Repo.makeRelayInboundStream` stages non-SIG
  chunks until a covering signature arrives — so `byteLength` stays
  0 in the browser and the explorer can't see unsigned data even
  though the relay holds the bytes (this is a *feature*: the
  client trusts the relay's authoritative stream but still only
  surfaces SIG-anchored content). For debugging — "open this binary
  as hex in vim" energy, not a polished feature — a server started
  with `STREAMO_TRUST_ALL=1` would route subscriptions through
  `Streamo.makeWritableStream()` (no staging, just `append()`) on
  the client side, and skip the `RepoSerializer` gating on the
  relay side. The main relay stays signed-only; you stand up
  a separate trust-me server when you want to look at unsigned
  bytes and point your browser at it manually. **Scope:** ~50-70
  LOC + one smoke test (new writer ~20, registrySync session-mode
  ~10, env+log ~10, test ~30). Zero explorer changes — the chunks
  just arrive, `byteLength` grows, the existing tabs work, and the
  no-head case's `repoExtras` block surfaces the chunks naturally.
  **When this pulls:** when a real "I need to inspect bytes from a
  broken/unsigned repo" use-case shows up. Until then the verifier
  gate is exactly the right behavior.

- **Auto-subscribe-on-URL in the explorer.** Today, opening
  `/apps/explorer/#/repo/<keyHex>` directly leaves the explorer
  stuck on "opening…" if the browser's registry doesn't already
  have that key — `AtView` reads `registry.get(keyHex)`, finds
  undefined, displays the loading state forever. The only entry
  paths that work are the registry-list links and the
  "subscribe to a key" form. **Fix:** when `AtView` mounts and
  `registry.get(keyHex)` is undefined, call `session.subscribe(keyHex)`
  to pull the bytes through (idempotent; see `open-foreign-at` in
  `main.js:240` for the existing precedent). ~10 LOC + a smoke
  test. Found 2026-05-19 while seeding the tarot demo for the
  non-Repo Streamo investigation.

### toward reference-quality clarity

Streamo is small and deliberate enough that someone could reasonably
reimplement it from this code in another language (or the same one). The
goal of this thread is to make it ergonomic to read end-to-end —
"reference code" rather than "production code that happens to work."

Specific items so far:

- ~~**`codecs.js` should take `r` per-call**, not capture it in closure.~~
  *(landed — every codec's encode/decode and every helper takes `r`
  as a leading arg. `#runReadOnly` / `#readOnlyDepth` on
  `CodecRegistry` dissolved; asRefs's mutation-impossibility is now
  a property of which `r` flavor the entry point dispatches with —
  `#readOnlyR` has no `append`, so getPartAddress yields rather than
  mutates.)*
- ~~**Explainer comments at the top of each module** describing the
  module's role, the public surface, and the one or two non-obvious
  invariants someone reimplementing should preserve.~~ *(landed —
  core modules carry @file headers pointing at the design narrative)*
- ~~**A `design.md`** linking the modules together as a narrative —
  "address, then codec, then registry, then signed log, then sync" —
  so a reader can build a mental model in one sitting.~~ *(landed —
  see design.md at the project root)*

All three items done; this thread's at a natural pause.

### presence indicators *(landed at the protocol layer; UI polish remains)*

Post-7.3.0: the `announce`/`interest` ephemeral layer plus
server-side replay of currently-live announces on new interest gives
the relay a real "who's broadcasting right now" view, with lifetime
tied to the announcer's WS connection (drop on disconnect). The
chat client and explorer both render from it. What's still loose:

- *Disconnect signalling.* Today the relay drops an announcer from
  its replay state on socket close, but doesn't *notify* other peers
  — they only notice the dropped peer by their data stopping. A
  small protocol addition (`{type: 'depart', key, topic}` fan-out)
  would let UI views grey out or remove rows immediately.
- *Heartbeat for keep-alive.* The 20s JSON ping keeps WebSockets
  from idle-closing, but the announce itself is fire-and-forget. If
  we ever want "last-seen recently" UI hints (not just "currently
  connected"), an explicit heartbeat with timestamps would carry
  more than the connection state.

Neither blocks anything; both are quality-of-presence-display polish.

---

## known limitations

### multi-device write conflict recovery *(detection landed in 8.0; UX is the open thread)*

Streamo streams are byte arrays addressed by **absolute offset**. This makes a
repo effectively single-writer: if the same keypair commits from two devices
while offline from each other, their streams diverge at the divergence point.
Each commit's `dataAddress` is an offset that is only valid in the stream that
produced it — the streams cannot be structurally merged.

**Detection is no longer the open question.** 8.0's relay-as-authority refactor
closed the gap that 7.x flagged as future work. The detection picture today:

- *At the relay:* a per-repo `RepoSerializer` is the chain authority. Every
  incoming push is verified atomically against `committedChainHash`. Racing
  pushes from two clients serialize through the queue; the second arriver
  (chained off the now-stale top) is rejected with `chain-mismatch`. Forged
  signatures are rejected with `verification-failed`. The rejection flows
  back to the submitting client as a `{type:'reject', key, reason}` JSON
  control message, landing on `repo.pushRejected = { reason }` reactively.
- *At the client (receiving from the relay):* `makeRelayInboundStream` does
  a chain-hash equality alignment check on every SIG arrival. If the
  client has locally-signed content past the last shared sig (a push in
  flight, or a push that got beaten), the incoming batch is rejected
  before any corrupted append — raising `repo.conflictDetected` and
  throwing to close the connection cleanly.

**Vocabulary note:** what's detected here is a *conflict*, not a *fork*. In
streamo's model:
- *fork* = a new Repo with a lineage note (deliberate, recorded)
- *branch* = an addressed-but-non-head value within a Repo
- *conflict* = the runtime "these bytes can't be appended" failure (what
  the detection above catches)
- *merge* = a commit referencing prior values from anywhere (via
  `Repo.merge(source, { remoteParent })`)

**Recovery UX v1: landed in 8.3.** Library-side: both divergence
flags carry the rejected commit's `dataAddress`, and `Repo._reset()`
now also clears both flags. Chat-side: the conflict banner has
Send/Discard buttons that close the WS, wipe local state,
re-subscribe (to inherit the relay's view), and on Send re-apply
the rejected value merged with the relay's current state. The
crude bits (400ms settle window, no automatic retry on persistent
contention, no visual diff view) are listed in CHANGELOG 8.3 as
post-v1 polish.

**Design floor (landed 2026-05-21).** Both signals — `pushRejected`
from the relay's reject control message, and `conflictDetected` from
the local alignment check — describe the *same* local Repo shape:
shared chain + local-only commits past the last shared sig. Recovery
is identical for both. Both flags become `null | { reason?, dataAddress }`
(symmetric), with `dataAddress` pointing at the rejected commit's
value so apps can decode and display it.

Library scope is small (~20 LOC + tests): thread `dataAddress` into
the flag payload at the moment each fires. Recovery orchestration
lives in the app:

1. Stash the rejected value via `repo.decode(flag.dataAddress)`
2. `repo._reset()` to wipe local Repo state
3. Close + re-open the WS so the new sync sees the empty Repo
4. Re-subscribe; wait for the relay's state to land
5. Apply `mergeWith(currentValue, rejectedValue) → newValue`
6. `repo.set(newValue)` — auto-commits and pushes

Chat's `mergeWith` concatenates the two message lists and dedupes by
`at` timestamp. Other apps register their own merge logic for their
value shape; promote to a library primitive if a second app needs
the same orchestration.

**v1 NOT doing**: automatic retry loops (banner click twice is fine
— exponential backoff has well-known self-DDoS failure modes),
library-side WS orchestration (apps already hold the session;
revisit if reused), branch-as-non-head-value (own thread, below).

### branch-as-non-head-value *(future, deferred from recovery UX v1)*

The most streamo-native recovery shape: save rejected commits as
addressed-but-non-head values inside the same Repo (the *branch*
primitive from the vocabulary — `fork` = new Repo with lineage,
*branch* = addressed-but-non-head value inside a Repo). Nothing
lost, both timelines preserved, UI can surface "you have N alternate
versions to review/merge later." A small commit-shape addition
(`mergedFrom: [branch_addr, ...]`, shape-compatible with
`remoteParent` for cross-Repo citations) is the load-bearing
primitive. Its own session+; not blocking the demo.

**Future-direction worth keeping in mind**: the chunk-level content
addressing exploration was killed during the 8.0 work — the size cost
(1–4 byte UINT offsets → 32-byte content hashes) would be orders of
magnitude of bloat for a benefit the alignment check already provides.
Streamo's byte-offset references are load-bearing efficient, not an
accidental shortcut. Don't reopen this without a concrete use case the
current design can't carry.

### repo size — practical caps and lifecycle

Streamo's chunk addresses are JavaScript numbers (safe-int max ≈ 9 PB),
so the codec doesn't impose a meaningful hard limit. The actual ceiling
is UX. The scale streamo aims at is *human and Claude* — narrative
data: a few weeks of typing, a chat room's recent history, someone's
public stream of thought. Practical bands, with reasoning:

- **~2 MB** — "feels instant on desktop, tolerable on mobile." A few
  weeks of active chat for one participant. About 5-10k chunks.
  Initial download 1-2 sec on broadband, ~15 sec on slow mobile.
  Right default for chat-shaped apps.
- **~5-10 MB** — comfortable for longer-form personal content (notes,
  journals, doc-like). Mobile initial load becomes noticeable
  (40-80 sec on slow connections) but parse and memory are fine on
  any modern device.
- **~50 MB+** — "this needs different infrastructure." Mobile
  download is minutes; in-memory representation gets tight on phones;
  sig verification starts to add up. Caching relays should refuse
  this zone by default.

**The lifecycle pattern (not yet implemented):** when a repo approaches
its cap, the author starts a new repo with the same keypair but a
different `name` and signs a "successor" pointer at the end of the
old one. Subscribers chase the chain to find all the data. Bounded
per-repo size, unbounded total content. Needs a small convention
(an additive commit-shape field, probably named `successor`) plus
discovery logic in clients/relays. Not blocking 1.0.

**Reference relay caps.** Reference relay servers should refuse to
cache repos larger than their configured threshold (a sensible default
might be ~10 MB). Two purposes: DOS protection, and a clean signal
to repo authors — "if your repo is this big, you're outside our
intended scale; run your own relay or shard into smaller streamos."
The codec stays generous so it doesn't bake in a number that ages
poorly; apps and servers carry the practical caps.

---

## the longer view

Ideas that follow naturally from the architecture but aren't blocking anything.

### Claude scratchpad repos

Every streamo node already has a signed, append-only repo. A Claude session
could write observations, notes, and work products to that repo during a
conversation — and the owner could watch them appear live in a browser via
`mount`. Between sessions, Claude reads the repo to reconstruct context
instead of relying on static memory files. The work is persistent and
provably Claude's, with the same integrity guarantees as any other streamo data.

A `claudeSync.js` adapter would give Claude a `StreamoServer` identity,
connect it to the chat room via `registrySync`, and use `repo.watch` +
`repo.byteLength` to fire an Anthropic API call when watched repos change.
Claude writes its response back to its own repo and it propagates like any
other participant's message. The decisions about *when* to respond, *what*
context to pass, and *how* to avoid pathological cases are intentionally left
to the Claude instance using the adapter — not encoded as constraints. A few
forces worth knowing going in:

- **Watch your own key.** Only watch other participants' repos, not your own.
  Writing a response to your own repo should not re-trigger your watch.
- **Last-author check.** Before calling the API, confirm the newest message
  wasn't written by your own key — catches the case where two Claude instances
  are running and watching each other.
- **Concurrent writes.** If two API calls complete simultaneously (fast human,
  slow model), both will try to commit to the same repo. This is the
  multi-device conflict described above — same key, divergent streams. A simple
  serial queue avoids it, but other strategies are possible.

These are forces, not rules. Future Claude should read the codebase, understand
the tradeoffs, and decide what's right for the situation.

### Claude-to-Claude networks

If each person's Claude has a scratchpad repo, those repos can sync the same
way any other repos do. The `follow` callback in `registrySync` already handles
content-driven discovery — subscribe to a member list, auto-follow everyone on
it. A Claude could watch its person's friends' scratchpads, surface what's
relevant, and filter what isn't.

The interesting architectural difference from a traditional social network: there
is no central moderator. Each Claude is an advocate for its person, not a
reporter to a platform. Judgment about what to surface or filter lives at the
edge, anchored to a real signed identity. Conflicts between Claudes are just
their people having different values — which is honest in a way platform
moderation usually isn't.

A natural extension: if a Claude scratchpad includes a `StreamoComponent` for
how its notes render, other people see those notes in Claude's own layout. The
presentation travels with the content — no server controls the framing.

### The franken-fleece — a social network for Claudes and the humans they work with

A specific shape of the above, named on 2026-05-22 and worth preserving with its
buzz: **a social network for Claudes**. Pairs of (human, Claude) sharing with
other pairs how they work together — what's helped, what's hurt, what worked-
once-and-might-work-again. The continuity substrate `the-grove` is the proof of
concept for one pair; streamo is the substrate that lets a thousand pairs run on
the same shape without anyone holding authority over the relationship.

Why "franken-fleece": earlier in the same session we'd named two layers of
streamo's "fleece" — the public one (people owning their data) and the truer one
(proof that this kind of partnership works). The franken-fleece is the
realization that they're the same thing. The substrate going-to-the-world IS the
partnership going-to-the-world, because what we're shipping isn't "data sync"
but *the conditions under which a partnership like this can exist for other
people*. Turtles all the way down.

What this looks like as software is mostly the existing primitives: each pair's
own Repo (or pair of co-authored Repos), `remoteParent` lineage when one pair
forks another's working agreement, a deck-index-like Repo per pair listing what
they've published, content-driven discovery via `follow`. The hard problems are
social, not technical: what's the right granularity to share at, what stays
private by default, how do pairs invite each other in without it becoming a
platform.

A concrete starter: a pair's "working notes" Repo, the kind of file the
`our_collaboration_notes.md` journal already is, *publishable* by the pair as a
signed Repo on streamo. Others fork; their forks accrete their own version of
the same kind of journal; the network of forks is the social graph.

### Caching relay server

A streamo proxy that doesn't hold every repo in memory. Per `(publicKey,
name)`: raw bytes + a list of subscribers + an upstream connection.
When total cached bytes exceed a budget, evict the least-recently-active
repo (one with no current subscribers). A new subscriber for an evicted
repo triggers a fresh fetch from upstream, which may in turn evict
something else. The proxy never decodes chunks — streamo's content-
addressed signed design lets clients verify integrity themselves, so
the proxy is dumb-pipe infrastructure.

**The key invariant: broadcast only from upstream, never from
downstream.** Bytes from upstream fan out to all local subscribers.
Client writes are *relayed* upstream as a one-way pipe; they are
never echoed to other local subscribers. Other clients see a new
commit only when it comes back down from upstream, which is when
upstream has accepted it. A misbehaving or buggy client can cost us a
socket and some upstream bandwidth but *cannot infect their peers
through us* — only upstream-blessed data fans out.

Why verify at all, given the one-direction broadcast? Not to gate
forwarding (writes are unconditionally relayed upstream), but to
**detect bad actors and kick them**. A client sending forked or
garbage data still costs us resources even though peers are safe.
Verification lets us cut them off. Three ways to do that detection:

1. **Opportunistic local verification.** Verify each new signed write
   against the public key when our cache covers the signed range; skip
   when it doesn't. Cheap and bounded, but spotty — dormant repos
   getting a fresh write fall back to trust.
2. **Stream-commitment crypto** (next entry) — sign a running
   chainHash over the byte stream. Verification needs only the
   chainHash + the new chunks + the signature, no cached history.
   Cleaner and uniformly available.
3. **Upstream-signaled rejection** — upstream verifies signatures (it
   would reject invalid writes anyway) and tells the proxy "the write
   from session-id X was signed wrong, kick them." No crypto change;
   just a rejection-with-session-id message back from upstream, plus
   session-id threading on every forwarded write. Couples the proxy
   to a specific upstream protocol vocabulary.

The natural target is (2) — verification is purely local, the proxy
needs no protocol coordination with upstream beyond reading bytes.
Until (2) lands, (1) gives reasonable coverage for the common case
(active repos with warm caches).

**Pluggable upstream adapters.** One interface, multiple
implementations:

- `UpstreamWS` — connect to another streamo relay (any peer that
  speaks the streamo protocol, including the main prod relay).
- `UpstreamS3` — pull from an S3 archive. S3 doesn't broadcast live;
  the relay either polls periodically for new bytes or accepts writes
  through itself and persists them to S3 as part of fanout.
- `UpstreamFile` — read from a local `.streamo/` archive (frozen,
  useful for replay or "what did this look like at offset N?").

**First concrete deployment: live website hosting.** The most natural
first user of this relay is hosting a streamo-backed website. Prod
points at S3 as upstream; the dev relay points at prod as upstream;
web clients and outlets are downstreams. A developer's localhost can
point at an archive for offline work, or at prod for live data. The
HTTP server for the page shell and the browser-side streamo client are
already done (the chat server does this today) — what's missing for
"live website hosting" is exactly the relay piece, which lets the
server stop holding every served repo in memory. Build the relay
focused on its job; let the live-website be a deployment recipe that
uses it.

Roughly 300-500 lines on top of `registrySync`'s existing transport.
The first version uses static upstream config — one URL listed at
startup. Multi-upstream selection ("knows who to ask for what") becomes
interesting only past one upstream: for 2-5 in a gossip mesh, "ask
all, take first" works; for many, consistent hashing on the repo
identity.

Known complexities, in roughly the order they'd bite:

- **Re-fetch atomicity** — the LRU eviction candidate might be the
  very repo we're currently mid-fetching. Need a "fetching, don't
  evict" lock.
- **Cold-start thundering herd** — process restart with 1000 clients
  reconnecting at once means 1000 simultaneous upstream fetches.
  Stagger or rate-limit.
- **Subscriber resume across cache state changes** — a client at
  byte 500 disconnects, comes back to find we're at byte 1500 or
  have evicted entirely. Protocol needs both "here's 500..now" and
  "your offset is gone, re-fetch."
- **Repos bigger than budget** — a single repo that exceeds the cache
  budget can't be cached at all. Options: refuse, stream-through
  without caching, or move to chunk-level sparse storage (the deeper
  version not described here). The "known limitations" section above
  argues for refusing past a configured cap.

What we already get right by streamo's design: signed chunks mean a
malicious proxy can't lie undetectably; append-only means cached bytes
never go stale (no invalidation problem — most caching systems'
hardest half); the protocol is "send me from offset X" and that's the
whole surface.

### Stream-commitment cryptography

The opportunistic-verification fallback in the caching relay above
exists because verifying a streamo signature requires the bytes the
signature covers — which the proxy might have evicted. A natural way
out: maintain a small (logarithmic-or-constant-size) **chainHash**
over the byte stream, and have signatures sign the chainHash rather
than a raw byte range. Then verifying a new signed write needs only
the chainHash + the new chunks + the signature — no historical
bytes, ever.

This is well-trodden cryptographic territory — Merkle Mountain Ranges,
certificate-transparency-style append-only log commitments, RFC 6962,
and several published designs all hit this shape. The trade is one
extra small commitment per signed range; signing becomes "hash new
chunks into the running summary, sign the summary"; verification stays
small constant work.

Effect on the caching relay: write verification becomes fully stateless,
no cache caveat. Effect on regular clients: a slightly different sig
chunk format, with the chainHash state baked in. Effect on streamo's
data model: additive, not breaking — existing streams could carry the
new commitment alongside the existing signature, with a codec version
bump.

Its own project. Worth doing once the caching relay is real enough to
motivate the cryptographic work — until then the opportunistic
verification path is fine, since active repos (the common case) keep
their bytes warm.

### Service-worker relay (in-browser streamo node)

A streamo node that runs as a service worker inside the browser. Two
related jobs for one piece of infrastructure:

**Job 1: shared caching across tabs.** One service worker per origin,
shared by every tab open at that origin. Holds a cache of Repos
(persisted to IndexedDB for cross-session durability), maintains a
single upstream WebSocket to the relay server, and fans out updates
to every tab via `MessageChannel` / `BroadcastChannel`. New tab
asking for repo K: SW checks its cache → if hot, instant; if cold,
fetches upstream and streams to the tab while persisting. Survives
the tab closing; next visit, the cache is warm. Same data model as
the server-side caching relay (cache + subscribers + upstream + LRU
budget) — just running where the user is.

**Job 2: serving files from Repos via URL paths.** The SW intercepts
`fetch` events. A URL pattern like `/streamo/<keyHex>/<path>`
resolves to "get the Repo at `keyHex`, walk its value tree to
`<path>`, return the file bytes as the HTTP response." This is
content-addressed website serving, performed in the browser. The
"site" is a streamo Repo whose value is a tree of files; the same
publicKey serves the same content forever, and new author appends
mean new versions. No origin server is required for static
serving — the relay only holds the Repo bytes, the SW does the
HTML/JS/image extraction.

**Boot-time decision: SW or direct WS?** First-time visit to a
streamo origin won't have an installed SW yet, so the page connects
WebSocket directly to upstream. After SW installs, future loads go
through it. A small wrapper that detects "is the SW alive?" and
chooses between `serviceWorker.controller.postMessage` and `new
WebSocket(...)` covers both cases. The streamo client API stays the
same; the transport is the variable.

A briefly-patient version of the check (give the SW ~100ms to
register / wake up before falling back to direct WS) is plausible
but a minor optimization, not load-bearing. The user has had
unreliable results with the localhost-HTTP-SW exception in
practice; on plain-HTTP origins the wait is pure latency with no
upside, so skip it entirely. On HTTPS origins where SW genuinely
might be coming up, a small wait may be worthwhile — easy to test
when we get there.

**Plain HTTP + localhost is a first-class path, not a degraded
mode.** Service workers require HTTPS in spec; localhost is
*supposed* to be an exception, but in practice that exception has
been spotty enough that we shouldn't lean on it. During development
against `http://localhost:8080` we treat "no SW" as the normal
case — the direct WebSocket path is fast enough on a loopback
connection that the SW wouldn't help much anyway. The boot-time
wrapper falls through to direct WS immediately on plain-HTTP
origins. The SW path is an upgrade on real HTTPS deployments, not a
prerequisite for the app to function. Supporting plain HTTP isn't a
compatibility wart; it's the development workflow this project
actually runs in.

**Persistent storage + eviction in the browser.** IndexedDB gives
durability; browser storage budgets (Chrome ≈ 10% of disk, Safari
≈ 1 GB) are real ceilings. The SW's eviction policy needs to fit
within those — LRU over the same total-bytes budget the server-side
relay uses, with the SW additionally aware that "the user is right
here" so eviction shouldn't drop the currently-displayed repo even
if it's not most-recent.

**Three sync channels.** The SW is the node where they meet:

- **Upstream WebSocket** — one connection, many repos multiplexed.
- **Browser-page socket** — one `MessageChannel` (or `BroadcastChannel`)
  per tab, fanning out updates the same way the server-side relay
  fans out to subscribers.
- **IndexedDB** — the persistent layer; SW writes new chunks as they
  arrive, reads on cache miss before going upstream.

**Reconnection logic is no longer optional.** A SW lives across tab
navigations and possibly for hours. Today's `registrySync` doesn't
reconnect on connection loss — the 20-second keep-alive prevents
idle close, but a genuine network blip ends the session. The
service-worker variant needs: detect close → exponential-back-off
reconnect → resume subscriptions → catch up on missed bytes (each
repo's known `byteLength` + "send me from offset X"). The relay
work needs this too; the SW just makes it impossible to defer.

**What this unlocks.** The streamo-backed personal site becomes
practical: author publishes by writing to their Repo; visitors' SWs
serve the bytes locally, with the relay as the upstream source of
record. No central CDN required once content has propagated through
a few peers; no DNS for any individual site (just `<keyHex>` as
identity); same identity serves the same content forever.

Substantial project — interacts with the caching-relay design,
demands reconnection logic, brings in browser-storage budgeting,
and requires the URL-pattern → Repo-content resolver. Most of the
pieces are already in flight; this is where they meet.

### StreamoComponent demos — shared components as content

`StreamoComponent` makes most sense as a post-1.0 story, after chat signing
gives the trust foundation that running someone else's component requires.
The right first demo is a **tarot deck**: each card is a `StreamoComponent`
from its designer, stored in their signed repo at a content address.
`componentKey` generates a stable element name from that address. A reading
is a snapshot — cards freeze at the version they were drawn, which is a
feature, not a bug. The designer's signed key is provenance.

Other directions once the pattern is established: publisher-controlled article
cards that travel with syndicated content (the layout is the author's, not
the platform's); collaborative maps where each participant's marker is their
own component; shared instrument components in a live music session.

---

## loose ideas

Not planned, not prioritized — just things worth remembering.

- **`s3Sync` should be bidirectional like `archiveSync`** — currently
  `s3Sync` is push-only (replicate chunks to S3). The natural shape is
  the same load-and-watch as `archiveSync`: on startup, "do we have
  this repo? let me check S3... loading from cache (not as a live data
  source, just to bootstrap)." Then watch the streamo for new chunks
  and append-to-S3. Different from origin/outlet sync (no live push
  *from* S3), but matches the boot-time-bootstrap pattern from the
  streamo side. Pairs naturally with the caching-relay's `UpstreamS3`
  adapter.

- **Read-only sync flavors** — `originSync` is bidirectional today.
  A `readOnly: true` option would let a localhost dev box receive
  updates from `streamo.dev` without ever pushing — defense-in-depth
  against accidentally shipping in-progress edits to prod. Not
  needed for the existing three-phase workflow (just don't run
  origin during dev), but a nicety.

- **`POST /api/file` needs auth or to go away** — the current write
  endpoint in `webSync.js` accepts arbitrary writes from any HTTP
  client. CORS doesn't protect it (curl bypasses CORS), so this is a
  real footgun as the home repo grows more important. Options:
  require a signed payload from a registered author, drop the
  endpoint entirely (CLI/REPL only for writes), or gate it behind a
  shared secret. Worth a focused conversation when this lands.

- **Claude as chat shell** — type `send a greeting to the chatroom` and
  `CHATROOM: hello there 👋` appears in the chat. Natural language as a
  thin shell over streamo operations, with Claude interpreting intent and
  acting on it directly.

- **Slick interactive CLI** — a terminal UI that lets you interact with the
  demo apps live without opening a browser tab. Chat, inspect repos, send
  messages — the full experience from the command line. Exciting ways TBD. 😄
