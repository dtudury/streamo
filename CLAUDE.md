# streamo — Claude context

## what this project is

`@dtudury/streamo` is a peer-to-peer sync library with a reactive UI layer. The central
promise: no server holds authority over your data or your identity. Keys are derived
deterministically from credentials (no files to manage), every write is signed and
append-only, and the server is a relay — not a gatekeeper.

## the face of the project

These files are how people discover and understand streamo. Keep them in sync
after any meaningful change — not as an afterthought, but as part of the work:

- **`README.md`** — npm/GitHub landing page; imports, framing, and examples must reflect
  the current package name (`@dtudury/streamo`) and current capabilities
- **`public/index.html`** — browser homepage; feature list and app cards should match
  the README's framing
- **`package.json`** — version, name (`@dtudury/streamo`), description, and keywords;
  version bumps immediately after the user says they've published
- **`ROADMAP.md`** — public on GitHub; mark items done when they ship, update "start
  here" to the next priority, keep the "toward 1.0" list current

Stale public-facing docs erode trust faster than bugs do.

## publish rhythm

The user publishes to npm manually and notifies Claude when done. The moment they say
they've published, bump the patch version in `package.json`, commit, and push — before
starting any other work. This ritual matters to them.

## language and framing

Use this framing consistently across all public-facing text:

1. **No server holds authority** — the server is a relay, not a gatekeeper
2. **Your identity travels with you** — same credentials, same keypair, everywhere; no
   key files, no seed phrases, no backup ritual
3. **Every write is provably yours** — signed commits, append-only, permanent
4. **Content-addressed** — data identified by what it is, not where it lives

"Content-addressed" is technically important but not the lead. Start with ownership.

## architecture notes

- `Streamo` — content-addressed, append-only byte store with self-describing codec
- `Repo` — wraps Streamo; every `set()` is a signed commit (message, date, address, parent)
- `Signer` — deterministic secp256k1 keypairs via PBKDF2 from username + password
- `Recaller` — fine-grained reactive dependency tracker; `watch(name, f)` / `unwatch(f)`
- `h` — tagged template literal HTML parser → HElement / HText virtual tree
- `mount` — reactive DOM renderer; slots are reactive cells; elements recycled by
  `data-key` then tag on re-render; removed nodes cleaned up via `recaller.unwatch()`;
  exports `dismount(root, recaller)` for custom element cleanup
- `StreamoComponent` — base class for hot-reloadable custom elements; `componentKey`
  generates address-based names; `defineComponent` registers render functions; function
  components `(props) => nodes` work directly as tags in `h` with no class needed
- `registrySync` — bidirectional multi-repo sync over a single WebSocket; works in Node
  and browser; content-driven discovery via `follow`
- CLI `--web` flag — starts a WebSocket relay + static file server; `chat-server.js` is
  retired; `public/streamo/chat-cli.js` is the terminal chat client

## what's next

1. Rebuild the browser app with `h` / `mount` — registry → repo → commit history → value
   at commit; treat streamo as a black box (import from the public API only)

## commit style

Commit and push at the end of every response that makes a change. Over-commit rather
than over-think. Co-author line on every commit:

    Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
