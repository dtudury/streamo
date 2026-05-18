<p align="center">
  <img src="https://raw.githubusercontent.com/dtudury/streamo/main/public/streamo.svg" alt="streamo" width="140">
</p>

# streamo

> every device is an equal author

Streamo is a peer-to-peer sync library built around a simple promise: **no server holds authority over your data or your identity.** The server is a relay, not a gatekeeper. Your keypair is your identity — derived from your credentials, not stored in a file. Your commit log is the source of truth, and every connected peer sees the same history.

> **New here?** → [**FIRST_STEPS.md**](./FIRST_STEPS.md) walks you from zero to your own signed fork of the homepage in one `npx` command (~5 minutes, no clone needed).

## why streamo?

You've probably noticed: every "simple app" you ship now requires a database, an auth provider, a hosting bill, a CDN, and an error-tracking subscription before it can do anything. The middleware tax keeps climbing. The substrate keeps getting more proprietary. The personal web — where "view source" was an education and *fork* was a verb people used — has been replaced by a tightly-coupled stack you rent.

Streamo is the substrate trying to grow back the other thing. It's small (the core fits in ~2k lines and reads in a sitting), local-first (your data lives on your devices, content-addressed), and structurally portable (your identity is derived from credentials; your data signs itself). It assumes **one author per stream** — which sidesteps most CRDT complexity — and treats the server as a relay, not a gatekeeper.

**Things you don't have to build when you use streamo:**

| Without it | With streamo |
|---|---|
| Signup, login, sessions, password reset, OAuth | Username + password → deterministic keypair (PBKDF2-SHA256). No accounts table. |
| API server + database + ORM | Signed append-only log. Bytes are content-addressed; dedup is structural. |
| WebSocket coordination, reconnect, last-write-wins | Built in. Relays just store and broadcast; clients verify on receipt. |
| File storage, CDN, access control | The log handles bytes. Any relay can serve them. Public key IS the address. |
| Backups + migrations | The log IS the backup, replayable on any relay or local archive. |
| Multi-device sync ceremony | Same credentials produce the same keypair everywhere. New device replays. |
| A backend, in many cases | A streamo "server" is dumb pipe (~50MB of RAM, one Node process). Run yours on the cheapest box you have. |

**Streamo fits if you…**

- want to ship a multi-user app without renting six SaaS subscriptions
- want a personal site you actually own — edit in place, fork freely, survive any hosting outage
- are building anything where "the data is mine" matters — health, finance, journals, family photos, civic infrastructure
- are integrating AI agents and want a substrate where a model is just another signed peer, not a special-cased API consumer (streamo doesn't distinguish humans from AIs — both author signed commits)
- miss when the web felt like a place you could build in instead of a platform you submit to

The protocol fits in [`design.md`](./design.md). The reference implementation could be re-implemented in another language by one person in a weekend — that's intentional. **Streamo isn't trying to be a platform. It's trying to be a primitive that lets a thousand platforms grow.**

## core ideas

- **No server holds authority** — the server is a relay; your data lives on your devices and can't be seized or censored. Disconnect the server and everything is still yours.
- **Your identity travels with you** — keys are derived with PBKDF2 from your username and password. Same credentials, same keypair, everywhere — no key files, no seed phrases, no backup ritual.
- **Every write is provably yours** — commits are signed with your keypair and append-only. History is permanent and can't be forged; peers reject unsigned or mis-signed data.
- **Content-addressed** — data is identified by what it is, not where it lives. The same value always lands at the same address; deduplication and diffing are structural.

## three ways to use streamo

There are basically three audiences. Pick the one that's you:

**1. As a library** — `npm install @dtudury/streamo` and import the pieces
you want. See the *javascript api* section below for what's exported.

**2. As a CLI** — `npx @dtudury/streamo --help` runs the streamo CLI
without cloning anything. You bring credentials, point at files or peers,
and get a personal streamo node. See the *cli* section.

**3. As a reference / contributor** — clone this repo, then:

```bash
npm install
npm run dev      # starts the all-in-one demo on port 8080
```

`npm run dev` runs the chat-room server (`public/apps/chat/server.js`) with
the checked-in dev credentials in `.env.dev`. That one server hosts the
homepage, chat app, **and** the repo explorer at `localhost:8080`. Modify
any file, refresh, see the change.

For production deployment, your real `.env.prod` lives only on the
production host, and `npm run prod` boots the same server against that
env.

`npm test` runs the test suite.

## cli

```bash
streamo \
  --name my-notes \
  --username alice \
  --files ./notes \
  --web 8080
```

Opens `notes/` for editing, syncs every save to all connected peers, and serves a browser UI at `http://localhost:8080`. All options can come from a `.env` file:

```bash
streamo --env-file .env
```

| env var | flag | description |
|---|---|---|
| `STREAMO_NAME` | `--name` | dataset name |
| `STREAMO_USERNAME` | `--username` | signing identity |
| `STREAMO_PASSWORD` | `--password` | signing password |
| `STREAMO_DATA_DIR` | `--data-dir` | archive directory (default `.streamo`) |
| `STREAMO_FILES` | `--files` | mirror local files |
| `STREAMO_FILES_KEY` | `--files-key` | mount file sync at `value[key]` (preserves sibling state) |
| `STREAMO_MERGE_FROM` | `--merge-from` | on first run only (empty repo), fork from this URL or host |
| `STREAMO_MERGE_FROM_KEY` | `--merge-from-key` | only incorporate this sub-key from the merge source (e.g. `files`) |
| `STREAMO_WEB` | `--web` | HTTP + WebSocket server port |
| `STREAMO_OUTLET` | `--outlet` | accept inbound peer connections |
| `STREAMO_ORIGIN` | `--origin` | connect to a remote outlet |
| `STREAMO_S3_BUCKET` | `--s3-bucket` | S3 bucket for replication |

### serving a site from a repo

If your streamo's value is (or contains) a flat path→content map, the
`--web` flag automatically serves those files over HTTP. Combined with
`--files`, this is **live-edit your public site**:

```bash
streamo \
  --name my-site \
  --username alice \
  --files ./public \
  --files-key files \
  --web 8080
```

Edit a file in `./public/`, save, and the served bytes update on the
next request. The streamo's signed commit log IS your site's history.
ETags are strong, derived from the content address — browsers cache
forever and re-fetch only when bytes change.

`--files-key files` mounts file sync at `value.files` so the same
streamo can hold sibling data (member list, journal entries, etc.)
without leaking onto the web. Drop the flag and the whole value is
the file tree.

HTML responses get an importmap injected that maps `@dtudury/streamo`
and `@dtudury/streamo/*` to the relay's `/streamo/` path. Your pages
can use bare-specifier imports and remain host-agnostic — a fork
served by another relay resolves them automatically.

### forking an existing site in one command

`--merge-from <url>` makes your first run a fork — on an empty repo,
the CLI fetches a snapshot from the named relay and commits a
pure-copy on your chain with `remoteParent` cited automatically.
Combined with `--files` and `--web`, **this is the all-npx
first-user experience**:

```bash
npx @dtudury/streamo \
  --name homepage \
  --username alice \
  --merge-from streamo.dev \
  --merge-from-key files \
  --files ./mysite \
  --files-key files \
  --web 8081
```

What happens on first run, in order:

1. Derives your keypair from `--username` + your password
2. Fetches `streamo.dev`'s home repo snapshot via HTTP
3. Commits a pure-copy of `value.files` to your local repo,
   `remoteParent` set
4. `fileSync` writes the merged files to `./mysite/` (creates it
   if missing)
5. Serves your fork at `http://localhost:8081/`

Subsequent runs skip the merge (the repo already has commits) —
your edits to `./mysite/` are the authoritative state, syncing as
signed commits the same way any other streamo content does.
`--merge-from-key` is optional; omit it to fork the whole upstream
value, not just one slice.

## javascript api

### Streamo — reactive append-only store

```js
import { Streamo } from '@dtudury/streamo'

const store = new Streamo()
store.set({ name: 'alice', score: 42 })
store.get('name')   // 'alice'
store.get('score')  // 42
```

Values are encoded with a self-describing codec (strings, numbers, dates, booleans, arrays, objects, `Uint8Array`). Same value → same bytes → same address; dedup is automatic.

### Repo — signed commit log

`Repo` wraps a `Streamo` so every `set()` becomes a commit — message, date, data address, and parent pointer. The raw commit log is what syncs over the wire.

```js
import { Repo } from '@dtudury/streamo'

const repo = new Repo()
repo.attachSigner(signer, 'my-dataset')  // auto-sign every commit
repo.set({ name: 'alice', messages: [] })
repo.get('name')      // 'alice'
repo.lastCommit       // { message: '', date: Date, dataAddress: n, parent: n|undefined }
[...repo.history()]   // newest-first iterator over commits
```

Signature chunks travel in the byte stream automatically — peers running `registrySync` or `originSync` verify every signature on receipt and reject data that doesn't match the repo's public key.

### Signer — deterministic identity

```js
import { Signer, bytesToHex } from '@dtudury/streamo'

const signer = new Signer('alice', 'my-password')
const { publicKey } = await signer.keysFor('my-dataset')
const publicKeyHex = bytesToHex(publicKey)   // stable identity for this (user, dataset) pair
```

Keys are derived with PBKDF2 so the same username + password always produces the same keypair. No key files to manage.

### RepoRegistry — multi-repo store

```js
import { RepoRegistry, Repo, archiveSync } from '@dtudury/streamo'

const registry = new RepoRegistry(async key => {
  const repo = new Repo()
  await archiveSync(repo, '.streamo', key)  // persist to disk
  return repo
})

const repo = await registry.open(publicKeyHex)
```

### RepoRegistry + your app's Recaller — one Recaller for everything

A `Recaller` is meant to be the shared coordination point: data sources
fire on it, views watch on it, the `(target, key)` namespace keeps
unrelated subsystems from colliding. Pass your app's `Recaller` to
`RepoRegistry` and the default factory creates Repos that share it —
reading any repo's state inside a reactive cell auto-subscribes the
cell. Iteration, `get(keyHex)`, and `size` all self-report too, so
slots that walk the registry auto-subscribe to new-repo opens.

```js
import { Recaller, RepoRegistry, h, mount } from '@dtudury/streamo'

const recaller = new Recaller('app')
const registry = new RepoRegistry(undefined, { recaller, name: 'app' })

mount(h`${() => {
  for (const [k, r] of registry) ...   // auto-subscribes to chunks + new repos
}}`, appEl, recaller)
```

For app-level state that isn't a repo (route, hover, tab selection),
use `liveObject` on the same `Recaller`:

```js
import { liveObject } from '@dtudury/streamo'

const state = liveObject({ atTab: 'value', hovered: null }, { recaller })
mount(h`${() => state.get('atTab')}`, el, recaller)  // auto-subscribes
state.set('atTab', 'storage')                          // fires the watcher
```

### registrySync — peer sync over WebSocket

```js
import { registrySync } from '@dtudury/streamo'

const session = await registrySync(registry, 'localhost', 8080, {
  // discovery cascades through content. The server's `hello` message
  // announces its home repo and we auto-subscribe; from there `follow`
  // walks each repo's value for related keys and subscribes to them.
  // Repos not reachable through that cascade never appear on the wire
  // unless explicitly subscribed by key (see `session.subscribe` below).
  follow: (keyHex, repo, subscribe) => {
    for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
  },

  // react to peer announcements
  onAnnounce: key => session.subscribe(key)
})

session.interest(rootKey)        // receive announcements for this topic
session.announce(myKey, rootKey) // tell interested peers about your repo
```

### h + mount — reactive UI

```js
import { h, mount, Recaller } from '@dtudury/streamo'

const recaller = new Recaller('app')

mount(h`
  <div class="card">
    <h2>${() => repo.get('name')}</h2>
    <p>${() => repo.get('bio')}</p>
  </div>
`, document.body, recaller)
```

Functions interpolated as `${() => ...}` are reactive cells — they re-run automatically whenever the data they read changes. Only the exact DOM nodes bound to changed data update. Elements with stable `data-key` are recycled across re-renders, and their descendants are reconciled in place by recursive data-key/tag matching — so DOM identity, document position, scroll state, focus, and any external attachments survive on every level. Static interpolations (`${value}`) refresh to the current value on each re-render. SVG namespaces propagate automatically — `` h`<svg><path d="..."/></svg>` `` works without any extra wiring. `class` accepts an array (`['btn', isActive && 'active']`) or an object (`{btn: true, active: false}`); falsy entries are filtered out.

> **For lists that can reorder**, always set `data-key` on each item — the unkeyed positional fallback will recycle elements by tag in document order, which can attach the wrong DOM node (and any user focus/input on it) to the wrong vnode after a reorder.

Any function can be used directly as a tag — it receives `{ ...attrs, children }` and returns virtual nodes:

```js
// StreamoComponent extends HTMLElement, so it's only importable in a browser context:
import { StreamoComponent, componentKey, defineComponent } from '@dtudury/streamo/StreamoComponent.js'

function Card ({ title, children }) {
  return h`<div class="card"><h2>${title}</h2>${children}</div>`
}

mount(h`<${Card} title="Hello"><p>hi</p></${Card}>`, document.body, recaller)
```

For hot-reloading, `componentKey(prefix, address)` and `defineComponent(name, fn)` pair a content address to a unique custom element name. A new file version gets a new name; stale elements are naturally orphaned and cleaned up without any explicit bookkeeping.

## sync backends

| module | what it does |
|---|---|
| `archiveSync` | persist chunks to numbered binary files under `.streamo/archive/` |
| `fileSync` | mirror a repo's value to/from the local filesystem (respects `.gitignore`) |
| `outletSync` | WebSocket server — accepts inbound peer connections |
| `originSync` | WebSocket client — connects to a remote outlet |
| `webSync` | HTTP + WebSocket server with browser-ready assets |
| `s3Sync` | replicate chunks to S3-compatible object storage |
| `stateFileSync` | write repo state as JSON on every change |

## what `npm run dev` actually starts

The chat-room server. It's the all-in-one demo: the homepage, chat app,
and repo explorer are all served by the same process on port 8080. The
"server" is just another streamo node — it holds the room's member list
in its own repo and auto-accepts anyone who announces to it. Its public
key is the room address. No special authority, no hidden state.

The homepage you land on is **served from the relay's own home repo**
(`files` key). `public/homepage/` is mirrored to/from that key by
`fileSync` — edit a file there and your change becomes a signed
commit; the next HTTP request serves the new bytes. The same streamo
multiplexes four concerns on one stream: `members` (chat), `entries`
(journal), `journalists` (entry sources), and `files` (the homepage).

Useful URLs once it's running:

- `http://localhost:8080/` — homepage with app cards
- `http://localhost:8080/apps/chat/` — chat
- `http://localhost:8080/apps/explorer/` — repo explorer (leave it open in
  another tab to watch commits roll in as you chat)

To join chat from a terminal instead of the browser:

```bash
node public/apps/chat/cli.js alice secret localhost 8080
```

Each participant owns their own message stream. Same data structure,
different transport.

## tests

```bash
npm test                                 # all tests
node --test public/streamo/Repo.test.js  # single file
```

## roadmap

See [ROADMAP.md](./ROADMAP.md) for what's been built and what's next.

## philosophy + honest trades

Streamo makes specific trades — small core, zero build, no type system,
no editor support, an idiosyncratic style. Some you'll love, some will
rub. [PHILOSOPHY.md](./PHILOSOPHY.md) is the honest record: what you pay,
what you get, and what's coming that would soften the costs. Read it
before you decide streamo is for you (or that it isn't); we want the
choice to be made with eyes open.

## collaboration

Built with significant AI collaboration via [Claude Code](https://claude.ai/code). Human-directed; Claude is a co-author and contributor, not an autonomous builder.

## license

AGPL-3.0-only
