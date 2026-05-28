# demo script — Rick

_~2026-05-28 (adjust to actual date). Rick = early Microsoft + Adobe
engineer; senior, taste-driven, not currently shopping for tools, not
on the AI hype train. This is also practice for tougher future audiences;
the goal is "honest engineer-to-engineer tour of what streamo is and
why it's small on purpose," not a sales pitch._

---

## cheatsheet

| # | Phase | ~Min | Concrete move | Anchor phrase |
|---|-------|------|---------------|---------------|
| 1 | **substrate** | 3 | edit a file in `public/homepage/`, refresh, find the commit in the explorer | _"this page IS a Record"_ |
| 2 | **fork** | 5 | `npx @dtudury/streamo --merge-from streamo.dev ...` | _"no clone, no signup, no key file"_ |
| 3 | **collaboration** | 5 | two-tab chat → throttle one offline → write in both → bring online → recovery banner → send | _"recovery uses the same primitives as everything else"_ |
| 4 | **the story** | 2 | PHILOSOPHY.md trades, ~2k LOC, repo-free relay | _"a primitive that lets a thousand platforms grow"_ |
| 5 | **Q&A** | — | listen + see prep below | (be honest about trades) |

**One detail worth holding onto for any phase:** the relay running
streamo.dev is literally `npx @dtudury/streamo` in relay-only mode —
the **same binary** Rick is about to run on his laptop in Phase 2,
just different flags. No source code on the prod box, no deploy
script, no custom server. That's the architectural punchline; weave
it in wherever it lands.

**If you lose your place:** the demo is "you can read what I built, fork
it in one command, collaborate on it, recover from conflicts" — in that
order. Whichever phase is next, return to it. Skip phase 4 if running
long; it's optional and lives in PHILOSOPHY.md anyway.

**If something breaks live:** see [if it breaks](#if-it-breaks) at the
bottom. Default move: open a fresh incognito tab; second-default: switch
to localhost (your machine is reliable in a way live relays aren't).

---

## setup — before Rick arrives

**Tabs to pre-open in one browser window:**

1. `https://streamo.dev/` — homepage
2. `https://streamo.dev/apps/explorer/` — explorer
3. `https://streamo.dev/apps/chat/` — chat (one)
4. (Second window or new tab when needed) chat again — for phase 3

**Terminal panes ready:**

1. Local streamo checkout (`~/Documents/repos/streamo`), on `main`, clean
   working tree, dev server NOT running (so we can show the prod site)
2. **Author process running.** Since 10.1.0, streamo.dev is relay-only —
   the prod box holds no signing creds. For Phase 1's "edit → refresh →
   see live" to work, your laptop has to be the signer. Run before
   Rick arrives, in its own pane:

   ```bash
   node bin/streamo.js \
     --name streamo \
     --username streamo-relay \
     --files ./public/homepage \
     --origin streamo.dev \
     --data-dir ~/.streamo-prod-author
   ```

   Type the relay password at the hidden prompt. Wait for `mirroring
   files: …` and `origin: connected to streamo.dev` before showing
   Rick anything. Leave it running through the whole demo.
3. A pane in `~/Desktop/rick-demo-site/` or similar — empty directory
   ready for the `npx` fork. Pre-make it so you don't fumble `mkdir`
   live: `mkdir -p ~/Desktop/rick-demo-site`

**Pre-check (5 min before):**

```bash
curl -sf https://streamo.dev/api/info        # confirms relay is up
curl -sf https://streamo.dev/                # confirms homepage serves
```

If either fails, see [if it breaks](#if-it-breaks).

**Mental warmup:** read Phase 4 once. The numbers stick easier as a recall
cue than as a memorize.

---

## phase 1 — the substrate (~3 min)

**The point:** "This isn't a website with a backend. It's a Record on
disk, served as bytes, signed by my keypair. The relay doesn't even
*hold* the signing key — my laptop signs, my laptop pushes the bytes
over a WebSocket, the relay just archives and serves."

### the moves

1. **Pull up streamo.dev in the browser.** Let Rick see the homepage for
   a beat. _"This is the project's homepage. Everything you see — text,
   links, the journal entries below — lives in a single signed
   append-only log."_
2. **In your terminal, edit `public/homepage/index.html`.** Tiny visible
   change (a typo fix, a sentence tweak — pre-pick one so you don't
   freeze). Save.
3. **Refresh the browser.** Show the change live.
   _"My laptop just signed those bytes and pushed them to the relay
   over a WebSocket. The relay archived them. You're reading the new
   bytes now. No build step, no CDN cache to bust, no deploy."_
4. **Switch to the explorer tab. Find your commit.** It'll be at the top
   of the home Record's commit list. Click it.
   _"Here's the byte-level reality. That's a SIGNATURE chunk — 97 bytes,
   secp256k1. That's the COMMIT envelope. That's the data."_

### if Rick interrupts

- **"Wait, you can just edit it?"** — Yes. My laptop is running
  `bin/streamo.js` in author mode — it watches `public/homepage/`,
  signs every save as a commit, and origin-syncs the bytes to
  streamo.dev. Any disk save becomes a signed commit, live.
- **"What stops anyone else from editing it?"** — They can't sign as me.
  My credentials → my keypair → my signatures. Anyone else's edit fails
  the relay's chain check.
- **"Where's the signing key on streamo.dev?"** — It isn't. The prod
  relay is `npx @dtudury/streamo` in *relay-only* mode — opens the
  Record by pubkey, no signer derived. The signing only happens
  here, on my laptop. The relay is a dumb pipe by construction.

### exit cue

When Rick has seen one commit in the explorer, move to Phase 2.

---

## phase 2 — the fork (~5 min)

**The point:** "Identity is derived from credentials. Forking is one
command. There's no signup flow."

### the moves

1. **Switch to your second terminal pane** (in `~/Desktop/rick-demo-site/`
   or wherever).
2. **Run the all-`npx` fork command.** Type it out so Rick sees it:

   ```bash
   npx @dtudury/streamo \
     --name homepage \
     --username rick \
     --merge-from streamo.dev \
     --merge-from-key files \
     --files ./mysite \
     --web 8081
   ```

   It'll prompt for a password — type anything memorable (Rick can pick
   one if he wants).

3. **What happens, narrated:**
   _"PBKDF2 just derived a keypair from 'rick' plus the password. That's
   Rick's streamo identity, deterministic, no key file. Now it's fetching
   a snapshot of streamo.dev's home Record via HTTP. Now it's committing
   a pure copy to Rick's local chain with `remoteParent` set to my key —
   that's the lineage citation. Now it's writing the merged files to
   `./mysite/`."_
   *(And, parenthetically: the binary doing this is the SAME binary the
   prod relay is running — different flags, same code. We just installed
   streamo.dev on your laptop.)*

4. **Open `http://localhost:8081/` in a new browser tab.**
   _"That's Rick's fork. Same homepage, served from his Record, signed
   by his keypair."_

5. **Edit a file in `./mysite/` from your terminal** (e.g. the headline
   text). Refresh `localhost:8081`. Show it changed.
   _"Rick is the author of his fork. His edits are signed by his key,
   not mine. The relationship between his fork and mine is the
   `remoteParent` citation — informational, not a sync dependency. He
   could disconnect from streamo.dev forever and his fork still works."_

### if Rick asks

- **"How is `username` not already taken?"** — No central registry. The
  keypair IS the identity. Two different passwords give two different
  keypairs even with the same username; collision risk is the
  cryptographic floor.
- **"What if I pick a weak password?"** — Your keypair is as good as
  your password. We don't store it; we don't enforce strength; the user
  has the agency a strong password buys them.
- **"Where are the bytes?"** — Local: `./.streamo/<keyhex>.bin`. Just
  bytes; you can `wc -c` it, you can `scp` it to another machine and
  resume. The relay (streamo.dev) doesn't have Rick's fork until he
  pushes via `--origin streamo.dev`. (Show that command optionally
  but maybe not — keeps the demo focused.)
- **"How fast is this?"** — Path-aware reads are O(depth), not
  O(record). The library Record streamo.dev serves is ~530KB; a
  per-request file lookup is ~6ms decoded. The homepage loads as a
  ~360ms waterfall, not because the server is doing nothing — the
  codec walks chunk graphs and only decodes the leaf the URL asks
  for. Worth mentioning if Rick is tracking the latency feel.

### exit cue

When Rick's `localhost:8081` shows an edit, move to Phase 3.

---

## phase 3 — the collaboration (~5 min)

**The point:** "Multi-device sync is built in. When it goes wrong — two
devices write at once — there's a real recovery flow, not just data
loss."

### the moves

1. **Two browser tabs on `https://streamo.dev/apps/chat/`.** Log in to
   both as the same user (e.g. `alice` / a memorable password).
2. **Type a message in tab A.** Show it appears in both tabs.
   _"Each participant owns their own signed message stream. Both tabs
   are alice; they're writing to the same Record via the same keypair."_
3. **DevTools → Network → set Tab B to Offline (or Throttling: Offline).**
   _"Tab B is now disconnected. The relay can't see Tab B's writes."_
4. **Type a message in Tab A** — call it "apple". Show it appears in Tab A
   only. Tab B is still showing the old state.
5. **Type a message in Tab B** — call it "banana". Tab B shows it locally
   (it's signed and stored in browser memory), but the relay doesn't know.
6. **Throttle Tab B back to Online.**
   _"Now Tab B reconnects. The relay has 'apple' on its authoritative
   chain. Tab B has 'banana' as a local-only commit. The chains have
   diverged."_
7. **The recovery banner appears on Tab B:**
   `your last write didn't reach the room. [send it now] [discard]`
   _"This is the recovery UX. Without it, the only option would be
   'refresh and lose what you wrote.' The detection lives in the
   substrate — the relay's per-Record serializer is the chain
   authority; the rejection comes back as a reactive flag the app
   binds to. Same primitives as any other UI signal."_
8. **Click [send it now].** Show both tabs converge — the message list now
   contains both `apple` and `banana`, in timestamp order.
   _"The merge is app-specific — chat concatenates message lists and
   dedupes by timestamp. The library exposes the rejected-data address;
   the app decides what to do with it."_

### if Rick asks

- **"What if both write the same key while offline?"** — Same flow.
  Tab B's recovery sees Tab A's accepted state, merges B's writes on
  top. If the merge produces duplicates (impossible here because of the
  `at` timestamp), the app's merge function decides.
- **"What about three devices?"** — Same shape. The relay's serializer
  is the single chain authority per Record; first arriver extends the
  top, later arrivers' pushes get rejected and recover.
- **"What if I want a real CRDT?"** — One author per stream sidesteps
  CRDT complexity by design. Multi-author values live in CRDTs we don't
  re-implement; if you need them, build them on top of streamo as a
  separate layer.

### exit cue

When both tabs show both messages and Rick has seen the recovery work,
move to Phase 4 (or to Q&A if running long).

---

## phase 4 — the story (~2 min, conversational)

**The point:** "Streamo is small on purpose. It's a primitive, not a
platform."

### what to surface

- **~2k LOC core, readable in a sitting.** `design.md` walks the modules.
- **Identity from credentials.** No accounts table. No signup. No
  password reset (because there's nothing to reset against — your
  credentials derive your key directly).
- **Repo-free relay.** The prod relay is `npx @dtudury/streamo` —
  no source code on the box, no checkout, no deploy script. The
  systemd unit pins a version; bumping is one `sed` + restart.
  The relay *cannot write* to the Records it serves; it holds no
  signing creds. Signing keys live with authors, never with the
  relay. That's "the server is a relay, not a gatekeeper" extended
  all the way down to the file system.
- **One author per stream.** Sidesteps CRDT complexity by design.
- **Honest trades documented.** PHILOSOPHY.md is the welcome-the-skeptics
  doc: small core, no build step, no type system, no editor support
  yet, idiosyncratic style. We name what you pay.

### the line

_"It's not trying to be a platform. It's trying to be the primitive that
lets a thousand platforms grow."_

That's your closer. Use it if you can; skip if you can't.

---

## Q&A prep

Anticipated questions, with honest answers (and pointers to the docs
that go deeper):

### "How does this compare to git / IPFS / Hyperdrive / Dat?"

- **Git**: streamo is git-shaped in spirit (signed, append-only,
  content-addressed) but isn't trying to be a source-control system.
  It's a sync substrate. The "one author per stream" assumption is the
  thing git doesn't make.
- **IPFS / Hyperdrive / Dat**: those projects share the
  content-addressed instinct. Streamo's trade is to be small enough to
  re-implement in a weekend, and to NOT try to solve multi-author
  values via CRDTs at the substrate layer.

### "What about the CAP theorem?"

We choose C+A within a single chain (the relay is the single chain
authority; writes are atomic; partition tolerance is bounded by the
client experience — partitioned clients see local state, can't push,
get rejection-and-recovery on rejoin). The "one author per stream"
constraint is what makes this clean.

### "What's the attack model?"

- A relay can refuse to serve, but can't lie undetectably (signed
  commits; clients verify on receipt, or trust the relay's chain check
  for the upward path).
- A peer without the private key can't forge signatures. Recovery from
  a compromised key is a hard problem we don't solve at the substrate
  — the user's credentials are the trust anchor.
- PBKDF2-SHA256 with 100k iterations is the key derivation. Standard
  floor; not novel; pinned by KAT in `Signer.test.js`.

### "How big can a Record get?"

Practical caps live in ROADMAP "known limitations":
- ~2 MB feels instant; right default for chat-shaped apps
- ~5–10 MB is comfortable for journal/notes
- ~50 MB+ wants different infrastructure
Lifecycle (not yet implemented): when a Record approaches its cap, the
author starts a successor Record with the same keypair, signs a
`successor` pointer at the end of the old one. Bounded per-Record,
unbounded total.

### "How would I deploy this?"

There's no deploy script. You provision a box, install node, put
your VAPID + home pubkey in a `.env` file, and write a one-line
systemd unit:

```
ExecStart=npx -y @dtudury/streamo@<version> --env-file /path/to/.env
```

No git clone, no source code, no build step. Bumping a version is
editing the unit and restarting. Streamo.dev runs on a single
Hetzner box, ~50MB RAM idle, behind Caddy for TLS. The full setup is
in `DEPLOY.md` (linked from the README). Forks who prefer a checkout-
based deployment can still use the legacy `scripts/deploy.sh`; it's
preserved in the repo for that use case.

### "Is this AI-generated?"

Honest answer: built with significant Claude collaboration; not
autonomously generated. The code is small enough that both of us read
it. AGPL-licensed; co-author noted in commits. (Skip if Rick doesn't
ask — don't lead with it.)

### "What's the business model?"

There isn't one. It's a primitive, AGPL-licensed, intended to be the
substrate other things build on. Hosting your own relay is the "self-
deploy" answer; you don't need streamo.dev to use streamo.

### "Why isn't there an editor / type system / linter?"

Working on it; PHILOSOPHY.md has the welcome-the-skeptics list with
specific bounded thing-you-could-build contributions. The current
project is small enough that the absence is annoying but bounded.

---

## if it breaks

The demo gods are real. Have these escape hatches ready.

### "streamo.dev returns 500 / connection refused"

- Pull up the relay log via your terminal:
  `ssh streamo@streamo.dev "sudo journalctl -u streamo -n 30"`
- If it's down, the demo can pivot to **localhost-only mode**: start
  `npm run dev` in your local checkout, run the demo against
  `http://localhost:8080` instead. Phase 1's "edit, save, refresh"
  works identically locally.

### "browser shows stale JS after a deploy"

- Open the demo tabs in **Incognito / Private Browsing**. Guaranteed
  fresh fetch. Do this proactively for the demo — no cache surprises.

### "the recovery banner doesn't appear / takes too long"

- The 400ms settle window is crude. If the banner is slow, *wait* —
  don't panic-click. Narrate the wait: _"the client is re-syncing with
  the relay; this is one of the rough edges still on the road map."_
- Honesty beats theater.

### "the `npx` command fails / npm registry slowness"

- Have the streamo CLI pre-installed globally too:
  `npm install -g @dtudury/streamo`. If npx is slow, fall back to
  `streamo --name homepage ...`.

### "two-tab conflict doesn't show the banner"

- Maybe the throttle didn't actually take effect. Check Network panel:
  the "online" state should say "Offline" when throttled.
- If it still doesn't work, **switch to a manual disconnect**:
  `wifi off` for ~10s, type, `wifi on`. Slower but reliable.

### "Rick has a question I don't know the answer to"

- _"Honest answer — I don't know off the top of my head. Let me check
  after."_ Then actually check after.
- Don't bluff. Rick will catch it; the demo will lose more credibility
  from one bluff than from three "let me check"s.

---

## alternate demo path — incremental local cascade

_A different shape of demo, fully local, no streamo.dev dependency. Tells
the "build the substrate up from nothing, one Record at a time" story —
useful when the audience wants to see the federation cascade explicitly,
or when streamo.dev is unreachable, or as a follow-up after the main
script to show the same architecture from a different angle._

Setup committed in `1604a3d` (`.env.demo.*` files + `demo:*` npm scripts +
`public/demo-homepage/`). All four processes use demo/demo/1-iteration
credentials; toy creds, no real secrets in the env files.

### the flow — 4 terminals

```sh
# Terminal 1 — empty relay on 8081
npm run demo:relay
# Browser → http://localhost:8081 → 404 everywhere
# "There's a relay listening, but nothing's authored anything yet.
#  The relay holds no content of its own. It's a mirror waiting for
#  someone to push bytes."

# Terminal 2 — homepage author
npm run demo:homepage
# Watches public/demo-homepage/, signs commits, pushes to relay
# Browser refresh → homepage HTML loads, /streamo/*.js still 404
# "My laptop signed those bytes and pushed them. The relay archived
#  them and now serves them. But the homepage's <script> tags want
#  /streamo/h.js, and nobody's authored the library Record yet — so
#  those 404."

# Live edit: change public/demo-homepage/index.html or streamo.json
# fileSync sees the save, signs a new commit, pushes
# Browser refresh → change visible
# "Edit on disk → signed commit → relay archive → browser sees it.
#  Same shape as Phase 1 of the main demo, but the substrate is
#  literally on this laptop."

# Terminal 3 — library author
npm run demo:library
# Watches public/streamo/, pushes the streamo JS library as a Record
# Browser refresh → /streamo/*.js resolves, page comes alive, but
# /apps/explorer/ link 404s
# "The homepage's mounts table said 'for /streamo/, ask Record X.'
#  Record X just came online. The explorer mount is still empty."

# Terminal 4 — explorer author
npm run demo:explorer
# Watches public/apps/explorer/, pushes
# Browser refresh → full explorer loads (with this morning's
# commit-wheel work — clickable commit selector)
# "The substrate just assembled itself from four independently-signed
#  Records. No deploy. No coordinated rollout. Each piece is its own
#  signed chain authored by a separate process; the homepage's mounts
#  table is the glue."
```

### what to expect along the way

- **Turtle log torrents** in each terminal (STREAMO_VERBOSE=trace in the
  env files) — visible evidence of byte-level wire activity. Each
  arrow is a chunk crossing the WebSocket. Demo magic, optional to
  narrate.
- **The page will look unstyled.** The homepage's HTML references
  `/apps/styles/proto.css`, which isn't in the demo's mount table.
  That 404 is *part of the narrative* — *"every piece of this page is
  independently addressable; I just haven't authored the styles
  Record yet."* If you'd rather have styles, clone `.env.demo.explorer`
  → `.env.demo.styles` with `STREAMO_FILES=public/apps/styles` and a
  fifth `demo:styles` script.
- **Port 8081** for the whole thing — independent of `npm run dev`'s
  8080, so you can have both running simultaneously without conflict.

### the bytes on disk

Each demo process has its own data dir under repo root:
- `.streamo-demo-relay/` — relay's archive of received bytes
- `.streamo-demo-homepage/` — homepage author's local archive
- `.streamo-demo-library/` — library author's local archive
- `.streamo-demo-explorer/` — explorer author's local archive

After a demo run, `wc -c .streamo-demo-relay/*.bin` shows the
literal byte count of each Record on disk. Worth showing if Rick
asks *"where is this?"* — point at the file, run `wc`, that's it.
The relay is just an archive of signed bytes that arrived over a
WebSocket.

### caveats

- **Order matters.** Start the relay first; it has to be listening
  before the authors can push.
- **demo/demo credentials with 1 PBKDF2 iteration** — toy keys,
  deterministic, fine to commit. Anyone running these commands on
  any machine gets the same pubkeys. Real production identities use
  100,000 iterations + real passwords.
- **No `--peer streamo.dev`.** The demo cascade is fully local; the
  relay never reaches out. Browsers never see streamo.dev. Perfect
  for offline demos.

### when to use this path

- Streamo.dev is down and the main script's Phases 1-2 can't run
- Audience wants the *cascade narrative* (each Record arrives
  independently) more than the *fork narrative* (npx, identity from
  credentials, your own keypair)
- Showing it to yourself for the first time before showing Rick

---

## post-demo notes (fill in after)

- What landed well:
- What confused Rick:
- What questions you couldn't answer cleanly:
- What you'd do differently next time:

_(this section is the spaced-repetition fuel for future demos)_
