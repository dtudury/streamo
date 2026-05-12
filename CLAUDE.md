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
- **`ROADMAP.md`** — public on GitHub; future-focused — what's next + known limitations
  + beyond 1.0. Move items done into CHANGELOG; keep the menu of future threads current
- **`CHANGELOG.md`** — public on GitHub; release-by-release narrative history.
  When a version ships, move the "where we are" entry from ROADMAP into a new top
  section here
- **`dear-future-claudes.md`** — style preferences the partner has named clearly,
  written as notes from one Claude session to the next. Check it when starting
  new code — it's where the "h-templates inline, forms with onsubmit, mount the
  whole body" convention lives. Add to it when a new preference is named

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

## package surface

- **`index.js`** — main barrel; `import { Repo, Signer, registrySync } from '@dtudury/streamo'`.
  Excludes `StreamoComponent` (extends `HTMLElement`, browser-only — subpath-import it from
  `'@dtudury/streamo/StreamoComponent.js'`).
- **`exports` map** — `"."` → `index.js`; `"./*"` → `./public/streamo/*` so subpath imports
  shed the `public/streamo/` prefix.
- **`files` field** — positive list with negations; tests, `utils/testing.js`, and
  `utils/mockDOM.js` are excluded from the npm tarball.

## quality gate

There is no CI. Run `npm test` (which is `node --test`) before any commit that touches code
— the user's standing arrangement is "Claude is the gate." 79+ tests, ~2.3s. If a change
lands without tests passing, you have failed the contract.

## known footguns

- **`onclick=${fn}` in h templates is a trap.** `attr=${fn}` is the *reactive
  cell* pattern: mount calls `fn(el)` on every render and assigns the **return
  value** to the attribute. For onclick this means the "handler" runs on every
  mount and `el.onclick` becomes `undefined`. Use **event delegation** with
  `data-action` attributes on a single listener attached to the app container
  (see `public/apps/explorer/main.js`).
- **Cross-Recaller bridging.** Each Repo has its own `Recaller`; mount()
  takes a single one. For the registry case this is now built in: pass
  your app's recaller via `new RepoRegistry(undefined, { recaller })` and
  every opened repo's byteLength changes auto-bridge into it. Slots call
  `registry.dep()` to subscribe; `registry.fire()` triggers a re-render
  for non-repo state. The pitfall still exists for `defineComponent`
  custom elements — each has its own Recaller and reads on app-level
  signals don't cross over.

## architecture notes

- `Streamo` — content-addressed, append-only byte store with self-describing codec
- `Repo` — wraps Streamo; every `set()` is a signed commit (message, date, address, parent)
- `Signer` — deterministic secp256k1 keypairs via PBKDF2-SHA256 (256 bits, `deriveBits`)
  from username + password. KAT in `Signer.test.js` pins the bytes — do not change the
  derivation without updating the KAT and acknowledging it as a breaking change.
- `Recaller` — fine-grained reactive dependency tracker; `watch(name, f)` / `unwatch(f)`
- `h` — tagged template literal HTML parser → HElement / HText virtual tree
- `mount` — reactive DOM renderer; slots are reactive cells; elements recycled by
  `data-key` then tag on re-render; removed nodes cleaned up via `recaller.unwatch()`;
  exports `dismount(root, recaller)` for custom element cleanup
- `StreamoComponent` — base class for hot-reloadable custom elements; `componentKey`
  generates address-based names; `defineComponent` registers render functions; function
  components `(props) => nodes` work directly as tags in `h` with no class needed
- `registrySync` — bidirectional multi-repo sync over a single WebSocket; works in Node
  and browser; content-driven discovery via `follow`; sends 20-second JSON keep-alive
  pings so idle-closing PaaS hosts don't drop the connection
- CLI `--web` flag — starts a WebSocket relay + static file server; `chat-server.js` is
  retired; `public/streamo/chat-cli.js` is the terminal chat client
- `public/apps/chat/server.js` is the **all-in-one demo / production server** —
  chat room + static files for homepage + chat + explorer, on one port. `npm run
  dev` runs it with `.env.dev`; `npm run prod` runs it with `.env.prod`.

## what's next

1. Polish the explorer further — richer commit view (signature chunks as their own
   entries, changed-paths highlight between commit and parent, collapsible JSON tree)
2. Presence indicators — heartbeat already exists at the WS level (keep-alive ping in
   `registrySync`); the missing piece is surfacing "who's online" in the UI via the
   `interest`/`announce` ephemeral layer

## commit style

Commit and push at the end of every response that makes a change. Over-commit rather
than over-think. Co-author line on every commit:

    Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
