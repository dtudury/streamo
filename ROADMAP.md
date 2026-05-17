# streamo roadmap

Future-focused — what we're aiming at next and what's beyond the horizon.
Release-by-release history is in [CHANGELOG.md](./CHANGELOG.md).

---

## current state

Streamo is at 7.1.0, published to npm as `@dtudury/streamo`, and
live on streamo.dev as the canonical reference deployment. 7.1 —
**Page-as-Repo** — closes the loop on streamo's main pitch by making
the relay's homepage itself a signed streamo: bytes served from the
home repo's `files` key, edits flow through `fileSync` as signed
commits, and a new optional `remoteParent` field on commits makes
forks first-class with cryptographic citations. The project's git
log is now itself replayable as a streamo (`scripts/seed-history.js`
produces a `streamo-history` repo whose commit chain mirrors git
first-parent history); the explorer's journalists section surfaces
its 231 historical commits as clickable cards. Any user can produce
their own signed pure-copy fork of the homepage with one command
(`npm run fork-homepage`); [`FIRST_STEPS.md`](./FIRST_STEPS.md) is
the walkthrough. Underneath, 7.0 Obsecurity registry hygiene and
6.0 hash-chain accumulator are unchanged. The all-in-one server
(`npm run dev` / `npm run prod`) hosts the homepage, chat, explorer,
and the live history repo on one port. 159 tests passing.

See [CHANGELOG.md](./CHANGELOG.md) for the detailed history of how we got
here.

---

## what's next

### explorer value-view performance *(the next active thread)*

Now that the `streamo-history` repo is loaded by `npm run dev`, the
explorer is the first place the value tab encounters genuinely big
data: 231 commits, each with a `{ sha, tree, parents, author, body }`
value plus the commit-record envelope around it. Opening a commit
feels slow. Reported 2026-05-16.

Likely culprits, in rough order of suspected weight:

- The `safeJSON` rehydrated `<pre>` stringifies the *whole* decoded
  value on every render, even when most of it isn't visible.
- The kv-table walk descends the full tree eagerly at render time.
- The HEAD-N commit dropdown lists every commit (no virtualization,
  no filter); the list keeps growing with chain length.
- Slot re-renders may be wider than needed (a hover near the strip
  shouldn't trigger a value-tab re-render).

Goals for this thread: open a commit feels instant; deep nesting
expands on click rather than rendering eagerly; the dropdown stays
usable at 200+ commits. Probably touches `at-view.js`, `render.js`,
and the typed-value composite renderers from the
streamo-typed-value-displays thread in `THREADS.md`.

### merge as a primitive *(landed 2026-05-17, six nibbles, awaiting publish)*

`Repo.merge(source, options)` — incorporate a slice of another
repo's value into this one as a single signed commit with
`remoteParent` cited. Two source shapes: in-memory `Repo`
instance, or string URL (`http(s)://host[:port]/streams/<keyHex>`
or `host[:port]` shorthand via `/api/info`). One policy
implemented: `'replace'` (Mode A — source slice replaces target
slice). Three more reserved (`'theirs'`, `'ours'`, `'throw'`) for
attribute-walk semantics when real workloads drive their
defaults.

CLI: `--merge-from <url>` flag on `bin/streamo.js` runs the merge
*only when the local repo is empty* (idempotent on re-run), so
the all-`npx` first-user flow is one command:

```bash
npx @dtudury/streamo \
  --name homepage --username alice \
  --merge-from streamo.dev --merge-from-key files \
  --files ./mysite --files-key files \
  --web 8081
```

FIRST_STEPS.md is now anchored on this command. `scripts/fork-homepage.js`
stays as a worked scripting example. The `--interactive` REPL
exposes `merge` as a shorthand for `streamo.merge`. Password
prompt simplified to single-entry hidden (the double-prompt
"confirm" was security-theater for the deterministic key model).

173 tests passing (12 new in `Repo.test.js`, 2 new in
`smoke.test.js`).

### publish-to — completing the round-trip *(next active thread)*

Today's all-`npx` flow does a one-way *pull*: HTTP fetch the
upstream snapshot, commit a pure-copy locally, serve at
`localhost:8081`. To make the user's fork visible at
`streamo.dev/streams/<their-key>`, the user's bytes need to flow
*up* to streamo.dev — WebSocket sync plus an `announce` against
the relay's home topic. The CLI's `--origin` flag does the
connect but doesn't announce; the manual REPL incantation would
be `session.announce(publicKeyHex, homeKey)` after a connect.

The natural next flag is `--publish-to <host>`: opens a WebSocket
to the host, fetches `hello.home` (the relay's home topic),
announces the local pubkey against that topic, and continues. The
relay's existing `onAnnounce` callback (already in
`chat/server.js` for the chat-member flow) adds the new key to
`members`, subscribes back to it, and the user's bytes start
flowing up.

Once landed, the all-`npx` *publish* flow becomes:

```bash
npx @dtudury/streamo \
  --name homepage --username alice \
  --merge-from streamo.dev --merge-from-key files \
  --publish-to streamo.dev \
  --files ./mysite --files-key files \
  --web 8081
```

And FIRST_STEPS gets a fifth step: *"visit
https://streamo.dev/streams/&lt;your-key&gt; — your fork lives on the
public relay now."* This completes the fork→edit→serve→publish
loop the page-as-Repo arc has been building toward. ~1-2 hr scope,
similar shape to the merge nibbles.

**Future-extension worth keeping in mind**: a heavy-fork mode for
merge that connects via WebSocket and syncs the full upstream chain
locally (instead of HTTP-snapshot fetching). Useful for forking a
project whose history you want to browse offline. Not blocking; the
current light-fork covers fork-the-page well.

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
- *Member visualization.* Walk a repo's `members` array, show each as
  a clickable card linking to their repo. Adds a graph-y dimension to
  the registry list.
- *Presence layer.* Mentioned in its own section below — surfacing
  "alice is here right now" via the `interest`/`announce` ephemeral
  layer. The infrastructure is there; the UI isn't.
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

### presence indicators

Who's currently online? The WS-level keep-alive (20s JSON ping in
`registrySync`) keeps connections from idle-closing, but doesn't surface
"alice is here" anywhere in the UI. Presence proper would announce
periodically via `interest`/`announce` and time out peers we haven't heard
from. Ephemeral by design — not stored in any Repo.

---

## known limitations

### multi-device write conflict detection

Streamo streams are byte arrays addressed by **absolute offset**. This makes a
repo effectively single-writer: if the same keypair commits from two devices
while offline from each other, their streams diverge at the fork point.  Each
commit's `dataAddress` is an offset that is only valid in the stream that
produced it — the streams cannot be structurally merged.

When the two devices reconnect, `makeVerifiedWritableStream` deduplicates shared
chunks by content (correctly) but silently appends the conflicting commit from
the second device at its new offset.  That commit's `dataAddress` now points to
the wrong location in the merged stream.  No error is thrown; the second
writer's data is silently corrupt.

**What is safe today:** relays never call `commit()` so they are unaffected —
they accumulate and re-serve bytes without introducing their own addresses.  The
chat app is also unaffected because each user writes to their own repo from a
single session.  The danger zone is one keypair writing from two places
simultaneously (two browser tabs, phone + laptop while offline).

**The fix** requires either (a) detecting the fork and throwing a clear error so
the user can choose which version to keep, or (b) switching to chunk-level
content addressing (à la git objects) so streams can be merged structurally
rather than by concatenation.  Option (a) is a targeted addition to the sync
layer; option (b) is an architectural change.  Not required for 1.0 but should
be resolved before marketing streamo as a general-purpose multi-device sync
library.

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
   accumulator over the byte stream. Verification needs only the
   accumulator + the new chunks + the signature, no cached history.
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
out: maintain a small (logarithmic-or-constant-size) **accumulator**
over the byte stream, and have signatures sign the accumulator rather
than a raw byte range. Then verifying a new signed write needs only
the accumulator + the new chunks + the signature — no historical
bytes, ever.

This is well-trodden cryptographic territory — Merkle Mountain Ranges,
certificate-transparency-style append-only log commitments, RFC 6962,
and several published designs all hit this shape. The trade is one
extra small commitment per signed range; signing becomes "hash new
chunks into the running summary, sign the summary"; verification stays
small constant work.

Effect on the caching relay: write verification becomes fully stateless,
no cache caveat. Effect on regular clients: a slightly different sig
chunk format, with the accumulator state baked in. Effect on streamo's
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
