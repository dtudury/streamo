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
- **`public/homepage/index.html`** — browser homepage, served from the home repo's
  `files` key via `fileSync` (page-as-Repo). Feature list and app cards should match
  the README's framing. Edit on disk → signed commit lands → next request serves the
  new bytes
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

- ## ⚠️ **IMPORTANT — REPEAT OFFENDER:** `registry.open(key)` is local; `session.subscribe(key)` is the wire.
  **If your client code is reading `undefined` from a Repo you just opened, you
  almost certainly wanted `session.subscribe` instead.** This footgun has
  bitten us at least twice — independent Claudes from independent sessions,
  both reaching for `open` because the English meaning is right. Read this
  one twice before you write the `open` call.

  `RepoRegistry.open(key)` ensures a Repo object exists locally for that
  pubkey — it's idempotent, doesn't touch the network, and is used internally
  by the registry when bytes arrive for an unknown key (or by code that
  explicitly wants local-only behaviour, like the relay's startup seed step).
  **Client code that wants bytes to flow wants `session.subscribe(key)`,**
  which calls `open` *and* sends a `subscribe` message over the WS so the
  relay starts pushing bytes. The cascading `follow` callback in
  `registrySync(...)` is the content-driven sibling — subscribe-by-discovery
  via a watcher on a known repo's value (`home.flashcardsDecks`,
  `home.members`, etc.) instead of subscribe-by-explicit-call.

  *The lesson isn't that the API is mis-shaped — the split is real and useful
  (the registry needs a local-only path; the relay seed wants it).* The lesson
  is that **the right verb has a less-attractive name than the wrong one, and
  that gravity recurs.** The complete fix — making `open` retrieve-only,
  routing all creation through `subscribe` — is tracked under *Held for a
  major bump* in ROADMAP.md. Until that ships:

  **If your code calls `registry.open` directly and you are not the registry
  or the server-side seed, you are probably writing a bug.** Use
  `session.subscribe` or wire a `follow` cascade instead.
- **`onclick=${fn}` in h templates is a trap.** `attr=${fn}` is the *reactive
  cell* pattern: mount calls `fn(el)` on every render and assigns the **return
  value** to the attribute. For onclick this means the "handler" runs on every
  mount and `el.onclick` becomes `undefined`. **The fix is `handle`** from
  `h.js`: `onclick=${handle(fn)}` produces the right curry shape
  (`el => event => fn(event, el)`) without double-arrow noise. For no-args
  handlers: `onclick=${handle(() => doThing(id))}`. The journal app still
  uses the older `onclick=${() => fn}` double-arrow shim that predates
  `handle` — both work; `handle` reads better. **Event delegation** with
  `data-action` attributes on a single listener at the app container (see
  `public/apps/explorer/main.js`) is still the right call for genuinely
  large or uniform dynamic lists, but it's a separate tool — not the
  universal escape hatch from this footgun.
- **One Recaller per app.** A Recaller is meant to be the shared
  coordination point: data sources fire on it, views watch on it,
  the `(target, key)` NestedSet keeps unrelated subsystems from
  colliding. The streamo idiom: `new RepoRegistry(undefined, {
  recaller })` makes the default factory create Repos that *share*
  the recaller, so reading any repo's state inside a slot self-
  subscribes the slot. App UI state, async caches (verify), and
  toggle state (trees) each become their own `liveObject(target,
  { recaller })` — different targets, same recaller, no collisions.
  `defineComponent(name, fn, { recaller })` does the same for custom-
  element components: pass the app's Recaller and the component's
  cells compose with app state instead of isolating.
- **Function components without `data-key` fresh-mount on every parent
  re-render.** `<${MyComponent} ...prop=${x}/>` produces an HElement
  whose `tag` is a function. Mount's recycler matches by string tag
  or by `data-key`; a function tag with no key doesn't match the pool,
  so the existing DOM (and its watchers, focus, scroll, partial input)
  is torn down and the component is freshly invoked. Add `data-key=${id}`
  to the invocation to enroll it in recycling — the previous DOM
  survives, the function gets called with new props, attrs/children
  reconcile in place. **Rule of thumb: any function-component
  invocation that appears in a list, or whose inner DOM holds state,
  needs a `data-key`.**
- **Recycling-by-tag can mix semantically different elements.** Two
  `<input>` siblings in the same parent are interchangeable to mount
  unless they're keyed. If a re-render swaps `<input name="username">`
  for `<input class="new-todo">`, mount happily mutates the existing
  input's attrs in place — same DOM node, totally different meaning.
  Browser side-effects of "fresh insertion" (autofocus, password
  manager attribution) don't fire. **Add `data-key` whenever two
  semantically distinct elements share a tag in the same slot.**
- **Returning `false` from an `on*` handler is silent `preventDefault` —
  defanged by `handle()`.** Mount assigns event handlers as DOM Level 0
  properties (`el.onkeydown = fn`). Per HTML spec, if such a handler returns
  `false`, the browser treats it as `event.preventDefault()`. The trap
  surfaces when you write a short-circuit expression body like
  `e => e.key === 'Escape' && cancelEdit()` — for any non-Escape key, the
  expression evaluates to `false` and the handler returns it. On an
  `<input>`'s `onkeydown`, that prevents the character from being inserted;
  typing silently does nothing.
  **`handle()` from `h.js` dissolves this trap** — its wrapper has a
  block body (`event => { fn(event, element) }`) that discards the inner
  return value, so handle()-wrapped handlers always return `undefined`
  regardless of what your fn returns. *If you write event handlers
  through `handle()`, this footgun does not apply.* If you explicitly
  want `preventDefault`, call `event.preventDefault()`.
  *Older code using the `onclick=${() => fn}` double-arrow shim (e.g.,
  the journal app) is still vulnerable; for those, use a block body that
  returns `undefined`:* `e => { if (e.key === 'Escape') cancelEdit() }`.

## architecture notes

- `Streamo` — content-addressable codec. `set(value)→address`, `get(address)→value`,
  same value → same address. Decomposes structured values into reusable chunks; chunks
  reference each other by byte-offset address. Hash-chain (chainHash) folds over the byte
  stream; SIG chunks anchor it. Identity-blind — sign/verify take signer/pubkey as args.
- `Repo` — extends Streamo; every `set()` is a signed commit (message, date, dataAddress,
  parent, remoteParent?). Owns `makeRelayInboundStream` (trust+append for the
  receive-from-relay path, with a chain-hash-equality alignment check that catches the
  push-in-flight race), plus the reactive `conflictDetected` (local alignment failed)
  and `pushRejected` (the relay said no) flags. Paired with `RepoSerializer` on the
  relay side — the per-repo chain authority that atomically accepts or rejects
  incoming pushes against the current `committedChainHash`. Vocabulary:
  *fork* = new Repo with a lineage note; *branch* = an addressed-but-non-head value
  inside a Repo; *conflict* = the runtime "these bytes can't be appended" failure;
  *merge* = a commit citing prior values
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
  retired; `public/apps/chat/cli.js` is the terminal chat client
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
