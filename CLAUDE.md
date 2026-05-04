# streamo — Claude context

## what this project is

`@dtudury/streamo` is a peer-to-peer sync library with a reactive UI layer. The central
promise: no server holds authority over your data or your identity. Keys are derived
deterministically from credentials (no files to manage), every write is signed and
append-only, and the server is a relay — not a gatekeeper.

## the face of the project

These three files are how people discover and understand streamo. Keep them in sync
after any meaningful change — not as an afterthought, but as part of the work:

- **`README.md`** — npm/GitHub landing page; imports, framing, and examples must reflect
  the current package name (`@dtudury/streamo`) and current capabilities
- **`public/index.html`** — browser homepage; feature list and app cards should match
  the README's framing
- **`package.json`** — version and name (`@dtudury/streamo`); version bumps immediately
  after the user says they've published

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
  `data-key` then tag on re-render; removed nodes cleaned up via `recaller.unwatch()`
- `registrySync` — bidirectional multi-repo sync over a single WebSocket; works in Node
  and browser; content-driven discovery via `follow`

## what's next (toward 1.0)

1. Component support in `h` — functions as tags: `` h`<${Card} title="hi"/>` ``
2. Chat signing — wire `repo.sign()` so messages are cryptographically verified
3. SVG namespace — auto-detect SVG elements in `mount`
4. `class` as array or object — common pattern, currently unsupported
5. Chat persistence — wire `archiveSync` into `chat-server.js`
6. Rebuild the browser app with `h` / `mount`
7. Fix dead links on homepage (browser and components apps no longer exist)

## commit style

Commit and push at the end of every response that makes a change. Over-commit rather
than over-think. Co-author line on every commit:

    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
