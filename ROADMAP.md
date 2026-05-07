# streamo roadmap

This is a living document — updated with every meaningful change to give a clear
picture of where the project is and where it's headed.

---

## where we are (0.1.3)

The foundation is solid and working. Here's what's in:

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
  stream. `public/apps/chat/server.js` is the standalone server — its public key
  is the room address, its member list is in its own repo, and it has no special
  authority over anyone's data. Runs in the browser and from the terminal
  (`chat-cli.js`).
- Homepage at `public/index.html`.
- `StreamoServer` — reusable class that wraps signer, registry, and all sync
  methods behind a clean API. `bin/streamo.js` is now a thin CLI parser on top
  of it; `public/apps/chat/server.js` is a standalone chat server using the
  same class.
- `npm run serve` — starts a streamo node (with REPL) using `.env.dev`
  credentials. The dev server is a real peer, not a bare static file server.

---

## what's next

### chat persistence ← start here
The chat server (`public/apps/chat/server.js`) uses `StreamoServer` and wires
`archiveSync` — so the member list survives restarts automatically. Individual
message history lives in each participant's own repo; persistence there depends
on participants running with `--data-dir` set. The remaining work is ensuring the
browser chat client also persists across page reloads.

### presence indicators
Who's currently online? The `interest` / `announce` layer is ephemeral by design,
so presence is a heartbeat + timeout — announce yourself periodically, time out
peers you haven't heard from.

### rebuild the browser app
The old repository-browser app was left behind during the migration because its
imports broke. Rebuilding it with `h` / `mount` would be the first substantial
real-world test of the UI layer.

---

## toward 1.0

One thing blocking a stable `1.0` claim:

1. **Chat persistence** — a chat app that loses history on restart isn't production-ready

Chat signing is done. Components, keyed list reconciliation, SVG namespaces,
`class` arrays/objects, and the CLI server unification are all done.
Persistence is the last mile.

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
