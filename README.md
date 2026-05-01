# streamo

> every device is an equal author

Streamo is a content-addressed, cryptographically signed, peer-to-peer sync library. There is no central server — your keypair is your identity, your commit log is the source of truth, and every connected peer sees the same history.

## core ideas

- **Content-addressed** — data is identified by what it is, not where it lives. The same value always lands at the same address; deduplication and diffing are free.
- **Signed** — every write is authenticated with a secp256k1 keypair derived from your username and password. Peers reject unsigned or mis-signed data.
- **Append-only** — history is never rewritten. Every commit is permanent and verifiable.
- **P2P sync** — repos replicate over WebSocket. The server is just another peer; disconnect it and the data is still yours.

## install

```bash
npm install streamo
```

Or run the CLI directly:

```bash
npx streamo --help
```

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
| `STREAMO_WEB` | `--web` | HTTP + WebSocket server port |
| `STREAMO_OUTLET` | `--outlet` | accept inbound peer connections |
| `STREAMO_ORIGIN` | `--origin` | connect to a remote outlet |
| `STREAMO_S3_BUCKET` | `--s3-bucket` | S3 bucket for replication |

## javascript api

### Streamo — reactive append-only store

```js
import { Streamo } from 'streamo/public/streamo/Streamo.js'
import { Recaller } from 'streamo/public/streamo/utils/Recaller.js'

const store = new Streamo()
store.set({ name: 'alice', score: 42 })
store.get('name')   // 'alice'
store.get('score')  // 42
```

Values are encoded with a self-describing codec (strings, numbers, dates, booleans, arrays, objects, `Uint8Array`). Same value → same bytes → same address; dedup is automatic.

### Repo — signed commit log

`Repo` wraps a `Streamo` so every `set()` becomes a commit — message, date, data address, and parent pointer. The raw commit log is what syncs over the wire.

```js
import { Repo } from 'streamo/public/streamo/Repo.js'

const repo = new Repo()
repo.set({ name: 'alice', messages: [] })
repo.get('name')      // 'alice'
repo.lastCommit       // { message: '', date: Date, dataAddress: n, parent: n|undefined }
[...repo.history()]   // newest-first iterator over commits
```

### Signer — deterministic identity

```js
import { Signer } from 'streamo/public/streamo/Signer.js'
import { bytesToHex } from 'streamo/public/streamo/utils.js'

const signer = new Signer('alice', 'my-password')
const { publicKey } = await signer.keysFor('my-dataset')
const publicKeyHex = bytesToHex(publicKey)   // stable identity for this (user, dataset) pair
```

Keys are derived with PBKDF2 so the same username + password always produces the same keypair. No key files to manage.

### RepoRegistry — multi-repo store

```js
import { RepoRegistry } from 'streamo/public/streamo/RepoRegistry.js'
import { archiveSync } from 'streamo/public/streamo/archiveSync.js'

const registry = new RepoRegistry(async key => {
  const repo = new Repo()
  await archiveSync(repo, '.streamo', key)  // persist to disk
  return repo
})

const repo = await registry.open(publicKeyHex)
```

### registrySync — peer sync over WebSocket

```js
import { registrySync } from 'streamo/public/streamo/registrySync.js'

const session = await registrySync(registry, 'localhost', 8080, {
  // only sync repos you care about
  filter: key => key === rootKey,

  // follow links embedded in repo data (content-driven discovery)
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
import { h } from 'streamo/public/streamo/h.js'
import { mount } from 'streamo/public/streamo/mount.js'
import { Recaller } from 'streamo/public/streamo/utils/Recaller.js'

const recaller = new Recaller('app')

mount(h`
  <div class="card">
    <h2>${() => repo.get('name')}</h2>
    <p>${() => repo.get('bio')}</p>
  </div>
`, document.body, recaller)
```

Functions interpolated as `${() => ...}` are reactive cells — they re-run automatically whenever the data they read changes. No virtual DOM diffing; only the exact DOM nodes bound to changed data update.

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

## chat example

```bash
# start the server
node public/streamo/chat-server.js 8080

# join from the browser
open http://localhost:8080

# join from the terminal
node public/streamo/chat-cli.js alice secret localhost 8080
```

Each participant owns their own message stream. The server holds only a root repo listing members; it has no special authority over anyone's data.

## tests

```bash
node --test                              # all tests
node --test public/streamo/Repo.test.js  # single file
```

## license

AGPL-3.0-only
