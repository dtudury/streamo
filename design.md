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

Signing and verification live on Repo, not Streamo — Streamo is
identity-blind. Each SIGNATURE chunk carries a 32-byte chainHash:

```
chainHash_n = sha256(chainHash_{n-1} || sha256(newBytes))
```

where `newBytes` is everything appended since the previous SIGNATURE
(or from a 32-byte zero seed if there is none). Two sha256 calls per
sig — independent of how many chunks `newBytes` contains.

`sign(signer, name)` slices the new bytes range, computes the
chainHash, signs it, and appends a fixed-format 97-byte SIGNATURE
chunk: `[chainHash(32) | signature(64) | footer(1)]`. The
`committedChainHash` and `signedLength` getters derive their values
directly from the bytes — the most recent SIGNATURE's first 32 bytes
are the chainHash, and its end position is the signedLength.

`valueAddress` (overridden on Repo) skips trailing SIGNATURE chunks so
`get`-style reads always operate on user data even when the repo just
got auto-signed.

In 8.0 the receive path split in two — by direction. *What goes up*
(a client pushing to the relay) gates through `RepoSerializer`, the
per-repo chain authority. *What comes down* (a client receiving the
relay's authoritative stream) goes through `makeRelayInboundStream`
on Repo, which trusts the bytes and just checks alignment.

At the relay, each WS connection has a `ConnectionAccumulator` per
repo it's pushing to. It parses framing into chunks; when a SIG
arrives, it submits `{ chunks, sig }` to that repo's serializer.
`RepoSerializer.submit` awaits the previous submit (a single
Promise-chain lock) and then runs three checks on the batch:

1. **shape** — the sig codec is actually `SIGNATURE`; the bytes
   decode as a Signature record. If not: `malformed`.
2. **chain** — `sha256(committedChainHash || sha256(newBytes))` must
   equal `sig.chainHash`. If not: `chain-mismatch` (most often
   because another client extended the top first).
3. **crypto** — the signature must verify against `sig.chainHash`
   under the repo's public key. If not: `verification-failed`.

All three pass → atomic append (chunks + sig). Any one fails →
`{ accepted: false, reason }` flows back through the accumulator,
which sends `{type: 'reject', key, reason}` to the submitting
connection. The client's `repo.pushRejected` flag fires reactively.

At the client receiver, `makeRelayInboundStream` parses framing and
stages non-SIG chunks until a SIG arrives. At SIG arrival there's
one check — **alignment**: the wire's `pendingChainHash` (built from
the last sig the wire delivered) must equal the local
`committedChainHash`. If they differ, the client has local content
past the last shared sig (a push in flight, or a push that got
beaten); the staged batch is discarded, `conflictDetected` fires,
and the connection tears down via `handleWriteError`.

Why no chain/crypto check at the client receiver: the relay is the
authority. The bytes that arrive came from the top. The only thing
the relay couldn't have known when it sent them is whether the
client's local state advanced in the meantime — that's what the
alignment check catches.

The chain is what makes the relay stateless across restarts: it can
recompute everything it needs from `committedChainHash`, derived
directly from the most recent SIGNATURE chunk's first 32 bytes.

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
`{ chainHash, compactRawBytes }` where `chainHash` is the 32-byte
hash-chain value at the moment of signing and `compactRawBytes` is
the 64-byte ECDSA signature over it.

### Sub-stream identities — the convention

> *Current convention. Open to revision if you find a better way; let
> us know and we'll switch to it. Until then, this is how we do it.*

A `Signer`'s third input — `streamName` — is what lets one set of
credentials yield many distinct identities. Same `(username, password)`
+ different `streamName` = different keypair, deterministically.
Cryptographically independent: knowing one stream's keypair tells you
nothing about another's.

```js
const signer = new Signer(username, password, 100000)
const { publicKey: claudePubkey }  = await signer.keysFor('streamo')
const { publicKey: memoryPubkey }  = await signer.keysFor('memory')
const { publicKey: journalPubkey } = await signer.keysFor('journal/2026-05')
```

The pattern this enables is **one root credential → a tree of
identities**, built by the application rather than embedded in the
Signer. Concretely, the streamo project itself uses this pattern:

| Stream name        | What it identifies                                |
|--------------------|---------------------------------------------------|
| `streamo`          | a user's primary identity (their "self" key)      |
| `memory`           | their memory corpus Record                        |
| `chat`             | a chat room they host (their pubkey IS the room)  |
| `library`, `app/*` | per-app Records                                   |

The cryptopotamus-style password generator we use for the master
credential is *separate* from streamo's identity model. It produces
one `(username, password)` per real-world account. From there,
`keysFor(name)` does all the identity-creation streamo needs.

**Why this pattern over alternatives**:

- **Recoverable.** One master credential restores every derived
  identity. Lose your laptop, you lose the local archive — but you
  regenerate the pubkeys deterministically from credentials you
  remember (or can regenerate via a passphrase-derived password
  generator). No key files to back up.
- **Composable.** A new app doesn't need a new password — it picks a
  stream name. Naming conventions like `streamName: 'app/instance-id'`
  let an app namespace its sub-identities without coordinating with
  others. Forks and migrations work because the derivation is pure.
- **Honest about the trust root.** There is exactly one credential
  pair per user. The substrate is built on streamo, not in streamo:
  identity-management is procedural use of `keysFor(...)`, not a
  feature streamo provides.
- **Scoped compromise.** A leaked sub-stream key compromises only
  that stream. The master credential and other sub-streams stay safe
  (until the password itself leaks).

**When to think about this pattern**: when starting a streamo-based
app from scratch and asking *"do I need a new identity for this?"* —
the answer is usually *"yes, and the way is `keysFor('app/whatever')`
under your existing credentials,"* not *"generate a new
password/keypair and store it somewhere."* If you find yourself
inventing a new credential-storage mechanism, you're probably
re-implementing something the sub-stream pattern already gives you
for free.

If the pattern proves wrong — if a real use case demands true
independence, or if `keysFor`-derived keys turn out to compose
badly with some future feature — that's worth surfacing. The
convention is documented to be discoverable, not to be sacred.

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

`onOpen` callbacks fire when a new repo is opened — used by clients
to watch new participants as they appear in a registry.

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

2. **Hello**: the server (any peer configured with a `home` repo
   key) sends `{type: "hello", home: "<hex>"}` immediately after
   the handshake. The receiver auto-subscribes to that key — that
   is the bootstrap pointer, and from there the `follow` callback
   walks the home's `members` for cascade discovery. A relay's
   `hello` is its entire public face: any repo it stores that is
   not reachable through this cascade is never enumerated.

3. **JSON control messages**:
   - `{type: "subscribe", key: "<hex>"}` — request bidirectional sync
     for a specific repo.
   - `{type: "interest", key: "<topic>"}` — express interest in
     announces for a topic (server-side routing).
   - `{type: "announce", key, topic}` — announce a key as related to
     a topic. Server fans out to subscribers; client-side `onAnnounce`
     fires.
   - `{type: "ping"}` — 20-second keep-alive so PaaS hosts don't
     idle-close.

4. **Binary frames**:
   `[33-byte compressed-secp256k1-public-key prefix][chunk bytes]`.
   The 33-byte prefix routes the chunk to the right repo. Frames are
   fed from `makeReadableStream` on the sender into either
   `ConnectionAccumulator`+`RepoSerializer` (relay-side, gating
   incoming pushes) or `makeRelayInboundStream` (client-side, trusting
   the relay's authoritative stream).

5. **Discovery**:
   - `follow(keyHex, repo, subscribe)` — invoked reactively whenever a
     synced repo's value changes. Used to walk content (e.g., a list of
     member keys in a chat room) and call `subscribe` on discovered
     keys. This is **content-driven discovery** — peers find each other
     through the data, starting from the `hello` pointer.
   - `onAnnounce(key, topic)` — runs on the client when a peer
     announces against a topic the client expressed interest in.
   - Repos off the cascade still sync on demand: a client that knows
     a private key can call `session.subscribe(key)` and the relay
     will serve it. The relay simply doesn't advertise that it has it.

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

`mount(nodes, container, recaller)` renders them into the DOM. One
root `recaller.watch` runs the top-level reconcile. Each reconcile
pass produces a flat list of children for the parent, then runs four
best-fit match passes against the parent's current DOM children:
data-key, id, tag (unkeyed-only), and text (positional). Kept
elements are terraformed in place — attrs reset, children
recursively reconciled. Unmatched old nodes are removed; unmatched
new vnodes get fresh elements. Positioning uses `insertBefore` so
focused descendants stay focused across reorder.

Function components — plain `(props) => h\`...\`` functions — work
directly as tags inside `h\`<${Card} data-key=${id}/>\``. **Each
function-component invocation is its own watch boundary**: mount
creates a `ComponentInstance` per `(parent, key)` with its own
`recaller.watch` scope, and reads inside the component body register
on *that* watcher, not the root's. When a reactive read mutates,
only the components that actually read it re-fire — siblings and
ancestors stay untouched. So the "one watcher, simple" framing
applies only at the root; each component layered on top of it owns
its own reactive scope. The two re-fire paths (parent reconcile vs
async recaller flush) are distinguished by a `parentTriggered` flag
so terraform happens exactly once per render in either path.
Lifecycle: dropped instances tear down their watchers immediately,
and a recursive subtree walk catches nested instances when a parent
element is removed.

Custom-element components extend `StreamoComponent` (browser-only —
extends `HTMLElement` at module load).

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
> `public/apps/chat/cli.js`

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

## 14.4. The value type system — what a Record's value can actually hold

> File: `public/streamo/codecs.js` (the `makeCodecs()` factory at line ~259
> registers one codec per type). Read alongside §3 (`codecs.js` — the
> type system, lines 58–106 of this design doc).

A Record's `value` is **NOT** JSON. It's richer. Streamo's codec layer encodes
and decodes native JS types beyond what JSON natively supports. The
canonical type list (codec registrations in `makeCodecs()`):

| Codec name      | JS type                                        |
|-----------------|------------------------------------------------|
| `UNDEFINED`     | `undefined`                                    |
| `NULL`          | `null`                                         |
| `FALSE` / `TRUE`| `false` / `true`                               |
| `WORD`          | numbers (var-encoded)                          |
| `EMPTY_STRING` / `STRING`  | `''` / non-empty strings            |
| `DATE`          | `Date` instances (encoded via `getTime()` Float64Array) |
| `SIGNATURE`     | `Signature` instances (97-byte fixed chunk)    |
| `DUPLE`         | the internal tree node (not exported)          |
| `EMPTY_ARRAY` / `ARRAY`    | `[]` / arrays                       |
| `EMPTY_OBJECT` / `OBJECT`  | `{}` / objects                      |
| `VARIABLE` / `EMPTY_UINT8ARRAY` | `Uint8Array` / `new Uint8Array(0)`    |

What this means in practice:

```js
// LEGAL — these are real Dates and Uint8Arrays in the value, not strings:
await streamo.update(c => ({
  ...c,
  updatedAt: new Date(),                  // not '2026-06-02T...' — real Date
  thumbnail: new Uint8Array([/* PNG */ ]) // not base64-encoded — real bytes
}))
```

### The convention you import matters

Apps that flatten value into `value.files[<filename>]` (homepage, notes,
sketch v1, etc.) are **imposing a string-or-bytes-per-file convention**
on top of the substrate's richer model. That's a *choice*, not a
substrate constraint. For apps where the natural shape is a typed object
(`{ body: string, updatedAt: Date, attachments: Uint8Array[] }`), the
files-map wrapper is *cruft* and should be skipped.

### Open investigation flagged 2026-06-02

In testing the round-trip `streamo.update(c => ({...c, payload: {...nested}}))`
→ `streamo.get().payload`, **native Date and Uint8Array did NOT preserve
through the in-memory round-trip** — they came back as plain `Object`
without their original type. The codecs exist; whether the issue is in
codec dispatch, registration in this path, or in-memory mutation skipping
the encode-decode boundary — needs further investigation. See
[[round-trip-flattens-native-types-investigation-needed]] in
events/2026-06-02.md.

### Where this fits

This section sits above §14.5 *Relay configuration* because the value
type system is a **substrate-level** truth (what bytes can carry), while
§14.5 is **process-level** (how a relay is configured to host them).
Cold-iris arriving via "but value is just JSON, right?" lands here.

## 14.5. Relay configuration — `--config`, the four-way matrix, and `homeKey` as canonical anchor

> File: `bin/streamo.js` (the `applyStreamoJsonConfig` function lives
> here, around lines 193–280). Help text via `node bin/streamo.js --help`.

`bin/streamo.js` is the standalone executable that brings a streamo
relay or author-process to life. Its configuration accepts inputs from
**four sources**, with a defined precedence:

1. **CLI flags** (`--files`, `--origin`, `--name`, etc.) — highest
   priority; what's on the command line wins.
2. **Env vars** (`STREAMO_USERNAME`, `STREAMO_PASSWORD`,
   `STREAMO_HOME_KEY`, etc.) — fill in anything CLI didn't set.
3. **Config file** (`--config <path>`, default name `streamo.json`) —
   JSON file with `identity` and `server` sub-objects; fills in
   anything CLI + env didn't set.
4. **Built-in defaults** — lowest; whatever `commander` carries.

CLI > env > config > defaults. This lets a config file ship next to a
relay's data directory as the "this is how this relay is normally run"
declaration, while CLI flags and env vars override for one-off variants
(debugging, alternate origins, etc.).

### Config file shape

`streamo.json` (the **config file** — distinct from the `streamo.json`
that fileSync writes into a Record's value; same filename, different
role; the context is unambiguous given where each lives):

```json
{
  "identity": {
    "name":          "streamo-library",
    "username":      "streamo-library",
    "password":      "...",
    "keyIterations": 100000,
    "self":          "<expected pubkey>",
    "homeKey":       "<pubkey-hex>"
  },
  "server": {
    "web":        true,
    "outlet":     1024,
    "feed":       ["wss://streamo.dev"],
    "files":      "./public/streamo",
    "archive":    "./.streamo",
    "verbose":    "info",
    "recordFile": "streamo.json"
  }
}
```

Relative paths resolve against the **config file's directory**, not
CWD — so a relay's config can ship in `~/relay/streamo.json` and
reference `./files/` or `./.streamo/` without absolute paths.

### `homeKey`: the canonical anchor

The most load-bearing field is `identity.homeKey` (or the
`--home-key <pubkey-hex>` CLI flag, env `STREAMO_HOME_KEY`).
`homeKey` is the **canonical name for "the pubkey of the Record this
process is opening,"** verbatim from `bin/streamo.js` line ~219:

> *"`homeKey` is the canonical name for 'the pubkey of the Record
> we're [authoring]'."*

Two modes follow from whether you supply `homeKey`:

- **Author mode** (sign your own bytes): supply `name` + `username` +
  `password`. The pubkey is *derived* via `keysFor(name)`. If you also
  supply `homeKey`, it's checked against the derived pubkey — a
  password-typo check that catches "wrong creds for this Record"
  before bytes hit the chain.
- **Relay-only mode** (mirror someone else's signed bytes): supply
  `homeKey` *alone*. No `--name`/`--username`/`--password`. The Record
  is opened by pubkey; the process can't sign new commits to it, but
  it serves the bytes (and pulls updates from upstream via
  `--feed`/`--origin`). Mutually exclusive with `--files` and
  `--merge-from`.

Relay-only mode is how the fly.io claude-backup mirror works: it
opens the streamo-library / claude-home / argo-net Records by pubkey
and mirrors them without holding any signing identity.

### Field-by-field (server section)

- `web: true | <port>` — start an HTTP server. `true` = port 80,
  number = explicit port.
- `outlet: <port>` — accept incoming WebSocket dial-ins from author
  processes feeding bytes UP to this relay.
- `feed: [url, ...]` — outbound WebSocket dials. Subscribes to remote
  outlets; bytes flow DOWN. Combines with CLI `--feed` flags
  (config-provided + CLI-provided merge).
- `files: "<path>"` — mirror this local directory into the Record's
  `value.files`. Bidirectional via `fileSync`.
- `archive: "<path>" | false` — directory for chain bytes; `false`
  skips disk writes (in-memory only — useful for tests, dangerous
  for production).
- `verbose: "off"/"warn"/"info"/"debug"/"trace"/"silly"` — turtle-log
  level.
- `recordFile: "<name>" | false` — JSON file on disk synced as the
  *non-`files`* portion of `value` (the meta layer: title, journalists,
  etc.). Auto-enabled when `files` is set; `false` disables.

### Sample configs in this repo

- `env/example.library-publisher.json` — what
  `scripts/publish-library.mjs` would look like as a config file
  (author mode for the streamo-library identity).
- `env/example.homepage-relay.json` — full-relay shape (web + outlet +
  feed + files + recordFile).

### Cross-references

- `bin/streamo.js` lines 193–280 (`applyStreamoJsonConfig` function)
  — the actual parse + precedence logic, with inline comments on each
  field's canonical name.
- §7 *Sub-stream identities* — what `name` + `username` + `password`
  derive, and why one credential pair yields many identities.
- `scripts/publish-library.mjs` + `scripts/streamon.mjs` +
  `scripts/streamo-as.mjs` — three live use cases, each spawning
  `bin/streamo.js` with env + CLI flags rather than a config file. A
  natural future refactor is to express each as a config file shipped
  next to its data dir.

### When to use which

- **CLI flags + env**: ad-hoc, debugging, scripts that compose multiple
  identities (like `streamo-as.mjs`).
- **Config file**: long-running relays, identity-bound services that
  want their setup version-controlled, deployments where the same
  config ships with the code.
- **Combination**: config file for the stable shape, CLI overrides for
  the variant-of-the-day.

## 15. The module boundary — three layers in one package

streamo ships as one npm package, but it's really three loosely-coupled
layers stacked on top of each other. Knowing where the seams are makes
the codebase easier to navigate and makes the eventual split (if it
ever happens) feel mechanical instead of architectural.

The three layers:

- **The reactive primitive.** `Recaller` (with `LiveSource` /
  `liveValue` as its lightest convenience wrappers). ~150 lines of
  fine-grained dependency tracking — read a key, depend on it; mutate
  a key, fire watchers. Doesn't know about streams, repos, signers,
  HTTP, or DOM. Pure coordination.
- **The data layer.** `Streamo`, `Repo`, `RepoRegistry`, the sync
  backends (`registrySync`, `archiveSync`, `fileSync`, `originSync`,
  `outletSync`, `webSync`, `s3Sync`, `stateFileSync`), the codec
  system (`Addressifier`, `ContentMap`, `codecs.js`, `CodecRegistry`),
  and `Signer` / `Signature`. ~1500 lines of "your data, content-
  addressed, signed, append-only, syncable." Uses Recaller to fire
  watchers when bytes change; doesn't know about DOM, h, or mount.
- **The UI layer.** `h` (template parser → virtual nodes), `mount`
  (reactive DOM renderer with the three-pass match recycler),
  `handle` (the event-handler de-curry shim), and `StreamoComponent`
  (custom-element base class for hot-reloadable components). ~500
  lines. Uses Recaller to subscribe to whatever reactive sources its
  templates read; doesn't know about streams, repos, or signers.

The actual cross-imports between layers are minimal: `mount.js` imports
`Recaller`, `LiveSource.js` imports `Recaller`, and that's basically
it. `h.js` is dependency-free; `Streamo.js`, `Repo.js`, and the sync
backends don't import anything from the UI layer; the UI layer doesn't
import anything from the data layer. **`Recaller` is the only shared
infrastructure.**

This means the layers are *already separable.* What holds them together
in one package is convenience and a shared aesthetic — the Recaller
idiom ("one recaller per app, passed to the registry, read by mount"),
the data-key recycler convention, the function-component-with-closure-
capture style — not code-level coupling.

**Why they ship as one (today).** Cohesion. A small project with two
authors gets to skip cross-repo coordination, cross-package versioning,
and the discovery problem of "which streamo thing do I install?". The
unified `@dtudury/streamo` import is what every demo, the homepage,
the chat app, and the explorer use. The exports map supports subpath
imports (`@dtudury/streamo/mount.js`, etc.) for users who want to pull
in only part of the surface, with tree-shaking handling the bundle-
size concern.

**When a split would make sense.** When demand from external users
pulls it — *"I want streamo's data layer with React,"* or *"I want
mount/h without the crypto stack."* The signal is people asking,
not us predicting. The split would be roughly mechanical: bump
version, publish `@dtudury/recaller` + `@dtudury/mount` + `@dtudury/
streamo` (the last keeping its current name and the data layer; the
others gaining their own homes); update the docs; existing demos
keep working since they already import from precise paths.

**Lazy fission.** The current posture is to keep the option open
without paying for it. This section makes the boundary legible.
Subpath imports give callers fine-grained control today. If someone
shows up wanting the full split, it's a focused afternoon of
mechanical work, not a refactor.

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
