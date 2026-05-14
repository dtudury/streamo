# streamo design

A walking tour of how the library fits together — meant to be read top
to bottom in one sitting. Each layer adds one idea on top of the previous
one. By the end you should be able to reimplement streamo in another
language without having to reverse-engineer the source.

The shape, in one sentence:

> An append-only byte store, addressed by content; with a codec system
> that maps any JS value to a unique byte sequence; with a reactive
> getter/setter on top; with a signed commit log on top of that; with
> WebSocket sync on top of that; with a small reactive UI layer for
> apps that want to render data live.

The rest of this document expands each clause.

---

## 1. `Addressifier` — the byte-level foundation

> File: `public/streamo/Addressifier.js`

`Addressifier` is an append-only sequence of `Uint8Array` chunks. Each
appended chunk gets an **address**: the byte index of its **last byte**
(not its first). Addresses are sequential — chunk N+1 starts at chunk N's
end + 1.

Two operations exist that aren't append:

- `addressOf(code)` — given the bytes, returns the address they live at,
  or `undefined`. Backed by a `ContentMap` (bytes → address).
- `resolve(address)` — given an address, returns the chunk's bytes.

This is enough to make the store **content-addressed**: append the same
bytes twice, and `addressOf` will return the same address (the second
append is a no-op at higher layers because we check `addressOf` first).
The same value, encoded the same way, lands at the same address — so
deduplication is automatic and structural comparison can be done by
comparing addresses.

The store also exposes `makeReadableStream` / `makeWritableStream` for
sync. The wire format is just `[4-byte LE length][chunk bytes]`,
repeated.

There is no concept of "type" at this layer. It's just bytes.

## 2. `ContentMap` — the bytes → address lookup

> File: `public/streamo/ContentMap.js`

A small structure that supports putting `Uint8Array → number` mappings
keyed by the bytes themselves. Implemented as a tree of byte buckets so
lookups don't require an O(n) scan.

Internal detail; you only see it through `Addressifier.addressOf`.

## 3. `codecs.js` — the type system

> File: `public/streamo/codecs.js`

Each chunk's **last byte** is its **footer**, and the footer determines
the codec. Codecs are registered in a fixed order (UNDEFINED first, then
NULL, FALSE, TRUE, UINT7's 128 values, WORD, UINT8ARRAY, …) so each
codec ends up owning a specific footer range.

Most codecs have **parts**. A part is one of:

- **inline-or-address** — a value that's either embedded literally in
  this chunk's bytes (option 0) or stored as a separate chunk and
  referenced by its address bytes (options 1–4, varying address width).
  Used by OBJECT, ARRAY, STRING, etc. for their content.
- **literal/word** — fixed-width bytes that are interpreted as data
  (the address bytes in a SIGNATURE; the literal bytes of a WORD chunk).

The footer encodes which option each part used, mixed-radix-style.

### Inlining heuristic

`inlineOrAddressPart`'s decision to inline vs address: the encoder
inlines a part only when its bytes are short enough that storing them
inline costs no more than storing them by address. The break-even
depends on `numberToVar(byteLength).length` — how many bytes the next
address would take. So in a tiny streamo addresses are 1 byte, and only
1-byte codes get inlined. As the streamo grows, addresses grow, and
slightly-larger codes start getting inlined too.

Inline parts are NOT separately addressable. Their bytes live inside
the parent. `getPartAddress` fakes an address for them in write
contexts by appending the bytes as a new chunk; in read contexts (see
§4) it returns `undefined` to keep reads pure.

### `Duple` — the balanced-tree node

OBJECT and ARRAY values can be arbitrarily large. To avoid encoding the
whole tree as one big chunk on every change, they're encoded as
**balanced binary trees of `Duple` nodes**, each Duple a 2-tuple. For an
OBJECT, leaf Duples are `[key, value]` pairs; interior Duples are
`[Duple, Duple]`. For an ARRAY, leaf Duples are values directly.

The win: changing one entry only requires re-encoding the leaf Duple and
its `O(log n)` ancestors up to the root. All sibling Duples keep their
addresses, and dedup means unchanged subtrees stay byte-identical
across versions of the structure.

## 4. `CodecRegistry` — the codec dispatcher

> File: `public/streamo/CodecRegistry.js`

Wraps an `Addressifier` with the codec table and the high-level encode /
decode / asRefs / directReferences API.

- `encode(value)` — encodes any JS value to bytes by trying each codec's
  encode in registration order. Returns the chunk's bytes.
- `decode(code, asRefs)` — decodes bytes back to a JS value. With
  `asRefs=true`, composites (OBJECT, ARRAY, VARIABLE) return objects of
  child **addresses** instead of decoded child values — useful for
  structural traversal that doesn't need to decode untouched subtrees.
- `asRefs(address)` — public read API for "give me the children's
  addresses." **Mutation-impossible by construction**: it wraps its
  internal decode in a `#runReadOnly` scope that flips a flag the codec
  helpers check. `getPartAddress` returns `undefined` for inline-only
  children instead of materializing them. Reads cannot grow the store.
- `_asRefsForWrite` — internal companion. Called by `Streamo.set` /
  `setRefs` during path traversal where materialization is appropriate
  because a write op is in flight anyway.
- `directReferences(address)` — direct chunk-graph references: the
  addresses this chunk's bytes literally point to (vs `asRefs`, which
  walks past the codec's structure to user-level children). Used by the
  explorer's storage tab.

## 5. `Streamo` — the reactive layer

> File: `public/streamo/Streamo.js`

`Streamo` extends `CodecRegistry` with two more concerns:

### Reactivity

Each `Streamo` has a `Recaller` (see §6). `get` and `set` register and
fire reactive dependencies along the **paths** that were read. So a
watcher reading `streamo.get('users', 'alice', 'score')` is awoken
specifically when *that* path changes, not on every commit.

`changedPaths(streamo, addrA, addrB)` is a generator that yields every
path differing between two value addresses; `set` calls it after a
write to fire the right path-level mutations. **Important**: it uses
`asRefs` (not `decode(addr, true)`) so it cannot mutate the streamo
during traversal. (Earlier code used the mutating decode path; for
inline-only children it would append materializations *after* the new
commit, moving `valueAddress` past it and breaking `Repo.lastCommit`.)

### Signing (hash chain)

Each Streamo carries a 32-byte running accumulator. Every appended
chunk folds in as `acc' = sha256(acc || sha256(chunk))`, starting from
a 32-byte zero seed and re-seeded to the most recent signature's
accumulator after every SIGNATURE chunk lands. `sign(signer, name)`
signs the *current* accumulator value and appends a fixed-format
97-byte SIGNATURE chunk: `[accumulator(32) | signature(64) |
footer(1)]`. `verify(sig, publicKey)` is now pure crypto — it does not
need to walk the byte stream because the accumulator is carried
inside the chunk.

`valueAddress` skips trailing SIGNATURE chunks so `get`-style reads
always operate on user data even when the streamo just got auto-signed.

`makeVerifiedWritableStream(publicKey)` is the receive side of sync,
and the only path through which an untrusted peer can deliver bytes.
Every non-sig chunk is *staged* (folded into a tentative accumulator
but not yet appended). When a SIGNATURE arrives, two checks fire:
the chain check (`sig.accumulator` equals the staged accumulator) and
the crypto check (the signature verifies against `sig.accumulator`
under `publicKey`). If both pass, the staged chunks and the SIG are
appended in one batch; if either fails the stream errors and the
staged batch is discarded. The store is never polluted with bytes
that no SIG covers — closing the historical `[commit, bad_sig]`
corruption hole.

The chain is what makes the relay stateless across restarts: a peer
that wants to verify the next append only needs the most-recent
32-byte accumulator (carried on every SIGNATURE), not the full prior
byte stream.

## 6. `Recaller` — the reactivity primitive

> File: `public/streamo/utils/Recaller.js`

Fine-grained dep tracker:

- `watch(name, fn)` runs `fn` while pushing it onto a stack, then pops.
  Any `reportKeyAccess(target, key)` calls inside `fn` add a dep
  `(target, key) → fn`.
- `reportKeyMutation(target, key)` looks up watchers matching that
  key, queues them, and schedules a flush via `nextTick`.
- The flush has two protections: it skips watchers that have been
  unwatched mid-flush (the `#names` presence check), and it has an
  iteration cap to detect runaway re-firing.

Slot watchers (in `mount.js`) are unwatched when their DOM region is
removed; making `unwatch` survive a mid-flush call was a real bug
fixed in 2.0.

## 7. `Signer` / `Signature`

> File: `public/streamo/Signer.js`, `public/streamo/Signature.js`

`Signer` derives a secp256k1 keypair from `(username, password,
streamName)` via PBKDF2-SHA256(256 bits). Same credentials always
produce the same keypair — there are no key files. The KAT in
`Signer.test.js` pins the exact byte output so future runtime changes
in WebCrypto can't silently shift identities.

`Signature` is the value-class that gets encoded as a SIGNATURE chunk:
`{ accumulator, compactRawBytes }` where `accumulator` is the 32-byte
hash-chain value at the moment of signing and `compactRawBytes` is
the 64-byte ECDSA signature over it.

## 8. `Repo` — the signed commit log

> File: `public/streamo/Repo.js`

A `Streamo` whose every `set` is a commit:

```
checkout()  →  working = clone at last commit's dataAddress
working.set(...args)
this.commit(working, message)
  →  copyFrom(working) into this repo at some new address (dataAddress)
  →  encode and append a commit record:
       { message, date, dataAddress, parent: prev valueAddress }
attachSigner has scheduled a sign() that runs async after the commit
```

The commit log is what flows over the wire during sync. `history()` is
a generator that walks back through parents.

`defaultMessage` is an opt-in attribution string — clients can set it
so commits made via this repo's `set` get a non-empty message visible
in the explorer.

## 9. `RepoRegistry` — reactive collection of Repos

> Files: `public/streamo/RepoRegistry.js`

A keyed collection of `Repo`s, keyed by hex public key. The factory
function passed to the constructor decides what each repo gets wired
with — `archiveSync` for disk persistence, `s3Sync` for object storage,
or just plain in-memory `new Repo()`.

`onOpen` callbacks fire when a new repo is opened, used by
`registrySync` to broadcast catalog updates and by clients to watch
new participants as they appear.

**Cross-recaller bridging, built in.** Each `Repo` owns its own
`Recaller` — that gives it fine-grained dependency tracking on its
own internal keys without one repo's mutations invalidating watchers
on another. An app that displays many repos has its own app-level
`Recaller` for its `mount()` slots. A slot reading `repo.byteLength`
registers a dep on the *repo's* recaller, not the app's, so without
an explicit bridge the slot would never re-run when chunks arrived.

Pass your app's Recaller into the registry — `new RepoRegistry(factory,
{ recaller, name })` — and every opened repo's chunk-arrival events
bridge into that shared recaller automatically. The registry exposes
`dep()` (arrow-bound, destructure-safe — call inside any slot that
should re-run on chunk arrivals or new-repo opens) and `fire()` (force
a re-render for non-repo state changes — route, async results, an
app-level cache resolving).

**Forward synchronously.** The bridge mutates the app recaller
*synchronously* — the recaller's own `nextTick` flush already coalesces
multiple mutations in one tick into a single slot re-run. Wrapping the
mutation in `requestAnimationFrame` looks like a coalescing move but
buys nothing here and introduces a real failure mode: when the tab
loses focus, queued rAFs throttle, a `scheduled = true` flag stays
stuck, and every subsequent mutation is silently dropped until the
rAF eventually drains. From the user's view: the display freezes
until they refresh. Don't do it.

DOM side effects that genuinely need post-layout timing (auto-scroll,
syncing scroll positions, etc.) get their own rAF separately —
unrelated to the reactivity bridge.

## 10. `registrySync` — bidirectional WebSocket sync

> File: `public/streamo/registrySync.js`

Once a WebSocket is open, this is the protocol:

1. **Handshake**: the connecting side sends the literal text
   `"registry"`. The accepting side recognizes it and switches into
   registry-sync mode.

2. **JSON control messages**:
   - `{type: "catalog", keys: [...]}` — what repos this side has open.
   - `{type: "subscribe", key: "<hex>"}` — request bidirectional sync
     for a specific repo.
   - `{type: "interest", key: "<topic>"}` — express interest in
     announces for a topic (server-side routing).
   - `{type: "announce", key, topic}` — announce a key as related to
     a topic. Server fans out to subscribers; client-side `onAnnounce`
     fires.
   - `{type: "ping"}` — 20-second keep-alive so PaaS hosts don't
     idle-close.

3. **Binary frames**:
   `[33-byte compressed-secp256k1-public-key prefix][chunk bytes]`.
   The 33-byte prefix routes the chunk to the right repo. Frames are
   fed straight from `makeReadableStream` on the sender into
   `makeVerifiedWritableStream` on the receiver — including signature
   verification on every SIGNATURE chunk.

4. **Discovery**:
   - `filter(key)` — gates which repos from a peer's catalog get
     auto-subscribed. Default: all of them.
   - `follow(keyHex, repo, subscribe)` — invoked reactively whenever a
     synced repo's value changes. Used to walk content (e.g., a list of
     member keys in a chat room) and call `subscribe` on discovered
     keys. This is **content-driven discovery** — peers find each other
     through the data.
   - `onAnnounce(key, topic)` — runs on the client when a peer
     announces against a topic the client expressed interest in.

## 11. Sync backends

A Repo's bytes can be persisted/relayed via several plug-ins. They all
hook in via the `RepoRegistry` factory.

- **`archiveSync`** — chunks to numbered binary files under a
  `.streamo/archive/<keyHex>.bin` directory.
- **`fileSync`** — mirror a repo's value to/from the local filesystem
  with `.gitignore` honored.
- **`outletSync` / `originSync`** — server / client sides of a peer-to-
  peer WebSocket connection. (`webSync` is `outletSync` plus an HTTP
  static-file server.)
- **`s3Sync`** — chunks to S3-compatible object storage.
- **`stateFileSync`** — write a repo's value as JSON on every change.

## 12. UI layer: `h` and `mount`

> Files: `public/streamo/h.js`, `public/streamo/mount.js`

`h` is a tagged template literal parser:
``h`<div class=${cls}>${() => repo.get('name')}</div>` `` returns a
virtual tree of `HElement` / `HText` / slot nodes.

`mount(nodes, container, recaller)` renders them into the DOM. The
clever bit: function slots (`${() => ...}`) are wrapped in a
`recaller.watch`, so they re-run automatically when the data they read
mutates. Only the exact nodes bound to mutated paths re-render — no
virtual-DOM diffing.

Function components — plain `(props) => h\`...\`` functions — work
directly as tags inside `h\`<${Card}/>\``. Custom-element components
extend `StreamoComponent` (browser-only — extends `HTMLElement` at
module load).

## 13. `LiveSource` — the reactive data source contract

> File: `public/streamo/LiveSource.js`

The minimum interface `h` / `mount` reaches for when they need
reactive data:

    {
      recaller: Recaller,
      get(...path): any,
      set(...path, value): void
    }

`recaller` is the single bus `mount(_, _, recaller)` registers slot
watchers on. `get` reads the value at the given path and reports
access on the recaller so any slot that touched it re-runs when it
changes. `set` mutates the value at the given path and fires the
recaller for the affected key(s). Variadic path with value-last
matches `Streamo`'s existing `get(...path)` and `set([address,]
...path, value)` signatures — no special argument-order wart.

**Already implementing the contract:** `Streamo` and `Repo`. Their
existing methods *are* the interface; nothing else is needed to pass
one into a mount call.

**To wrap anything else:** `liveObject(target)` adapts a plain JS
object — reads walk the path and report access, writes walk to the
parent and fire mutation. Useful for app-local UI state where you
want the same reactive ergonomics as Streamo without persistence,
signing, or syncing.

`public/apps/location/main.js` is a worked example of writing a
LiveSource for a domain that needs more than the generic adapter:
`liveLocation()` returns `{recaller, get, set, proxy}` over
`window.location`, with hashchange and popstate wired to fire the
recaller, and `set` routing 'hash' / 'search' / 'pathname' /
'searchParams' to the right underlying mechanism (direct assignment
vs `history.pushState`). The proxy is sugar; the documented surface
is `get` and `set`.

The contract is convention, not enforced — JS doesn't have
interfaces. The value is that "if I read with this recaller, slots
re-run" becomes a guarantee you can count on, instead of a thing
you discover the hard way when a slot mysteriously stays stale.

## 14. The chat-room demo

> Files: `public/apps/chat/server.js`, `public/apps/chat/main.js`,
> `public/streamo/chat-cli.js`

A whole-system test of the design:

- The **server** is a Streamo whose primary repo is the chat ROOM.
  Its `members` field is a list of public keys. Each connecting
  client announces themselves to the room key; server's `onAnnounce`
  appends the member's key to `members` and commits. (Server is just
  another peer — its public key is the room address.)
- Each **client** opens its own repo (its identity), attaches a
  signer, and announces against the room key. It uses `follow` on the
  room repo to subscribe to every other member's repo as they appear.
- Messages are written by each client into their own repo as
  `{name, messages: [...]}`. Other clients see them via the
  subscription set up by `follow`.

## What's not here

A few things that are deliberately not yet built; flagged on the
roadmap:

- **Multi-device write conflict detection.** A single keypair writing
  from two places simultaneously will silently corrupt a stream
  (chunks identified by absolute byte offset, can't structurally
  merge). Single-writer-per-repo is safe today; relays are safe; chat
  is safe (each user writes from one session).
- **Codec helpers taking `r` per-call** instead of capturing it in
  closure. The `#runReadOnly` counter on `CodecRegistry` works but is
  a one-off pattern; the structurally pretty version threads `r`
  through every codec call.
- **Presence indicators in the UI.** The 20s WebSocket ping keeps
  connections alive but no UI surfaces "alice is online." The
  interest/announce ephemeral layer is the obvious basis.
