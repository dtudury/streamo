# streamo roadmap

This is a living document — updated with every meaningful change to give a clear
picture of where the project is and where it's headed.

---

## where we are (4.0.0)

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

## where we are (3.1.0)

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

## where we are (3.0.0)

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

## where we are (2.0.0)

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

### toward reference-quality clarity

Streamo is small and deliberate enough that someone could reasonably
reimplement it from this code in another language (or the same one). The
goal of this thread is to make it ergonomic to read end-to-end —
"reference code" rather than "production code that happens to work."

Specific items so far:

- **`codecs.js` should take `r` per-call**, not capture it in closure.
  Right now codec helpers (`inlineOrAddressPart`, `decodeParts`,
  `getPartAddress`, etc.) reference an `r` object that's bound at
  registry-construction time. To make `asRefs` mutation-impossible we
  introduced a `#runReadOnly` scope on `CodecRegistry` that flips
  `r.readOnly`; while contained and clean, it's a one-off pattern in
  the codebase. The structurally-pretty version is: codecs take `r` as
  a function arg per call, so the read path can pass an `r` literally
  without `append` and the write path can pass one with append. Bigger
  refactor — every codec's encode/decode signature changes — but
  worthwhile when this thread is a priority.
- **Explainer comments at the top of each module** describing the
  module's role, the public surface, and the one or two non-obvious
  invariants someone reimplementing should preserve.
- **A `design.md`** linking the modules together as a narrative —
  "address, then codec, then registry, then signed log, then sync" —
  so a reader can build a mental model in one sitting.

These don't all need to land together; treat as a checklist.

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
