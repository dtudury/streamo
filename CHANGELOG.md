# streamo changelog

Release-by-release history, newest first. See [ROADMAP.md](./ROADMAP.md)
for what's next.

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
