# first steps with streamo

A guided tour from "I just heard about this" to "I have my own
signed fork of the homepage running on my machine." **One command.**
About five minutes (most of it credential derivation).

If you'd rather skim, the shape is:

1. **see it** — visit `streamo.dev` (or run a local relay)
2. **fork + serve** — one `npx` command makes you a signed identity
   and a copy on your machine
3. **edit** — files on disk; commits sign themselves
4. **find your fork** — paste your pubkey in the explorer; see the
   `remoteParent` chip pointing back at the original

---

## what streamo is, in a paragraph

Streamo is a peer-to-peer sync library where **no server holds
authority** over your data or your identity. Your keys are *derived*
from your username and password (no key files, no seed phrases, no
backup ritual) and every write is signed and append-only. The server
is a relay, not a gatekeeper. This walkthrough proves that by forking
the homepage of `streamo.dev` into a repo you own — same machinery,
just flipped from "consumer" to "author."

## prereqs

- **Node 20 or newer** — uses `node --test` and `fs/promises`.

## 1. see it running

Open https://streamo.dev/ in a browser — the homepage. Those bytes
are served from a signed repo, not from a static file. Then visit
https://streamo.dev/apps/explorer/ and click around. Under
"journalists" you'll find the `streamo-history` repo — the
project's git log replayed as a streamo, hundreds of signed
commits. Each commit clickable, each with the address of the
chunk that holds its value.

*If you'd rather run a local relay to fork from, clone this repo
and `npm install && npm run dev`. The command below works against
either `streamo.dev` or `localhost:8080`.*

## 2. fork + serve in one command

This is the fun part:

```bash
npx @dtudury/streamo \
  --name homepage \
  --username yourname \
  --merge-from streamo.dev \
  --merge-from-key files \
  --files ./mysite \
  --files-key files \
  --web 8081
```

You'll be prompted for a **password** (hidden input). This + your
username are the inputs to PBKDF2-SHA256 that deterministically
produce your secp256k1 keypair. Same inputs always produce the same
key, so re-running with the same credentials lands on the same
identity. (For a real deployment, use a real password — your
stream's signing authority depends on it.)

What happens on first run, in order:

1. **Derives your keypair** (PBKDF2 takes a few seconds)
2. **Opens `<datadir>/<your-pubkey>.bin`** via `archiveSync` (creates
   it if missing)
3. **Sees the repo is empty, runs `merge-from`** — fetches the
   `streamo.dev` home repo via HTTP, commits a pure-copy of its
   `files` value to your local repo with `remoteParent` cited
   automatically
4. **Mirrors the merged files to `./mysite/`** via `fileSync` (creates
   the directory if missing)
5. **Serves your fork at `http://localhost:8081/`**

Open that URL — that's **your** signed fork of the homepage. Same
content as `streamo.dev`, but every byte is signed by your keypair,
append-only on your chain.

*Re-running the CLI with the same flags is idempotent — the merge
step is skipped on subsequent runs because the repo already has
commits. Your own chain is the authoritative state from run 2
onward.*

## 3. edit it

Open `./mysite/index.html` in any editor. Change the tagline. Save.

`fileSync` sees the change, your repo gets a new signed commit, the
served bytes update. Reload `:8081` — your edit is live. You just
authored a commit on a streamo. Append-only history. Every peer
with your public key can sync your chain and verify every byte.

## 4. find your fork in the explorer

Back to https://streamo.dev/apps/explorer/. Scroll to "subscribe to
a key" and paste your public key (the CLI prints it in the info box
on startup). Subscribe. Your fork appears on `streamo.dev`'s
explorer — and your commit's `remoteParent` row has a chip-link
pointing back at the home repo's commit. Click it. **That's the
fork lineage**, visible and clickable across hosts.

---

## where to go from here

- **edit `./mysite/` freely** — each save is a new commit on your
  chain. Rename the title, rewrite the apps grid, replace the
  whole page. It's yours.
- **a worked scripting example** —
  [`scripts/fork-homepage.js`](./scripts/fork-homepage.js) does the
  same fork-and-cite operation via the `Repo.merge()` API directly,
  if you want to build your own onboarding/forking flows or see
  how the pieces fit together in Node code.
- **invite peers** — anyone who knows your public key can sync your
  chain over WebSocket. There's no signup, no friend graph; just
  the key.
- **read the design narrative** — [`design.md`](./design.md) walks
  the codebase end-to-end as a single coherent story. The reference
  shape from which streamo could be re-implemented in another
  language by one person in a weekend.
- **see what's next** — [`ROADMAP.md`](./ROADMAP.md) is
  forward-looking: open threads, known limitations, the longer view.

---

## what just happened, in one breath

Your password produced a keypair. The keypair authored a streamo.
The streamo's first commit was a pure-copy of someone else's
content, with a cryptographic citation back to where it came from.
You can now edit your authored content with file-on-disk
ergonomics, and the chain stays unbroken. *No server holds
authority over your data or your identity* — and you just proved
it by walking out the front door with a fork of the very page that
told you so.
