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
