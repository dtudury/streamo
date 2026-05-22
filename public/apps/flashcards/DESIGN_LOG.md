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

## next entries

(Appended as we go.)
