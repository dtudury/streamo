# first steps with streamo

A guided tour from "I just heard about this" to "I have my own signed
fork of the homepage running on my machine, and I can edit it." Five
commands. Ten minutes.

If you'd rather skim, the shape is:

1. **clone, install, run** — the streamo "all-in-one" demo
2. **look around** — homepage + explorer
3. **fork** — one command makes you a signed identity and a copy
4. **serve** — your fork is now a website on your machine
5. **edit** — files on disk; commits sign themselves

---

## what streamo is, in a paragraph

streamo is a peer-to-peer sync library where **no server holds
authority** over your data or your identity. Your keys are *derived*
from your username and password (no key files, no seed phrases, no
backup ritual) and every write is signed and append-only. The server
is a relay, not a gatekeeper. This walkthrough proves that by forking
the homepage of a relay into a repo you own — same machinery, just
flipped from "consumer" to "author."

## prereqs

- **Node 20 or newer** — uses `node --test` and `fs/promises`.
- **git** — to clone the repo.

## 1. clone, install, run the demo

```bash
git clone https://github.com/dtudury/streamo.git
cd streamo
npm install
npm run dev
```

`npm run dev` boots the "all-in-one" demo: an HTTP + WebSocket relay
that hosts the homepage, chat app, and repo explorer on the same
port. The signing credentials it uses are in `.env.dev` (checked in;
not the production ones). Your terminal will show something like:

```
[chat] room key:    0291eb29…ccfe6
[chat] history key: 0384269…0fd098 (231 commits)
[chat] serving on http://localhost:8080/apps/chat/
[chat] mirroring homepage: …/public/homepage ↔ home.files
```

## 2. look around

Open these in your browser:

- `http://localhost:8080/` — **the homepage.** What you're seeing is
  served from the relay's signed repo, not from disk directly. The
  `public/homepage/` directory on disk and the repo's `files` key are
  kept in sync by `fileSync`; either edit propagates to the other.
- `http://localhost:8080/apps/explorer/` — **the repo explorer.**
  Click around. The home page card at the top is the relay's home
  repo. Under "journalists" is `streamo-history` — a streamo whose
  commit chain *is* the project's git history (231 signed commits as
  of writing). Click in; click any commit; see the value, the parent
  pointer, the byte address. This is what streamo's content-addressed
  log actually looks like.

## 3. fork the homepage

This is the fun part. You're going to create your own signed
identity, fork the homepage you just looked at, and commit a record
that cites the original — all in one command.

Make sure `npm run dev` is still running, then in *another terminal*:

```bash
npm run fork-homepage
```

You'll be prompted for a **username** and **password**. These can be
anything you like — they don't go anywhere, they're not "accounts."
They're the inputs to PBKDF2-SHA256 that deterministically produce
your secp256k1 keypair. Same inputs always produce the same key, so
if you forget, just run it again with the same username + password.
(For a real deployment, use a real password — your stream's signing
authority depends on it.)

The script will:

1. Derive your keypair (PBKDF2 takes a few seconds)
2. Fetch the relay's homepage bytes
3. Make your **first signed commit** — a *pure-copy fork* of the
   homepage with `remoteParent` set to the relay's commit you're
   forking. The commit has no local parent (it's your first) and a
   cryptographic footnote pointing at where you started.
4. Save your repo to `.streamo-fork/<your-pubkey>.bin`
5. Print the exact command to serve your fork

## 4. serve your fork

Paste the command the script printed. It'll look like:

```bash
npx @dtudury/streamo \
  --name "homepage" \
  --username "your-username" \
  --data-dir ".streamo-fork" \
  --files "./my-streamo-files" \
  --files-key files \
  --key-iterations 100000 \
  --web 8081
```

(While exploring locally, you can substitute `node bin/streamo.js`
for `npx @dtudury/streamo` to skip the install.)

On first run, the CLI creates `./my-streamo-files/` and writes your
forked homepage there — `fileSync` is moving bytes from your repo
*onto disk* because your repo is the source of truth and the
directory is empty.

Now open `http://localhost:8081/` — that's **your** signed fork of
the homepage. Identical content to the relay's, but every byte is
signed by your keypair, append-only on your chain.

## 5. edit your fork

Open `./my-streamo-files/index.html` in any editor. Change the
tagline. Save.

Watch the terminal — `fileSync` sees the change, your repo gets a
new signed commit, the served bytes update. Reload `:8081` — your
edit is live.

You just authored a commit on a streamo. Append-only history. Every
visitor with the right public key can sync your chain and verify
every byte.

## 6. find your fork in the explorer

Back to `http://localhost:8080/apps/explorer/` (the *original*
relay's explorer). Scroll to "subscribe to a key" and paste your
public key (the long hex string the fork-homepage script printed).
Click "subscribe." Your fork's commit appears on this relay's
explorer too — you've taught the original relay about your fork's
existence.

Click into your fork's at-view. You'll see your fork commit, with
its `remoteParent` row pointing back at the home repo's commit. Click
the chip — the explorer navigates to the cited commit on the other
chain. **That's the fork lineage**, visible and clickable.

---

## where to go from here

- **edit `./my-streamo-files/` freely** — each save is a new commit
  on your chain. Rename the title, change the apps grid, rewrite the
  ideas, replace the whole page. It's yours.
- **invite peers** — anyone who knows your public key can sync your
  chain over WebSocket. There's no signup, no friend graph; just the
  key.
- **read the design narrative** — [`design.md`](./design.md) walks
  the codebase end-to-end as a single coherent story. It's the
  reference shape from which streamo could be reimplemented in
  another language.
- **see what's next** — [`ROADMAP.md`](./ROADMAP.md) is forward-
  looking: open threads, known limitations, the longer view.

---

## what just happened, in one breath

Your password produced a keypair. The keypair authored a streamo. The
streamo started with a citation to someone else's value. You can now
edit your authored content with file-on-disk ergonomics, and the
cryptographic chain stays unbroken. *No server holds authority over
your data or your identity* — and you just proved it by walking out
the front door with a fork of the very page that told you so.
