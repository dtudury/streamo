# streamo roadmap

This is a living document — updated with every meaningful change to give a clear
picture of where the project is and where it's headed.

---

## where we are (2.0.0)

2.0.0 is a surface and correctness pass on top of 1.0:

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

Below is the underlying capability surface (unchanged in 2.0.0):

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
- `npm run serve` — starts a streamo node (with REPL) using `.env.dev`
  credentials. The dev server is a real peer, not a bare static file server.

---

## what's next

### richer explorer
The explorer (`public/apps/explorer/`) shipped as a thin slice — registry →
repo → commit history → value-at-commit. Polish from here:
- show signature chunks as their own commit-list entries (currently they're
  invisible — `valueAddress` skips past them)
- highlight changed paths between a commit and its parent (`changedPaths` is
  already exported)
- collapsible JSON tree for the value view (raw `JSON.stringify` is fine for
  small repos; falls over on big arrays)

### presence indicators
Who's currently online? The WS-level keep-alive (20s JSON ping in
`registrySync`) keeps connections from idle-closing, but doesn't surface
"alice is here" anywhere in the UI. Presence proper would announce
periodically via `interest`/`announce` and time out peers we haven't heard
from. Ephemeral by design — not stored in any Repo.

---

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

---

## beyond 1.0

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

- **Claude as chat shell** — type `send a greeting to the chatroom` and
  `CHATROOM: hello there 👋` appears in the chat. Natural language as a
  thin shell over streamo operations, with Claude interpreting intent and
  acting on it directly.

- **Slick interactive CLI** — a terminal UI that lets you interact with the
  demo apps live without opening a browser tab. Chat, inspect repos, send
  messages — the full experience from the command line. Exciting ways TBD. 😄
