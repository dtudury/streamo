# flashcards — design log

A running journal of the choices that shaped this app. Appended to
as decisions get made or revised; curated into a public
`BUILD_A_STREAMO_APP.md` at the repo root when the app lands.

The point: the doc is a *byproduct* of the build, not a precursor.
The corrections we make to our own thinking are part of the story —
they make the doc more pedagogical, not less.

---

## 2026-05-22 — design conversation

David asked for a small teaching app that shows streamo off. We
chose **flashcards / spaced repetition** for three reasons:

1. **The streamo properties earn their place.** Decks are content
   the deck-author commits; reviews are an append-only signed log
   the learner appends to; cards are content-addressed and dedup
   across decks; "fork a deck" is one subscribe + one fork.
2. **It's a real product people want.** Anki has millions of users.
   The fork-a-deck mechanic is *genuinely better* on streamo than
   on a server — no share-code, no account, just an address.
3. **SM-2 is ~30 lines of code.** The algorithm doesn't fight us.

### architecture: three repo kinds

- **App page** lives at `public/apps/flashcards/` and is served by
  the home repo's `fileSync`. Not a per-user Repo — it's the rails
  everyone rides. (v2 daydream: a deck Repo could carry its own
  `files` to override styling, page-as-Repo all over again.)
- **Deck Repo** — one per deck, authored by the deck's creator.
  Value: `{ title, description, cards: [{ front, back }, ...] }`.
  Each card's content hashes to a stable address — that's what makes
  fork-stable reviews work for free.
- **Reviews Repo** — one per *(learner, deck)*, not per learner.
  Authored by the learner. Value: `{ deck: <addr>, reviews: [...] }`.
  **This is the URL the user bookmarks** — their studying surface
  for that deck. Want to study Spanish and Greek? Two reviews
  repos, two URLs.

### the correction worth remembering

I originally proposed *one* reviews Repo per learner, holding SM-2
state across all decks. David caught it: the URL should be the
*studying surface*, not the *data surface*. Per-(learner, deck) is
the cleaner factoring because every studying-session becomes a
first-class addressable thing — "resume Spanish where I left off"
is one URL. The mental model gets simpler, not bigger.

This is the kind of correction the final doc should highlight.

### deck index — composing apps

A learner's deck-index is itself a tiny Repo: `{ name, decks: [...] }`.
"Follow this teacher" = one subscribe gets you all their decks plus
future additions. Bonus property: the *same component* renders
"list of my decks" and "list of my active studies" — both are lists
of Repo addresses organized by me.

### sharing — the address IS the channel

- *"Study this deck"* → share the deck Repo's address.
- *"Make your own version"* → fork (cite `remoteParent`), share your
  deck Repo's address.
- *"Follow this teacher"* → share their deck-index Repo address.

QR codes for the address; URL shorteners exist if anyone wants them.
QR generator will be hand-rolled or vendored tiny — no npm deps.

### login — already free

Identity is a keypair derived from username+password (PBKDF2 via
`Signer.js`). Log in once, every commit you make is signed by you,
across any number of repos. The UI prompts once at first visit,
stashes the Signer in IndexedDB so refreshes don't re-prompt. No
per-repo login.

### editing

In-app card editor (add / edit / delete) for v1. JSON import/export
for v1.5 — nearly every flashcard user has existing data somewhere
(Anki .apkg, textbook CSVs); "type 200 Spanish words by hand" is a
non-starter.

### starter decks

Three small decks ship with the app so the home screen looks like a
home screen day one:

1. **Greek alphabet** (24 cards) — charming, on-theme, tiny.
2. **HTTP status codes** (~60 cards) — dev-audience, includes the
   teapot.
3. **US state capitals** (50 cards) — universally useful baseline.

---

## 2026-05-22 — step 1 landed: local-only UI shell

Shipped `e2b53fc` — the whole app runs in one file (`main.js`, ~430
lines incl. styles), end-to-end studying works against the Greek
alphabet deck, no streamo plumbing yet.

### what's real now

- **Login derives a real keypair** via `Signer(username, password, 1)`
  → `keysFor('flashcards')` → pubkey shown in the "signed in as" strip.
  We don't sign anything with it yet, but the keypair is in hand — step
  2 will pass the Signer into a Reviews Repo's `attachSigner`.
- **Decks fetched as static JSON** from `./decks/*.json`. The fetched
  content is stashed in a `liveObject` keyed by deck id; the home
  view reads it reactively. Step 3 will swap this for `registry.open(
  deckAddress)` + value reads from a real Repo.
- **Reviews in localStorage**, keyed `flashcards:review:<deckId>:<idx>`.
  SM-2 state stored per (deckId, cardIdx). Step 2 replaces this with
  a Reviews Repo whose value is `{ deck, reviews: [...] }` and SM-2
  state is recomputed by folding over `reviews`.

### tiny tradeoff worth flagging

`deckStats()` reads localStorage directly — the recaller doesn't track
it. We get away with this in v1 because the home view re-mounts when
you return from study (so stats refresh on view-change). If we ever
need live stats *while* on home, we'd have to lift review state into
the Recaller. Step 2 fixes this incidentally — the Reviews Repo IS
the LiveSource, so stats become naturally reactive.

### worked-example value for the eventual doc

The whole reactive pattern this app demonstrates lands clean:
- One Recaller, shared across `liveObject` instances and `mount()`.
- View-routing as a string in state (`'home' | 'study'`), gating with
  `when(() => view() === 'home', ...)`.
- Function-style cells (`${() => ...}`) for list rendering;
  `data-action` + a single delegated `click` listener for the dynamic
  parts (avoids the `onclick=${fn}` reactive-cell footgun for list
  items).
- Form submission via `onsubmit=${() => login}` — the outer arrow IS
  the cell; the inner identifier is the handler.
- `data-key` on study cards so the reveal-state resets cleanly when
  the index advances.

These are exactly the patterns the public "build a streamo app" doc
will lean on — captured here as a byproduct, not invented later.

---

## 2026-05-22 — step 2 landed: reviews as a signed streamo Repo

Shipped `51f8af8`. localStorage is gone. Every grade is a signed
commit on the learner's reviews Repo. SM-2 state is computed by
folding over `reviews[]` — never stored as truth.

### the key-derivation trick that makes "one login, many repos" work

This deserves a place in the public doc. `Signer.keysFor(streamName)`
derives a *different* keypair per stream name from the same root
credentials. We use it like this:

```js
signer.keysFor('flashcards:reviews:greek-alphabet')  // → keypair A
signer.keysFor('flashcards:reviews:http-codes')      // → keypair B
```

Two keypairs, two pubkeys, two addressable Repos — but only **one
login**. The learner types their username and password once; we
derive a fresh signing identity per (learner, deck) on demand. The
elegance David asked about ("can we own multiple decks without
logging in again?") wasn't extra complexity — it was streamo's
existing mechanism, surfaced.

### SM-2 state is derived, not stored

The reviews Repo holds an event log: `[{cardIdx, grade, at}, ...]`.
Per-card SM-2 state (ease, interval, due, reps) is recomputed by
folding `applySM2` over events filtered for that card. This is the
right shape for streamo: the **history is the truth**, derived
state is cheap. If we ever need to migrate the algorithm (SM-2 →
FSRS, say), we keep the event log and replay it under the new rules
— no data conversion.

### persisted login removed

Step 1 stored `{username, pubkey}` in localStorage and "remembered"
you across reloads. Step 2 removes this — without the password we
can't re-derive the Signer, and storing the password is not OK. The
honest version is "log in each session," same as the journal app.
A v1.5 option would be to stash the derived hashword in IndexedDB
(survives reload, not as exposed as the raw password); not v2.

### what got better incidentally

- Deck stats are now naturally reactive: `repo.get('reviews')` is
  recaller-tracked, so home-view stats live-update during study
  (we just don't *see* it because home and study are mutually
  exclusive views).
- The flagged "deckStats reads localStorage outside the recaller"
  v1 tradeoff disappeared without explicit cleanup — the better
  architecture removed the problem.

### the explorer link

Under your deck list, "see your reviews in the explorer" jumps to
`/apps/explorer/#/repo/<reviewsPubkey>`. Every grade you make
appears there as a signed commit. This is the most "streamo shows
its work" moment in the app — your study log is the chain, the
chain is yours, anyone with the address can verify it.

### addendum — `handle` and a caught doc-lag

David noticed the event handlers were still using the older
`onclick=${() => fn}` double-arrow shim — the pattern the journal
app uses, which I'd copied. Meanwhile `h.js` had quietly grown a
`handle` helper that produces the same curry shape declaratively:
`onclick=${handle(fn)}`. The fix had been written; the docs hadn't
been propagated; new code inherited the old shape.

Refactored all six handler sites in flashcards to use `handle`, and
asked the deeper question David surfaced: now that `handle` exists,
the deck list's `data-action` delegation isn't actually fixing a
footgun — it's a separate pattern useful for large/uniform lists
(the explorer's case), not the universal escape hatch CLAUDE.md was
implying. Refactored deck-list clicks to inline `onclick=${handle(
() => startStudy(id))}` and removed the body-level delegated
listener. Two patterns, two purposes, clear in the docs now.

Updated CLAUDE.md and dear-future-claudes.md to reflect this; the
journal app stays on the older shape as a legible older reference.

The meta-lesson worth keeping in the public doc: **when a substrate
grows a new affordance, the docs need to catch up or new code will
inherit the old patterns by mimicry.** This is the third
"correction during build" moment in this app (after reviews-as-URL
and the deckStats-recaller cleanup); each one made the code better
*and* the eventual tutorial more honest.

---

## 2026-05-22 — step 3 landed: decks become signed Repos on the relay

Shipped `68655f9`. The first end-to-end version where *every layer*
of flashcards is on streamo: the deck is signed by the relay's home
identity, the reviews are signed by the learner, the addresses
discover at runtime. Greek alphabet's first real address:
`03ef090a1b62f9154059a28269a22cc93f4433eb7190467b7600e47cf4237d8aad`.

### the discovery pattern, in one breath

The home repo is the relay's "what do I serve" advertisement.
Adding a field to it (`flashcardsDecks: { id: pubkeyHex, ... }`)
makes the bundled decks discoverable without any /api endpoint,
without any hardcoded addresses, and without any out-of-band
configuration. Client fetches `/api/info` to learn the home repo's
pubkey, opens it via the registry, reads `flashcardsDecks`, opens
each deck Repo. This is the page-as-Repo aesthetic extended to
app-level metadata: **the home repo IS the catalog.**

### the awaitField helper

`registry.open(pubkeyHex)` returns immediately, but the repo's bytes
arrive over WS asynchronously. For one-shot "wait for this field to
exist" needs, we wrote a small helper:

```js
function awaitField (repo, field, timeoutMs = 5000) {
  const existing = repo.get(field)
  if (existing !== undefined) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const fn = () => { ... if (repo.get(field) !== undefined) resolve(...) }
    repo.recaller.watch(`await-${field}`, fn)
    const timer = setTimeout(() => { repo.recaller.unwatch(fn); reject(...) }, timeoutMs)
  })
}
```

Worth surfacing in the public doc — it's a small bridge between
streamo's reactive idiom and async/await control flow. Reactive UI
doesn't need it (slots re-run themselves); imperative discovery
flows like login() do.

### idempotent seeds: the JSON-stringify guard

Server-side, the seed step runs on *every* startup. To avoid
appending spurious commits to deck Repos on each restart, we guard:

```js
if (JSON.stringify(deckRepo.get() ?? null) !== JSON.stringify(content)) {
  deckRepo.set(content)
}
```

Same guard on the home repo's flashcardsDecks update. Cheap; stable
chain history. The append-only nature of streamo makes idempotent
seeds important — every redundant commit would live forever.

### what unlocks next

Step 4 (fork-a-deck) is now trivially within reach: a learner can
derive their own deck-keypair via `signer.keysFor('flashcards-deck:
my-fork-of-greek')`, set its value to a copy of the upstream deck,
and cite the upstream as `remoteParent`. Same key-derivation trick
that made one-login-many-reviews-repos work makes one-login-many-
decks-repos work for the *learner* too.

### the deck list at scale

state.deckIds is the list-of-known-ids the home view subscribes to;
deckRepos.get(id) reads the actual Repo. Splitting "what ids exist"
from "what's in each repo" is the streamo idiom for collections —
two LiveSources, one for identity, one for content. The journal app
uses a single repo's `entries` array; we use this two-layer pattern
because each deck is its own author / own address / own forkable
unit. Different shape for different use case.

---

## 2026-05-22 — step 4 landed: fork-a-deck

Shipped `8950c89`. A learner can now click *fork* on any deck they
don't already own and get their own signed deck Repo with the
upstream's cards copied, citing the upstream by address. The fork
lives in the learner's deck-index Repo (one per learner, stream
`flashcards:deck-index`), discovered at login and cascaded by the
follow callback.

### the same key-derivation trick, third time

Step 2 used `Signer.keysFor` to give every learner-deck pair its own
reviews keypair. Step 4 uses the *same trick* to give every fork its
own deck keypair: `signer.keysFor('flashcards:my-deck:<upstreamId>
:<timestamp>')`. Same root credentials; arbitrarily many addressable
Repos; no "create a new identity" step. The pattern keeps paying off.

### the follow cascade, generalised

The `follow` callback now walks *two* sources from one body:

```js
follow: (keyHex, repo, subscribe) => {
  const fd = repo.get('flashcardsDecks') ?? {}
  for (const deckKey of Object.values(fd)) subscribe(deckKey)
  const myDecks = repo.get('decks') ?? []
  for (const deckKey of myDecks) subscribe(deckKey)
}
```

`flashcardsDecks` only appears on the home repo; `decks` only
appears on a deck-index. Each clause naturally applies to its
source. The follow callback doesn't need to know *which* repo
fired it — the data shape disambiguates.

### "new user has no bytes" — the try/catch on awaitField

A learner who's never forked has an empty deck-index Repo. The
relay knows it's empty; awaitField times out. We treat the
timeout as "no forks yet" rather than as an error:

```js
let forkAddrs = []
try { forkAddrs = await awaitField(myDeckIndex, 'decks', 3000) }
catch { forkAddrs = [] }
```

Two scenarios collapse cleanly into one (empty-as-empty); the only
edge it doesn't cover is "the bytes exist on the relay but take
longer than 3s to push." For v1 that's acceptable; the next reload
catches up.

### what doesn't work yet (worth surfacing)

- **No live cross-tab sync of the deck list.** The deck-index repo
  itself syncs reactively, but the home view reads `state.deckIds`
  (set once at login). Fork in tab A → tab B needs refresh to see
  the new deck. The right fix is a `recaller.watch` on
  `myDeckIndex.get('decks')` that updates `state.deckIds` and opens
  any newly-arrived addresses. Defer to step 5+.
- **Editing a fork isn't here yet** — fork-without-edit is a
  demonstrative move (proves the lineage and the keypair-per-fork
  story). Step 5 adds the card editor: add card, edit, delete,
  reorder.
- **No tree view of fork lineage** — `forkedFrom` is stored on each
  fork, but we don't walk it to render a "this is a fork of X which
  is a fork of Y" chain. Reasonable v2 polish for the explorer too.

### stopPropagation, briefly

The Fork button lives inside the clickable `<li>` that triggers
startStudy. Naive `onclick=${handle(() => forkDeck(id))}` would
fork *and then* start studying. The handler explicitly
`e.stopPropagation()` before calling forkDeck. Worth keeping in the
"build a streamo app" doc — the `handle` form receives the event
as its first arg, which makes propagation control trivial.

---

## 2026-05-22 — the reactivity arc: a function from data shapes to html shapes

A long, meandering refactor session that started with "the
`_flashcardsKey` underscore-stash is ugly" and ended with David
naming the principle that had been emerging the whole way:

> **"All we make is a function that maps data shapes to html shapes.
> As the data shape changes, so the html shape changes."**

That sentence belongs above every streamo app's main.js. It is the
streamo idiom distilled.

The peel went through six layers — each one was "why does X need to
do Y?" finding a piece of cached imperative state that turned out
to be derivable:

1. **`_flashcardsKey` stash → `Repo.publicKeyHex`.** The Repo knew
   its own address; we just hadn't exposed it. (`d287d5e`)
2. **`deckRepos` liveObject + `state.deckIds` → reactive reads of
   `homeRepo.flashcardsDecks` and `myDeckIndex.decks`.** The
   registry IS the map of repos; the home repo IS the catalog.
   Login became "connect + sit-back"; the home view derives the
   list. (`74dd738`)
3. **`awaitField` gates at login → reactive `scheduleReady`/`isReady`
   gates at the action.** Wait at the door became gate the action.
   Login finishes fast; the fork button and grade buttons appeared
   when their underlying data was ready. (`adc74e2`)
4. **`state.studyQueue` + `state.currentIdx` → `buildStudyQueue[0]`
   derived per render.** SM-2's Again now sets due = now + 1 minute,
   encoding session-relevance in the algorithm; the queue is a live
   view of the reviews repo. (`ad8f6f1`)
5. **`startStudy` awaits ensureReviewsRepo → reactive watcher on
   `state.activeDeck`.** Click handlers became purely declarative —
   three state.sets, no side effects. Side effects lifted to a
   converging watcher (same shape as registrySync's follow callback).
   (`0ac2369`)
6. **`scheduleReady` + `isReady` → just read the data.** The final
   peel: the readiness gates were conflating "has the data arrived"
   (a reading question, fully answerable by reactive reads) with
   "is it safe to write" (a writing question, about chain conflicts).
   Different problems. Reading: just read; undefined means empty for
   display. Writing: protected at the substrate by `pushRejected`,
   with `repo.merge(updateFn)` queued for the major bump.

What collapsed across the arc:
- `awaitField` — gone (was 5+ uses).
- `scheduleReady`, `isReady` — gone.
- `state.deckIds`, `state.studyQueue`, `state.currentIdx`,
  `state.startingStudy` — all gone.
- `deckRepos` liveObject — gone (registry is the map).
- `_flashcardsKey` stash — gone (Repo.publicKeyHex).
- `openReviewsRepo` eager-loop at login — gone.

What got added:
- One reactive watcher (`ensure-reviews-for-active-deck`) to bridge
  state changes into side effects.
- `Repo.publicKeyHex` (one line in RepoRegistry.open).
- Reactive derivations: `addrFor`, `deckRepo`, `deckCards`,
  `currentCard`, `currentCardIdx`.

The trade-offs we accepted:
- **Brief card-flash for returning learners.** When reviews bytes
  arrive after the study view renders, the queue re-derives and the
  displayed card may shift from card[0] to the actual most-due card.
  Small papercut, fixable later via a "caught up" wire signal or a
  substrate merge primitive.
- **Rare overwrite race on fork/grade if user acts before bytes
  arrive.** `pushRejected` exists as a detection signal; we don't
  wire its UX yet, so the failure mode is "the grade silently
  doesn't take, user re-grades." Acceptable for v1 demo.

David's "why does X need to do Y?" question was the engine of the
whole arc. Each instance found a piece of state that didn't earn
its keep. Worth recording as a technique: when imperative-looking
code is inside a reactive system, ask whether the imperative state
is *derivable*. Often it is, and removing it makes the code shorter,
truer, and less buggy at the same time.

---

## 2026-05-23 — observed-from-use: partial-deck learning is a real feature

David noted while studying the Greek alphabet that he doesn't
naturally take a whole deck at once. His real flow: start with a
handful of cards, get comfortable with them, then add a few more.
Cards not in the active set are *available* (in the deck) but not
currently being *learned*. Only ever learning a few at a time; the
rest sit until opted in.

The current app treats all cards as available-from-the-start. SM-2
takes them in deck order; the learner has no add/remove control.
The "new" count partially gestures at this concept but isn't the
same thing.

**The real feature: a per-(learner, deck) active set, stored in the
reviews repo.** Schema sketch:
- Reviews repo value: `{ deck, reviews: [...], active: [cardIdx, ...] }`
- `buildStudyQueue` filters cards to those in `active`
- "Available cards" UI lets the learner explicitly add cards to
  `active`; "remove from active" puts them back into available

Composes naturally with:
- **Editor** — you can add/remove cards from your fork AND control
  which of your fork's cards are active for study.
- **Mastery visibility** — you can see which cards you're learning,
  which are mature, which are available-but-not-active.

Soft-delete (deck-side cards marked `deleted: true` rather than
spliced out) plays well with this — both keep the cardIdx stable
across UI operations, so existing reviews don't misalign. Eventually
moving to content-addressed cards (where reviews cite card content,
not card position) would eliminate the index-alignment concern
entirely. v1 stays with indices + soft-delete; the content-addressed
move queues for later.

Queued for the session after the editor lands. Real product insight,
came directly from David's lived use of the app.
