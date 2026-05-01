# streamo roadmap

This is a living document — updated with every meaningful change to give a clear
picture of where the project is and where it's headed.

---

## where we are (0.1.0)

The foundation is solid and working. Here's what's in:

**Core data layer**
- `Streamo` — reactive, content-addressed, append-only byte store with a
  self-describing codec. Same value always encodes to the same bytes; dedup and
  diffing are free.
- `Repo` — every write is a signed commit. Message, date, data address, parent.
  The full history is always there.
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
- `h` — tagged template literal parser. Turns `h\`<div class=${cls}>...\`` into a
  virtual tree of `HElement` / `HText` / slot nodes.
- `mount` — reactive DOM renderer. Slots that are functions re-run automatically
  when the data they read changes. No virtual DOM diffing — only the exact nodes
  bound to mutated paths update.

**Apps**
- Chat — full p2p messaging app. Each participant owns their own message stream;
  the server is just a relay and holds no special authority. Runs in the browser
  and from the terminal (`chat-cli.js`).
- Homepage at `public/index.html`.
- `npm run serve` — static file server for `public/`.

---

## what's next

### fix watcher leaks in `mount` ← start here
When a reactive slot re-renders, child watchers registered inside it are never
cleaned up. Every re-render accumulates more. This is a correctness bug and the
thing most worth fixing before building more UI on top of `mount`.

### component support in `h`
Functions as tags: `h\`<${Card} title="hi"/>\``. This is the difference between
a templating tool and a UI framework. Once watcher cleanup exists, components
become straightforward — a component is just a function that returns nodes and
cleans up after itself.

### SVG namespace
`mount` hardcodes the XHTML namespace. `h\`<svg><path/></svg>\`` won't render
correctly until `mount` auto-detects SVG elements and switches namespaces.

### `class` as array or object
`class=${['btn', isActive && 'active']}` is such a common pattern that not
supporting it is a daily papercut. Easy win.

### chat persistence
Right now the chat server is in-memory — restart it and history is gone. Wiring
`archiveSync` into `chat-server.js` is a small change with a big quality-of-life
improvement.

### chat signing
Messages aren't cryptographically verified yet. Anyone who knows a participant's
public key hex could theoretically spoof them. Wiring `repo.sign()` after each
`set()` closes this.

### presence indicators
Who's currently online? The `interest` / `announce` layer is ephemeral by design,
so presence is a heartbeat + timeout — announce yourself periodically, time out
peers you haven't heard from.

### rebuild the browser app
The old repository-browser app was left behind during the migration because its
imports broke. Rebuilding it with `h` / `mount` would be the first substantial
real-world test of the UI layer.

### fix dead links on the homepage
`public/index.html` links to the browser and components apps that no longer exist.
Either rebuild them or remove the links.

### CLAUDE.md
Add a `CLAUDE.md` for the streamo repo so future Claude sessions have the full
context.

---

## toward 1.0

The three things blocking a stable `1.0` claim:

1. **Watcher leak fixed** — `mount` must be correct before anyone builds on it
2. **Components** — without them, `h` / `mount` is too limited for real apps
3. **Chat signing** — the whole point of the project is cryptographic authorship;
   the flagship app should demonstrate it

Keyed list reconciliation and refs are quality-of-life improvements that can come
after 1.0.
