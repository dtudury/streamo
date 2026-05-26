// flashcards — spaced-repetition demo on streamo.
//
// Step 3: decks are real signed StreamoRecords on the relay too. The home
// repo's `flashcardsDecks` field maps deck-id → pubkey-hex; the
// client reads it at login, opens each deck StreamoRecord via the registry,
// and reads title/description/cards reactively. The relay's home
// identity is the deck author for bundled decks; fork-a-deck (step
// 4) will let any learner mint their own deck StreamoRecord with the same
// keysFor-subkey mechanism.

import { h, handle }    from '../../streamo/h.js'
import { mount }        from '../../streamo/mount.js'
import { Signer }       from '../../streamo/Signer.js'
import { StreamoRecord } from '../../streamo/StreamoRecord.js'
import { WritableStreamoRecord } from '../../streamo/WritableStreamoRecord.js'
import { StreamoRecordRegistry } from '../../streamo/StreamoRecordRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { bytesToHex }   from '../../streamo/utils.js'

import {
  recaller, time, reviewRepos, state, registry, setRegistry,
  loggedIn, connecting, user, view, activeDeck
} from './state.js'
import { deckRepo, deckCards, reviewStateForCard, activeCardIds, buildStudyQueue } from './derived.js'
import './routing.js'  // side-effect: installs the state ↔ hash watcher + popstate listener
import { renderHome }   from './home.js'
import { renderStudy }  from './study.js'
import { renderEdit }   from './edit.js'
import { renderManage } from './manage.js'

const when = (cond, vnode) => () => cond() ? vnode : null

// ── app-level state ──────────────────────────────────────────────────
//
// The shared singletons (recaller, time, reviewRepos, state, registry,
// derived getters) live in ./state.js — see that file. The login-flow
// lets (signer, session, homeRepo, myDeckIndex) stay here because
// they're tied to login()/logout() which also lives here.

// `revealed` is derived: the back is shown only if the SPECIFIC card we
// flipped is still the current card. If the queue shifts under us (bytes
// arrive, another tab grades, deck changes), the back auto-hides because
// revealedCardIdx no longer matches currentCardIdx — naturally reactive.
const revealed = () => state.get('revealedCardIdx') === currentCardIdx()

// Module-level handles populated by login(); reset by logout().
let signer = null
let session = null
let homeRepo = null     // the relay's home repo, source of bundled-deck addresses
let myDeckIndex = null  // learner's deck-index StreamoRecord: { decks: [<pubkey-hex>, ...] }

// Set of fork deck-repo addresses that have had their signer re-attached
// this session. The signer is attached at fork-creation time inside
// forkDeck(); on re-login the cascade re-opens the fork's repo but
// doesn't know to re-attach. The 'attach-signer-to-fork-decks' watcher
// below does that, using a streamName stored in the fork's deck value.
// Reset on logout.
const signedForks = new Set()

// SM-2 + mastery math live in sibling files — pure functions, no
// reactive coupling, no DOM. See ./sm2.js and ./mastery.js. Past-
// claude's "inline everything" rule applies to the *markup*; pure
// domain math belongs alongside, not inside.

// Derived data functions (addrFor, deckRepo, deckCards,
// reviewStateForCard, deckStats, buildStudyQueue, activeCardIds,
// isCardActive, deckMastery) live in ./derived.js — pure reads
// over registry / reviewRepos / homeRepo, no side effects, no DOM.

// ── active set (partial-deck learning) ──────────────────────────────
//
// Per-(learner, deck) state stored in the reviews repo: which cards
// the learner is *currently* studying. The read side (activeCardIds,
// isCardActive) lives in derived.js; toggleCardActive — the mutation
// — stays here with the other user-action handlers.

// Retention slider has two handlers:
//
// - previewRetentionTarget (oninput): writes the new value ONLY to
//   state.pendingRetentionTarget. retentionTargetFor() reads pending
//   first, so the deck re-sorts live as you drag. NOT a commit.
//
// - saveRetentionTarget (onclick on the save button): commits the
//   pending value to the reviews repo and clears pending. Save
//   button only appears when there's a pending change that differs
//   from the committed value.
//
// Drag-without-save = preview only; navigating away (backToHome)
// clears pending and reverts to the committed value. David asked
// for this shape so the slider is for exploration; saving is an
// explicit step.

function previewRetentionTarget (event) {
  const value = parseFloat(event.target.value)
  if (!Number.isFinite(value)) return
  state.set('pendingRetentionTarget', value)
}

function saveRetentionTarget () {
  const pending = state.get('pendingRetentionTarget')
  if (pending == null) return
  const deckId = activeDeck()
  const repo = reviewRepos.get(deckId)
  if (!repo) {
    state.set('pendingRetentionTarget', null)
    return
  }
  const v = repo.get() ?? { deck: deckId, reviews: [] }
  if (v.retentionTarget !== pending) {
    repo.defaultMessage = `set retention target to ${(pending * 100).toFixed(0)}%`
    repo.set({ ...v, retentionTarget: pending })
  }
  state.set('pendingRetentionTarget', null)
}

function toggleCardActive (deckId, cardIdx) {
  const repo = reviewRepos.get(deckId)
  if (!repo) return
  const value = repo.get() ?? { deck: deckId, reviews: [] }
  const set = new Set(Array.isArray(value.active) ? value.active : [])
  let nowActive
  if (set.has(cardIdx)) {
    set.delete(cardIdx)
    nowActive = false
  } else {
    set.add(cardIdx)
    nowActive = true
  }
  repo.defaultMessage = nowActive
    ? `add card ${cardIdx} to active`
    : `remove card ${cardIdx} from active`
  repo.set({
    ...value,
    active: [...set].sort((a, b) => a - b)
  })
}

// ── derived metrics ─────────────────────────────────────────────────
//
// "What is this app doing?" — make the SM-2 internals legible. Three
// derived numbers worth surfacing:
//
// mastery (0..~7): how well-learned a card is. Derived from interval.
//   log₂(1 + days). Brand new = 0; week-out = 3; month-out = ~5;
//   months-out = 7+. Maps cleanly to a color gradient.
//
// urgency (negative..+∞): how overdue a card is, scaled by its own
//   interval. -1 = won't be due for another full interval; 0 = due now;
//   +1 = a full interval late. Self-normalizes by mastery.
//
// formatTimeUntil: human-readable countdown that reads time.get()
//   inside, so a slot using it ticks every second.

// (Used to live here: scheduleReady + isReady — a setTimeout-based
//  kludge that conflated "has the data arrived?" with "is it safe to
//  write?" Removed. The reading question answers itself reactively
//  (undefined renders as empty, slots re-run when bytes arrive). The
//  writing question — stale-state writes overwriting history — is
//  handled at the substrate by 8.3's pushRejected flag and, in the
//  longer term, by a `repo.merge(updateFn)` primitive queued under
//  "Held for a major bump" in ROADMAP.md. For v1 of flashcards the
//  race is rare and surfaces as a dropped grade rather than silent
//  corruption.)

// ── repo opening ─────────────────────────────────────────────────────

// Lazily open the reviews StreamoRecord for (this learner, this deck), fired
// by the 'ensure-reviews-for-active-deck' watcher when activeDeck
// becomes set. The deck-scoped stream name derives a fresh keypair
// from the learner's root credentials; same login, different repo
// per deck. No pre-await on the `reviews` field — the study view
// just reads whatever's there and renders accordingly.
async function ensureReviewsRepo (deckId) {
  const existing = reviewRepos.get(deckId)
  if (existing) return existing
  const streamName = `flashcards:reviews:${deckId}`
  const { publicKey } = await signer.keysFor(streamName)
  const repoKey = bytesToHex(publicKey)
  registry._writableKeys.add(repoKey)
  const repo = await session.subscribe(repoKey)
  repo.attachSigner(signer, streamName)
  reviewRepos.set(deckId, repo)
  return repo
}

// ── handlers ─────────────────────────────────────────────────────────

async function login (e) {
  e.preventDefault()
  const f = e.target
  const username = f.elements.username.value.trim()
  const password = f.elements.password.value.trim()
  if (!username || !password) return
  f.elements.username.disabled = f.elements.password.disabled = true
  state.set('connecting', true)

  signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('flashcards')
  state.set('user', { username, pubkey: bytesToHex(publicKey) })

  // Connect to the relay. The `follow` callback cascades subscription
  // through (a) the home repo's `flashcardsDecks` map for bundled decks
  // and (b) any repo's `decks` array (the deck-index shape) for forks
  // the learner has authored. The home repo doesn't have `decks` and
  // the deck-index doesn't have `flashcardsDecks`, so each clause
  // applies cleanly to its source. From here, discovery is *reactive*:
  // bytes flow in, the home view re-renders.
  // Track which keys the user authors to — those get
  // WritableStreamoRecord; subscribed peers (bundled decks, the home
  // repo) get slim StreamoRecord and stay read-only by type.
  const writableKeys = new Set()
  setRegistry(new StreamoRecordRegistry({
    recaller,
    name: 'flashcards',
    factory: key => writableKeys.has(key)
      ? new WritableStreamoRecord({ recaller })
      : new StreamoRecord({ recaller })
  }))
  // Expose so ensureReviewsRepo / forkDeck / the fork-signer watcher
  // can declare their keys Writable BEFORE the factory materializes
  // them.
  registry._writableKeys = writableKeys
  session = await registrySync(
    registry,
    location.hostname,
    +location.port || (location.protocol === 'https:' ? 443 : 80),
    {
      follow: (keyHex, repo, subscribe) => {
        const fd = repo.get('flashcardsDecks') ?? {}
        for (const deckKey of Object.values(fd)) subscribe(deckKey)
        const myDecks = repo.get('decks') ?? []
        for (const deckKey of myDecks) {
          // Every entry in myDeckIndex.decks is a fork the user owns
          // (they authored it) — pre-declare Writable so the factory
          // produces the right class when the subscribe materializes.
          writableKeys.add(deckKey)
          subscribe(deckKey)
        }
      }
    }
  )

  // Two repos we DO need handles on: the home repo (so the home view
  // can read flashcardsDecks reactively) and the learner's deck-index
  // (same, for forks; also needed for the fork-action's write path).
  // No further awaitFields here — slots fill in as bytes arrive.
  const info = await fetch('/api/info').then(r => r.json())
  // `session.subscribe` (not the registry's local-materialize) — the
  // browser needs the bytes to actually flow over the wire. Pre-10.0.0
  // this site called `registry.open` and was a latent footgun: the
  // StreamoRecord was created locally but no wire-subscribe ever fired, and
  // bytes only arrived because the `follow` cascade on home.journalists
  // was subscribing for us as a side effect.
  homeRepo = await session.subscribe(info.primaryKeyHex)

  const idxStream = 'flashcards:deck-index'
  const { publicKey: idxPub } = await signer.keysFor(idxStream)
  const idxKey = bytesToHex(idxPub)
  registry._writableKeys.add(idxKey)
  myDeckIndex = await session.subscribe(idxKey)
  myDeckIndex.attachSigner(signer, idxStream)

  state.set('connecting', false)
  state.set('loggedIn', true)
}

function logout () {
  signer = null
  setRegistry(null)
  session = null
  homeRepo = null
  myDeckIndex = null
  reviewRepos.set({})
  signedForks.clear()
  // Clear the URL hash so a stale deep-link doesn't try to re-enter
  // a view that's no longer valid for whoever logs in next.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)
  // Fully reset state so `ready-*` flags from this session don't
  // leak into the next login's gating checks.
  state.set({
    loggedIn:   false,
    connecting: false,
    user:       null,
    view:       'home',
    activeDeck:      null,
    revealedCardIdx: null
  })
}

// Purely declarative. Setting activeDeck triggers the
// 'ensure-reviews-for-active-deck' watcher below to open the reviews
// repo as a side effect; the study view's reactive gate handles the
// "wait until ready" UX. No await here, no side effects in the click
// path — state change in, side effect out, the unidirectional shape.
function startStudy (deckId) {
  state.set('activeDeck', deckId)
  state.set('revealedCardIdx', null)
  state.set('view', 'study')
}

function backToHome () {
  state.set('view', 'home')
  state.set('activeDeck', null)
  state.set('studyAhead', false)           // opt-in study-ahead resets between sessions
  state.set('peekCardIdx', null)           // and so does the manage-list peek
  state.set('pendingRetentionTarget', null) // and any mid-drag slider preview
}

// Reveal ties the flip to the SPECIFIC card we're showing right now.
// If the queue shifts before the user grades, `revealed()` returns
// false and the back auto-hides — and grade() applies to the card we
// revealed, not whatever queue[0] is at grade-time.
function reveal () { state.set('revealedCardIdx', currentCardIdx()) }
// toggleReveal: the whole card is the flip target. Clicking flips
// front↔back (so a learner can re-check the front after revealing).
// Tied to currentCardIdx so the toggle is per-card; once you grade and
// the queue shifts, revealed() goes false naturally.
function toggleReveal () {
  const idx = currentCardIdx()
  const current = state.get('revealedCardIdx')
  state.set('revealedCardIdx', current === idx ? null : idx)
}

function grade (gradeIdx) {
  const deckId = activeDeck()
  const repo   = reviewRepos.get(deckId)
  if (!repo) return
  // Grade the card the user actually saw the back of — not whichever
  // card happens to top the queue now if it shifted.
  const cardIdx = state.get('revealedCardIdx')
  if (cardIdx == null) return
  // Spread the existing repo value so we preserve sibling fields
  // (notably `active`). Before this, grade() rebuilt the value as
  // `{deck, reviews}` and silently wiped the active set on every
  // grade — David noticed: add cards → grade easy → active set gone.
  const value = repo.get() ?? { deck: deckId, reviews: [] }
  const reviews = value.reviews ?? []
  repo.defaultMessage = `review: card ${cardIdx} graded ${['again', 'hard', 'good', 'easy'][gradeIdx]}`
  repo.set({
    ...value,
    deck: deckId,
    reviews: [...reviews, { cardIdx, grade: gradeIdx, at: Date.now() }]
  })
  // No queue mutation, no index advance — the commit above updates
  // the reviews repo, which shifts buildStudyQueue's output, which
  // makes the new queue[0] the next card. Clearing revealedCardIdx
  // tells the view to show the next card's front; clearing
  // peekCardIdx hands control back to the queue (if the learner
  // had peeked at this card, grading it returns to normal flow).
  state.set('revealedCardIdx', null)
  state.set('peekCardIdx', null)
}

// Fork a deck: derive a fresh keypair for this learner's fork, copy
// the upstream's cards into it, cite the upstream by address as a
// value-level `forkedFrom` field, and append the new address to the
// learner's deck-index StreamoRecord. Returns the new deck's id (pubkey-hex).
//
// Same key-derivation trick that gives one-login-many-reviews-repos
// also gives one-login-many-decks-repos: a per-fork stream name
// (`flashcards:my-deck:<upstreamId>:<timestamp>`) derives a unique
// subkey from the learner's root credentials.
async function forkDeck (upstreamId) {
  const upstreamRepo = deckRepo(upstreamId)
  const upstream = upstreamRepo?.get()
  if (!upstream) return

  const forkStream = `flashcards:my-deck:${upstreamId}:${Date.now()}`
  const { publicKey } = await signer.keysFor(forkStream)
  const newDeckKey = bytesToHex(publicKey)
  registry._writableKeys.add(newDeckKey)

  const forkRepo = await session.subscribe(newDeckKey)
  forkRepo.attachSigner(signer, forkStream)
  signedForks.add(newDeckKey)  // already attached this session
  forkRepo.defaultMessage = `fork of ${upstream.title}`
  forkRepo.set({
    title: `${upstream.title} (my fork)`,
    description: `forked from ${upstreamRepo.publicKeyHex.slice(0, 10)}…`,
    cards: [...upstream.cards],
    forkedFrom: upstreamRepo.publicKeyHex,
    // Storing streamName in the deck value so re-login can re-attach
    // the signer (signer derivation is one-way; we need the original
    // name to reproduce the keypair). Without this the user could read
    // their fork on re-login but not edit it.
    streamName: forkStream
  })

  // Append to the learner's deck-index — the home view watches this
  // reactively and will pick up the new fork on its own. First fork
  // from a fresh user initializes the `decks` array; subsequent forks
  // append.
  const currentForks = myDeckIndex.get('decks') ?? []
  myDeckIndex.defaultMessage = `added fork: ${upstream.title}`
  myDeckIndex.set({ decks: [...currentForks, newDeckKey] })
  // Reviews repo opens lazily on the first study-click; no eager open.
}

// Remove a fork from this learner's deck-index. The fork's StreamoRecord and
// signed history stay on the relay — append-only means we can't truly
// erase. What we can do is drop the reference from `myDeckIndex.decks`,
// so the deck stops appearing in this learner's home list. (If the
// learner re-saved the address, they could re-add it.)
function deleteFork (deckId) {
  if (!myDeckIndex) return
  const repo = registry.get(deckId)
  const title = repo?.get('title') ?? 'this fork'
  if (!confirm(`Remove "${title}" from your decks?\n\nIts signed history stays on the relay (append-only — nothing is truly erased), but it will no longer appear here.`)) return
  const current = myDeckIndex.get('decks') ?? []
  const next = current.filter(addr => addr !== deckId)
  myDeckIndex.defaultMessage = `removed fork: ${title}`
  myDeckIndex.set({ decks: next })
}

// ── editor handlers ─────────────────────────────────────────────────
//
// The editor edits a fork's deck StreamoRecord. Each edit (save, delete, add)
// is a signed commit on the fork; the home view's mastery/schedule
// strips and the study view's queue all re-render reactively.
//
// Soft-delete: a deleted card stays in the cards[] array with a
// `deleted: true` flag set, so cardIdx alignment with existing
// reviews stays stable. Deleted cards are filtered out everywhere
// (study queue, editor list).
//
// editingCardIdx: null = not editing; N = editing existing card N;
// -1 = adding a new card (sentinel).

function enterEdit (deckId) {
  state.set('activeDeck', deckId)
  state.set('editingCardIdx', null)
  state.set('view', 'edit')
}

function exitEdit () {
  state.set('view', 'home')
  state.set('activeDeck', null)
  state.set('editingCardIdx', null)
}

function startEditCard (cardIdx) {
  state.set('editingCardIdx', cardIdx)
}

function cancelEditCard () {
  state.set('editingCardIdx', null)
}

function addCard () {
  state.set('editingCardIdx', -1)  // sentinel for "new card"
}

// Rename a fork's deck. Fires on the edit-page title input's change
// event (blur or Enter). No-op when the input is empty (trimmed) or
// when the title hasn't actually changed. If the deck repo has no
// signer attached (e.g., a bundled deck reached by direct URL), the
// repo.set call won't commit — silent no-op, no crash.
function saveDeckTitle (event) {
  const deckId = activeDeck()
  const repo = deckRepo(deckId)
  if (!repo) return
  const next = event.target.value.trim()
  if (!next) return
  const deck = repo.get()
  if (!deck || deck.title === next) return
  repo.defaultMessage = `rename deck to "${next}"`
  repo.set({ ...deck, title: next })
}

function saveCard (e) {
  e.preventDefault()
  const form = e.target
  const front = form.elements.front.value.trim()
  const back  = form.elements.back.value.trim()
  const cardIdx = state.get('editingCardIdx')
  const deckId = activeDeck()
  const repo = deckRepo(deckId)
  if (!repo) return
  const deck = repo.get()
  if (!deck) return

  let newCards
  let message
  if (cardIdx === -1) {
    // Adding new — skip if both fields blank.
    if (!front && !back) {
      state.set('editingCardIdx', null)
      return
    }
    newCards = [...deck.cards, { front, back }]
    message = `add card: ${(front || back).slice(0, 40)}`
  } else {
    // Editing existing — preserve any other fields (like `deleted`) on the card.
    newCards = [...deck.cards]
    newCards[cardIdx] = { ...newCards[cardIdx], front, back }
    message = `edit card ${cardIdx}: ${(front || back).slice(0, 40)}`
  }
  repo.defaultMessage = message
  repo.set({ ...deck, cards: newCards })
  state.set('editingCardIdx', null)
}

function deleteCard (cardIdx) {
  if (!confirm("Delete this card? Reviews of it stay in your history but it won't appear in study.")) return
  const deckId = activeDeck()
  const repo = deckRepo(deckId)
  if (!repo) return
  const deck = repo.get()
  if (!deck) return
  const newCards = [...deck.cards]
  newCards[cardIdx] = { ...newCards[cardIdx], deleted: true }
  repo.defaultMessage = `delete card ${cardIdx}`
  repo.set({ ...deck, cards: newCards })
}

// ── manage view handlers ────────────────────────────────────────────

function enterManage (deckId) {
  state.set('activeDeck', deckId)
  state.set('view', 'manage')
}

function exitManage () {
  state.set('view', 'home')
  state.set('activeDeck', null)
}

// ── view helpers ─────────────────────────────────────────────────────

function currentCard () {
  const deckId = activeDeck()
  if (!deckId) return null
  const idx = currentCardIdx()
  return idx == null ? null : deckCards(deckId)[idx]
}

// The card index that's currently being shown — used as a data-key on
// the card div so it recycles cleanly when grade() shifts the queue.
// peekCardIdx overrides the queue: when the learner clicks the eye
// button on a manage-list card, that card jumps to the studied slot
// regardless of due-time. Cleared on grade and back-to-home.
function currentCardIdx () {
  const peek = state.get('peekCardIdx')
  if (peek != null) return peek
  const deckId = activeDeck()
  if (!deckId) return null
  const queue = buildStudyQueue(deckId)
  return queue.length === 0 ? null : queue[0]
}

// Peek at a card from the manage list — pop it into the studied slot
// and reveal its back. Lets the learner pick a specific card to look
// at without grading their way through the queue. Cleared on grade
// (next card comes from queue normally) and on back-to-home.
function peekCard (cardIdx) {
  state.set('peekCardIdx', cardIdx)
  state.set('revealedCardIdx', cardIdx)
}

// ── reactive side effects ────────────────────────────────────────────
//
// Click handlers stay declarative — they update state. State changes
// trigger this watcher, which kicks off the side effect of opening
// the reviews repo for the active deck. The watcher *converges*:
// once `reviewRepos.set(deckId, repo)` fires, the if-already-open
// guard suppresses the side effect on subsequent passes. Same shape
// as registrySync's `follow` callback — a watcher whose body runs a
// fire-and-forget op that, when complete, makes its own trigger
// condition false.

recaller.watch('ensure-reviews-for-all-decks', () => {
  // Subscribe to state.loggedIn FIRST — this is what makes the watcher
  // fire when login completes. signer/session/homeRepo/myDeckIndex are
  // module-level `let`s and not recaller-tracked, so reading them alone
  // doesn't subscribe; without this loggedIn dep the watcher's first
  // run at module load returns early and never re-fires.
  if (!state.get('loggedIn')) return
  if (!signer || !session) return
  // Eagerly open every discovered deck's reviews repo so the home
  // view's mastery/stats/schedule populate without needing a click.
  // Converges: once `reviewRepos.get(id)` is truthy, this loop skips
  // it. Each pass only fires async opens for newly-discovered decks
  // (a new fork appearing in myDeckIndex, a new bundled deck appearing
  // in flashcardsDecks). Same shape as registrySync's follow callback.
  const fd = homeRepo?.get('flashcardsDecks') ?? {}
  const myDecks = myDeckIndex?.get('decks') ?? []
  for (const id of Object.keys(fd)) {
    if (!reviewRepos.get(id)) ensureReviewsRepo(id)
  }
  for (const addr of myDecks) {
    if (!reviewRepos.get(addr)) ensureReviewsRepo(addr)
  }
})

// ── attach signers to fork deck repos on (re-)login ─────────────────
//
// forkDeck() attaches the signer at fork-creation time. But the fork's
// deck repo lives across sessions — and the *cascade* opens it on
// re-login without knowing to re-attach. Result before this watcher:
// the user can read their fork on re-login but can't edit it (writes
// fail because no signer; the apparent symptom is 'edits lost when I
// log back in').
//
// We can't recover the original streamName from just the address
// (signer.keysFor is one-way), so forkDeck now stores it in the
// fork's deck value. This watcher reads it and re-attaches.
//
// Legacy forks (created before this fix) have no streamName stored
// and can't be re-edited from a new session — they need to be
// re-forked. Logged when skipped, not crashed.

recaller.watch('attach-signer-to-fork-decks', () => {
  if (!state.get('loggedIn')) return
  if (!signer || !registry) return
  const myDecks = myDeckIndex?.get('decks') ?? []
  for (const addr of myDecks) {
    if (signedForks.has(addr)) continue
    const repo = registry.get(addr)
    if (!repo) continue
    const streamName = repo.get('streamName')
    if (!streamName) continue  // legacy fork without streamName — skip
    repo.attachSigner(signer, streamName)
    signedForks.add(addr)
  }
})

// URL hash routing lives in ./routing.js — side-effect import below.
// Importing the module wires up the recaller watcher + popstate
// listener; nothing else from this file calls into it directly.

// ── mount ────────────────────────────────────────────────────────────

mount(h`
  <h1>
    <a class="brand-lockup" href="../../" title="streamo home">
      <img src="../../streamo.svg" alt="">streamo
    </a>
    <span class="page-title">flashcards</span>
  </h1>
  <p class="tagline">Tiny spaced-repetition where decks are real signed StreamoRecords on the relay and your reviews are a signed StreamoRecord you own. Each deck lives at its own address — bookmarkable, forkable, yours forever.</p>

  ${when(() => !loggedIn() && !connecting(), h`
    <h2>identity</h2>
    <form class="login" onsubmit=${handle(login)}>
      <input name="username" placeholder="username" autocomplete="username">
      <input name="password" type="password" placeholder="password" autocomplete="current-password">
      <button>sign in</button>
    </form>
    <p class="hint">Your username + password derive a keypair locally — no account, no server. Each deck you study gets its own derived subkey, so one login signs many repos.</p>
  `)}

  ${when(connecting, h`
    <p class="connecting">connecting to the relay, discovering decks, opening your reviews repos…</p>
  `)}

  ${when(loggedIn, h`
    <div class="who">
      <span>signed in as <code>${() => user()?.username ?? ''}</code> · <code>${() => (user()?.pubkey ?? '').slice(0, 10)}…</code></span>
      <button onclick=${handle(logout)}>sign out</button>
    </div>
  `)}

  ${when(() => loggedIn() && view() === 'home', renderHome())}
  ${when(() => loggedIn() && view() === 'study', renderStudy())}
  ${when(() => loggedIn() && view() === 'edit', renderEdit())}
  ${when(() => loggedIn() && view() === 'manage', renderManage())}
`, document.body, recaller)

// ── exports for the page modules ────────────────────────────────────
//
// The four page render functions (home.js, study.js, edit.js,
// manage.js) import what they need from here as live ES module
// bindings. Functions are hoisted; `homeRepo`/`myDeckIndex` are
// re-exported as live `let`s that login()/logout() above mutate
// in this module's scope — importers see updates on next read.

export {
  // module lets (live bindings, mutated by login/logout above)
  homeRepo, myDeckIndex,
  // current-card derivations — these read state.get('revealedCardIdx')
  // and the queue, so they're tied to the study session's UI state
  // rather than pure data derivation; kept here next to revealed
  currentCard, currentCardIdx, revealed,
  // user-action handlers wired into onclick / onsubmit
  toggleCardActive, previewRetentionTarget, saveRetentionTarget,
  toggleReveal, grade, peekCard,
  startStudy, backToHome, enterEdit, exitEdit, enterManage, exitManage,
  forkDeck, deleteFork,
  saveCard, cancelEditCard, startEditCard, deleteCard, addCard, saveDeckTitle
}

