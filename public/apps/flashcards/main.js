// flashcards — spaced-repetition demo on streamo.
//
// Step 3: decks are real signed Repos on the relay too. The home
// repo's `flashcardsDecks` field maps deck-id → pubkey-hex; the
// client reads it at login, opens each deck Repo via the registry,
// and reads title/description/cards reactively. The relay's home
// identity is the deck author for bundled decks; fork-a-deck (step
// 4) will let any learner mint their own deck Repo with the same
// keysFor-subkey mechanism.

import { h, handle }    from '../../streamo/h.js'
import { mount }        from '../../streamo/mount.js'
import { Signer }       from '../../streamo/Signer.js'
import { Recaller }     from '../../streamo/utils/Recaller.js'
import { liveObject, liveTime } from '../../streamo/LiveSource.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { bytesToHex }   from '../../streamo/utils.js'

const when = (cond, vnode) => () => cond() ? vnode : null

// ── app-level state ──────────────────────────────────────────────────

const recaller = new Recaller('flashcards')

// A reactive clock. Slots that read time.get() auto-subscribe and
// re-render every second — live countdowns, ticking 'overdue' counters,
// schedule strips that update without any custom interval choreography.
const time = liveTime({ recaller, name: 'flashcards-time', tickMs: 1000 })

// Reviews repos are opened lazily — when the learner clicks Study on
// a deck — so login doesn't pay an O(decks) cost in repos-and-wire
// activity. Deck repos themselves are NOT held in a parallel
// LiveSource: they live in the registry, which is itself a reactive
// LiveSource (registry.get reports access on (this, 'keys')), so
// reads in slots auto-subscribe.
const reviewRepos = liveObject({}, { recaller, name: 'reviewRepos' })

const state = liveObject({
  loggedIn:   false,
  connecting: false,    // true while login → connect → subscribe(deck-index)
  user:       null,     // { username, pubkey } once logged in
  view:       'home',   // 'home' | 'study' | 'edit' | 'manage'
  activeDeck: null,     // deck id while studying / editing / managing
  revealedCardIdx: null, // which card has been flipped (not a session-level bool)
  editingCardIdx:  null  // null = not editing; N = editing card N; -1 = adding new card
  // No studyQueue, no currentIdx — both derive from the reviews repo
  // each render. The "next card" is buildStudyQueue[0]; grading commits
  // a review event and the queue shifts naturally as a side effect.
}, { recaller, name: 'app' })

const loggedIn   = () => state.get('loggedIn')
const connecting = () => state.get('connecting')
const user       = () => state.get('user')
const view       = () => state.get('view')
const activeDeck = () => state.get('activeDeck')
// `revealed` is derived: the back is shown only if the SPECIFIC card we
// flipped is still the current card. If the queue shifts under us (bytes
// arrive, another tab grades, deck changes), the back auto-hides because
// revealedCardIdx no longer matches currentCardIdx — naturally reactive.
const revealed = () => state.get('revealedCardIdx') === currentCardIdx()

// Module-level handles populated by login(); reset by logout().
let signer = null
let registry = null
let session = null
let homeRepo = null     // the relay's home repo, source of bundled-deck addresses
let myDeckIndex = null  // learner's deck-index Repo: { decks: [<pubkey-hex>, ...] }

// ── SM-2 lite ────────────────────────────────────────────────────────

const DEFAULT_REVIEW = { ease: 2.5, interval: 0, due: 0, reps: 0, lastReviewAt: 0 }
const GRADE_TO_Q = [0, 2, 4, 5]

function applySM2 (review, gradeIdx, atMs) {
  const q = GRADE_TO_Q[gradeIdx]
  const r = { ...review }
  if (q < 3) {
    r.reps = 0
    r.interval = 0
  } else {
    if (r.reps === 0)      r.interval = 1
    else if (r.reps === 1) r.interval = 6
    else                   r.interval = Math.round(r.interval * r.ease)
    r.reps += 1
  }
  r.ease = Math.max(1.3, r.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  // Due time. 'Again' (q<3) pushes due 1 minute forward — long enough
  // that the card falls out of this session's derived queue, short
  // enough that it comes back next time. Encodes session-relevance in
  // the algorithm so the queue doesn't have to be a stateful array.
  r.due = q < 3
    ? atMs + 60 * 1000
    : atMs + r.interval * 24 * 60 * 60 * 1000
  // Track the moment of this grading. Mastery is a function of
  // elapsed time since this — climbs slowly between reviews, resets
  // (here) on each grade. So the bar is alive.
  r.lastReviewAt = atMs
  return r
}

// Translate a deckId into the address of its deck Repo. Bundled decks
// have a human-readable id ('greek-alphabet') and live at the address
// listed in homeRepo.flashcardsDecks. Forks have no separate id —
// their address IS their id. All reads here are recaller-tracked, so
// callers in slots auto-subscribe to updates in either source.
function addrFor (deckId) {
  if (!deckId) return null
  const fd = homeRepo?.get('flashcardsDecks') ?? {}
  return fd[deckId] ?? deckId
}

function deckRepo (deckId) {
  const addr = addrFor(deckId)
  return addr ? registry?.get(addr) : undefined
}

function deckCards (deckId) {
  return deckRepo(deckId)?.get('cards') ?? []
}

// SM-2 state derived by folding every review event for this card.
function reviewStateForCard (deckId, cardIdx) {
  const repo = reviewRepos.get(deckId)
  if (!repo) return { ...DEFAULT_REVIEW }
  const reviews = repo.get('reviews') ?? []
  let r = { ...DEFAULT_REVIEW }
  for (const ev of reviews) {
    if (ev.cardIdx === cardIdx) r = applySM2(r, ev.grade, ev.at)
  }
  return r
}

function deckStats (deckId) {
  const cards = deckCards(deckId)
  const active = activeCardIds(deckId)
  if (!cards.length) return { due: 0, new: 0, active: 0 }
  let due = 0, neu = 0, activeCount = 0
  const now = Date.now()
  for (let i = 0; i < cards.length; i++) {
    if (cards[i]?.deleted) continue
    if (active !== null && !active.has(i)) continue
    activeCount++
    const r = reviewStateForCard(deckId, i)
    if (r.reps === 0) neu++
    else if (r.due <= now) due++
  }
  return { due, new: neu, active: activeCount }
}

// Live-derived study queue: due cards first, then truly-new (never
// reviewed). Cards that have been reviewed and aren't yet due fall out
// — they'll be back when their due-time arrives. The queue is rebuilt
// on every read; session-relevance comes from the SM-2 due times in
// the reviews repo, not from a stateful array.
function buildStudyQueue (deckId) {
  const cards = deckCards(deckId)
  const active = activeCardIds(deckId)
  const due = [], neu = []
  const now = Date.now()
  for (let i = 0; i < cards.length; i++) {
    if (cards[i]?.deleted) continue   // soft-deleted cards don't appear in study
    if (active !== null && !active.has(i)) continue  // not in active set
    const r = reviewStateForCard(deckId, i)
    const everReviewed = r.due > 0  // DEFAULT_REVIEW has due=0; any grade sets a timestamp
    if (!everReviewed) neu.push(i)
    else if (r.due <= now) due.push(i)
    // else: in 'rest' — has reviews, not yet due. Not in the queue.
  }
  return [...due, ...neu]
}

// ── active set (partial-deck learning) ──────────────────────────────
//
// Per-(learner, deck) state stored in the reviews repo: which cards
// the learner is *currently* studying. Cards not in the active set
// are *available* (in the deck) but don't appear in the study queue.
//
// Legacy default: if `active` is undefined (learner has never touched
// the manage UI), treat as "all non-deleted cards are active" — so
// existing users see no behavior change until they explicitly opt in.
// Returns `null` for the legacy case so callers can short-circuit.

function activeCardIds (deckId) {
  const repo = reviewRepos.get(deckId)
  if (!repo) return null  // not ready — caller should treat as "all"
  const active = repo.get('active')
  if (active === undefined) return null  // legacy: all-active
  return new Set(active)
}

function isCardActive (deckId, cardIdx) {
  const active = activeCardIds(deckId)
  if (active === null) return true  // legacy default
  return active.has(cardIdx)
}

function toggleCardActive (deckId, cardIdx) {
  const repo = reviewRepos.get(deckId)
  if (!repo) return
  const value = repo.get() ?? { deck: deckId, reviews: [] }
  let activeArr = value.active
  if (activeArr === undefined) {
    // First touch — materialize the legacy "all" set so we can
    // meaningfully toggle one off. Includes all non-deleted card
    // indices for the current deck.
    const cards = deckCards(deckId)
    activeArr = []
    for (let i = 0; i < cards.length; i++) {
      if (!cards[i]?.deleted) activeArr.push(i)
    }
  }
  const set = new Set(activeArr)
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

const DAY_MS = 24 * 60 * 60 * 1000

// Mastery = log₂(1 + interval + elapsed_days_since_last_review).
// Two components:
//   - `interval` is the SM-2 interval set by the most recent grade —
//     the static commitment that *"you've earned this much."* Means the
//     bar is populated right after a grade (interval ≥ 1 for 'good'),
//     not empty. Visible reward for the work.
//   - `elapsed_days` is time since the grade — adds the live climb,
//     so the bar moves visibly while the user watches.
// Grading 'again' resets interval to 0 AND lastReviewAt to now;
// mastery falls back to ~0 and starts climbing fresh. Takes `now` so
// the calling slot can pass time.get() and re-render each tick.
function masteryOf (review, now) {
  if (!review || !review.lastReviewAt) return 0
  const elapsedDays = Math.max(0, (now - review.lastReviewAt) / DAY_MS)
  return Math.log2(1 + review.interval + elapsedDays)
}

// Map a mastery score to a color via smooth HSL interpolation between
// stops anchored at log-time positions. Color shifts FASTER than width
// at low mastery: red→yellow→green happens in the first ~30% of the
// bar, then colors stretch slowly toward blue across the rest.
//
// Stops chosen to land on clean intervals — yellow at 1.5 days
// (~19% bar width), green at 3 days (~29%). Past green: emerald at
// 1 week, teal at 1 month, blue at 3+ months. All chosen for
// legibility on white since the same color is used for both the bar
// fill and the text label.
function masteryColor (mastery) {
  const stops = [
    [0.00, 355, 80, 50],   // bright red — only the sliver
    [0.50,  20, 85, 48],   // red-orange transitioning
    [1.00,  35, 90, 45],   // amber
    [1.32,  45, 95, 40],   // fully yellow — 1.5 days
    [2.00, 140, 70, 38],   // fully green — 3 days
    [3.00, 160, 75, 30],   // emerald — 1 week
    [4.95, 190, 85, 30],   // teal — 1 month
    [6.50, 215, 75, 45]    // blue — 3+ months
  ]
  if (mastery <= stops[0][0]) {
    const [, h, s, l] = stops[0]
    return `hsl(${h}, ${s}%, ${l}%)`
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const [m1, h1, s1, l1] = stops[i]
    const [m2, h2, s2, l2] = stops[i + 1]
    if (mastery <= m2) {
      const t = (mastery - m1) / (m2 - m1)
      return `hsl(${Math.round(h1 + (h2 - h1) * t)}, ${Math.round(s1 + (s2 - s1) * t)}%, ${Math.round(l1 + (l2 - l1) * t)}%)`
    }
  }
  const [, h, s, l] = stops[stops.length - 1]
  return `hsl(${h}, ${s}%, ${l}%)`
}

function urgencyOf (review, nowMs) {
  if (!review || review.due === 0) return 0
  if (review.interval <= 0) return Math.max(0, (nowMs - review.due) / DAY_MS)
  return (nowMs - review.due) / (review.interval * DAY_MS)
}

// A short, human-readable string for "time until due" — or "overdue"
// if the moment has passed. Designed to be called inside a reactive
// slot that has already read time.get() (so the slot re-renders each
// tick). The function takes ms (not a Date) so callers can pass
// `(due - time.get())` cleanly.
function formatTimeUntil (deltaMs) {
  const abs = Math.abs(deltaMs)
  const overdue = deltaMs < 0
  let label
  if (abs < 60 * 1000) label = `${Math.floor(abs / 1000)}s`
  else if (abs < 60 * 60 * 1000) label = `${Math.floor(abs / 60000)}m`
  else if (abs < DAY_MS) label = `${Math.floor(abs / 3600000)}h`
  else label = `${Math.floor(abs / DAY_MS)}d`
  return overdue ? `overdue ${label}` : (deltaMs <= 0 ? 'now' : `in ${label}`)
}

// Mastery for the deck's *active set* — average over non-deleted,
// active, ever-reviewed cards. Represents "how well I know what I'm
// currently studying," not "the whole deck's potential." Returns 0
// if nothing's been reviewed yet.
function deckMastery (deckId, now) {
  const cards = deckCards(deckId)
  if (cards.length === 0) return 0
  const active = activeCardIds(deckId)
  let total = 0, n = 0
  for (let i = 0; i < cards.length; i++) {
    if (cards[i]?.deleted) continue
    if (active !== null && !active.has(i)) continue
    const r = reviewStateForCard(deckId, i)
    if (r.lastReviewAt) { total += masteryOf(r, now); n++ }
  }
  return n === 0 ? 0 : total / n
}

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

// Lazily open the reviews Repo for (this learner, this deck), fired
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
  registry = new RepoRegistry(undefined, { recaller, name: 'flashcards' })
  session = await registrySync(
    registry,
    location.hostname,
    +location.port || (location.protocol === 'https:' ? 443 : 80),
    {
      follow: (keyHex, repo, subscribe) => {
        const fd = repo.get('flashcardsDecks') ?? {}
        for (const deckKey of Object.values(fd)) subscribe(deckKey)
        const myDecks = repo.get('decks') ?? []
        for (const deckKey of myDecks) subscribe(deckKey)
      }
    }
  )

  // Two repos we DO need handles on: the home repo (so the home view
  // can read flashcardsDecks reactively) and the learner's deck-index
  // (same, for forks; also needed for the fork-action's write path).
  // No further awaitFields here — slots fill in as bytes arrive.
  const info = await fetch('/api/info').then(r => r.json())
  homeRepo = await registry.open(info.primaryKeyHex)

  const idxStream = 'flashcards:deck-index'
  const { publicKey: idxPub } = await signer.keysFor(idxStream)
  const idxKey = bytesToHex(idxPub)
  myDeckIndex = await session.subscribe(idxKey)
  myDeckIndex.attachSigner(signer, idxStream)

  state.set('connecting', false)
  state.set('loggedIn', true)
}

function logout () {
  signer = null
  registry = null
  session = null
  homeRepo = null
  myDeckIndex = null
  reviewRepos.set({})
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
}

// Reveal ties the flip to the SPECIFIC card we're showing right now.
// If the queue shifts before the user grades, `revealed()` returns
// false and the back auto-hides — and grade() applies to the card we
// revealed, not whatever queue[0] is at grade-time.
function reveal () { state.set('revealedCardIdx', currentCardIdx()) }

function grade (gradeIdx) {
  const deckId = activeDeck()
  const repo   = reviewRepos.get(deckId)
  if (!repo) return
  // Grade the card the user actually saw the back of — not whichever
  // card happens to top the queue now if it shifted.
  const cardIdx = state.get('revealedCardIdx')
  if (cardIdx == null) return
  const reviews = repo.get('reviews') ?? []
  repo.defaultMessage = `review: card ${cardIdx} graded ${['again', 'hard', 'good', 'easy'][gradeIdx]}`
  repo.set({
    deck: deckId,
    reviews: [...reviews, { cardIdx, grade: gradeIdx, at: Date.now() }]
  })
  // No queue mutation, no index advance — the commit above updates
  // the reviews repo, which shifts buildStudyQueue's output, which
  // makes the new queue[0] the next card. Clearing revealedCardIdx
  // tells the view to show the next card's front.
  state.set('revealedCardIdx', null)
}

// Fork a deck: derive a fresh keypair for this learner's fork, copy
// the upstream's cards into it, cite the upstream by address as a
// value-level `forkedFrom` field, and append the new address to the
// learner's deck-index Repo. Returns the new deck's id (pubkey-hex).
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

  const forkRepo = await session.subscribe(newDeckKey)
  forkRepo.attachSigner(signer, forkStream)
  forkRepo.defaultMessage = `fork of ${upstream.title}`
  forkRepo.set({
    title: `${upstream.title} (my fork)`,
    description: `forked from ${upstreamRepo.publicKeyHex.slice(0, 10)}…`,
    cards: [...upstream.cards],
    forkedFrom: upstreamRepo.publicKeyHex
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

// ── editor handlers ─────────────────────────────────────────────────
//
// The editor edits a fork's deck Repo. Each edit (save, delete, add)
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
  const queue = buildStudyQueue(deckId)
  if (queue.length === 0) return null  // session complete (or not yet started)
  return deckCards(deckId)[queue[0]]
}

// The card index that's currently being shown — used as a data-key on
// the card div so it recycles cleanly when grade() shifts the queue.
function currentCardIdx () {
  const deckId = activeDeck()
  if (!deckId) return null
  const queue = buildStudyQueue(deckId)
  return queue.length === 0 ? null : queue[0]
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

// ── URL hash routing ────────────────────────────────────────────────
//
// state.view + activeDeck are encoded in location.hash so the browser's
// back/forward buttons navigate between app screens. Format:
//   #study/<deckId>   — studying a deck
//   #edit/<deckId>    — editing a fork
//   #manage/<deckId>  — managing active set
//   (empty hash)      — home
//
// State → hash via a watcher (idempotent — only pushState when the
// hash actually needs to change). Hash → state via a `popstate` event
// listener (fires on back/forward). Both check-before-write so the
// two sides don't echo.

function stateToHashValue () {
  const v = state.get('view')
  const deck = state.get('activeDeck')
  if (v && v !== 'home' && deck) return `#${v}/${deck}`
  return ''
}

function applyHashToState () {
  const raw = location.hash.replace(/^#/, '')
  if (!raw) {
    if (state.get('view') !== 'home') state.set('view', 'home')
    if (state.get('activeDeck') !== null) state.set('activeDeck', null)
    return
  }
  const slash = raw.indexOf('/')
  if (slash < 0) return
  const view = raw.slice(0, slash)
  const deck = raw.slice(slash + 1)
  if (!['study', 'edit', 'manage'].includes(view) || !deck) return
  if (state.get('view') !== view) state.set('view', view)
  if (state.get('activeDeck') !== deck) state.set('activeDeck', deck)
}

recaller.watch('sync-state-to-url-hash', () => {
  if (!state.get('loggedIn')) return  // don't write hash before login
  const want = stateToHashValue()
  const current = location.hash
  if (current === want) return
  if (current === '' && want === '') return
  history.pushState(null, '', want || (location.pathname + location.search))
})

window.addEventListener('popstate', applyHashToState)

// ── mount ────────────────────────────────────────────────────────────

mount(h`
  <h1>
    <a class="brand-lockup" href="../../" title="streamo home">
      <img src="../../streamo.svg" alt="">streamo
    </a>
    <span class="page-title">flashcards</span>
  </h1>
  <p class="tagline">Tiny spaced-repetition where decks are real signed Repos on the relay and your reviews are a signed Repo you own. Each deck lives at its own address — bookmarkable, forkable, yours forever.</p>

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

  ${when(() => loggedIn() && view() === 'home', h`
    <h2>your decks</h2>
    <ul class="decks">
      ${() => {
        // Derive the deck list reactively from the two source repos.
        // Reading homeRepo.flashcardsDecks + myDeckIndex.decks here
        // subscribes the slot — any change (new fork, new bundled deck
        // appearing) re-renders the list automatically.
        const fd = homeRepo?.get('flashcardsDecks') ?? {}
        const myDecks = myDeckIndex?.get('decks') ?? []
        const entries = [
          ...Object.keys(fd).map(id => ({ id, addr: fd[id] })),
          ...myDecks.map(addr => ({ id: addr, addr }))
        ]
        if (entries.length === 0) return h`<li class="empty">discovering decks…</li>`
        return entries.map(({ id, addr }) => {
          const repo = registry.get(addr)
          const title = repo?.get('title') ?? '(loading…)'
          const description = repo?.get('description') ?? ''
          const isFork = !!repo?.get('forkedFrom')
          const s = deckStats(id)
          return h`
            <li class="deck" data-key=${id} onclick=${handle(() => startStudy(id))}>
              <div class="deck-title">${title}${isFork ? h`<span class="deck-badge">your fork</span>` : null}</div>
              <div class="deck-desc">${description}</div>
              <div class="deck-stats">
                <span class="due">${s.due} due</span>
                <span class="new">${s.new} new</span>
                <span>${s.active} active</span>
                <button class="manage-btn" onclick=${handle((e) => { e.stopPropagation(); enterManage(id) })}>manage</button>
                ${isFork
                  ? h`<button class="edit-btn" onclick=${handle((e) => { e.stopPropagation(); enterEdit(id) })}>edit</button>`
                  : h`<button class="fork-btn" onclick=${handle((e) => { e.stopPropagation(); forkDeck(id) })}>fork</button>`}
              </div>
              ${() => {
                // Live mastery summary — climbs with elapsed time since
                // last review. Reads time.get() so the slot re-renders
                // every second; reads reviews repo so it also updates on
                // grades. Bar width and label color both map to the same
                // mastery value; no gradient stretching, no decorative
                // baked-in colors that don't mean anything.
                const now = time.get()
                const m = deckMastery(id, now)
                if (m === 0) return null
                const pct = Math.min(100, (m / 7) * 100)
                const color = masteryColor(m)
                return h`
                  <div class="deck-mastery" title="average mastery: ${m.toFixed(7)} / 7" style=${`color: ${color}`}>
                    <div class="deck-mastery-bar" style=${`width:${pct.toFixed(0)}%`}></div>
                  </div>
                  <div class="deck-mastery-label" style=${`color: ${color}`}>mastery ${m.toFixed(7)}</div>
                `
              }}
              ${() => {
                // Live next-up strip. Reads time.get() so it ticks
                // every second; reads reviewRepo (via active set +
                // reviewStateForCard) so it updates when grades land
                // and when the manage view toggles active membership.
                const cards = deckCards(id)
                if (cards.length === 0) return null
                const active = activeCardIds(id)
                const now = time.get()
                const upcoming = []
                for (let i = 0; i < cards.length; i++) {
                  if (cards[i]?.deleted) continue
                  if (active !== null && !active.has(i)) continue  // active set only
                  const r = reviewStateForCard(id, i)
                  const due = r.due === 0 ? now : r.due  // new cards are "now"
                  upcoming.push({ idx: i, due })
                }
                upcoming.sort((a, b) => a.due - b.due)
                const next5 = upcoming.slice(0, 5)
                if (next5.length === 0) return null
                return h`
                  <div class="deck-schedule">
                    <span class="deck-schedule-label">next ${next5.length}:</span>
                    ${next5.map((c, i) => h`<span class="deck-schedule-tick" data-key=${`tick-${i}`}>${formatTimeUntil(c.due - now)}</span>`)}
                  </div>
                `
              }}
            </li>
          `
        })
      }}
    </ul>
    ${() => {
      // Explorer link: jump to the learner's deck-index repo (always
      // open after login). Previously linked to a reviews repo, which
      // is now lazy — this is a better default anyway: "see your decks
      // in the explorer" is the more honest framing.
      if (!myDeckIndex) return null
      return h`<a class="explorer-link" href=${`../explorer/#/repo/${myDeckIndex.publicKeyHex}`}>see your decks in the explorer →</a>`
    }}
  `)}

  ${when(() => loggedIn() && view() === 'study', h`
    <div class="study">
      <div class="study-header">
        <button class="study-back" onclick=${handle(backToHome)}>← back</button>
        <span>${() => {
          const deckId = activeDeck()
          const title  = deckRepo(deckId)?.get('title') ?? ''
          // Live count: derived from the queue each render.
          const remaining = buildStudyQueue(deckId).length
          return title ? `${title} · ${remaining} left` : ''
        }}</span>
      </div>
      ${() => {
        // Pure data → html. If the deck repo hasn't loaded yet, show
        // a loading message. Otherwise render whatever the current
        // queue says is the next card — for returning learners this
        // may flash briefly from "card[0] (empty review state)" to
        // "actual due card (loaded review state)"; small papercut,
        // not silent failure.
        const deckId = activeDeck()
        const cards = deckCards(deckId)
        if (cards.length === 0) {
          return h`<div class="done"><p>loading deck…</p></div>`
        }
        const card = currentCard()
        if (!card) {
          return h`
            <div class="done">
              <h3>session complete 🌳</h3>
              <p>come back tomorrow, or browse another deck.</p>
              <button class="reveal-btn" style="margin-top: 1.25rem;" onclick=${handle(backToHome)}>back to decks</button>
            </div>
          `
        }
        return h`
          <div class="card" data-key=${`card-${currentCardIdx()}`}>
            <div class="card-front">${card.front}</div>
            ${when(revealed, h`<div class="card-back">${() => currentCard()?.back ?? ''}</div>`)}
          </div>
          ${() => revealed()
            ? h`
              <div class="grades">
                <button class="grade-again" onclick=${handle(() => grade(0))}>again</button>
                <button class="grade-hard"  onclick=${handle(() => grade(1))}>hard</button>
                <button class="grade-good"  onclick=${handle(() => grade(2))}>good</button>
                <button class="grade-easy"  onclick=${handle(() => grade(3))}>easy</button>
              </div>
            `
            : h`<button class="reveal-btn" onclick=${handle(reveal)}>reveal</button>`
          }
        `
      }}
    </div>
  `)}

  ${when(() => loggedIn() && view() === 'edit', h`
    <div class="edit">
      <div class="study-header">
        <button class="study-back" onclick=${handle(exitEdit)}>← back</button>
        <span>${() => {
          const deckId = activeDeck()
          const title = deckRepo(deckId)?.get('title') ?? ''
          return title ? `editing: ${title}` : 'editing…'
        }}</span>
      </div>

      ${() => {
        const deckId = activeDeck()
        const repo = deckRepo(deckId)
        const deck = repo?.get()
        if (!deck) return h`<p class="hint">loading deck…</p>`
        const upstreamAddr = deck.forkedFrom
        if (!upstreamAddr) return null
        return h`<p class="hint edit-lineage">forked from <a class="explorer-link" style="margin-top:0" href=${`../explorer/#/repo/${upstreamAddr}`}>${upstreamAddr.slice(0, 10)}…</a></p>`
      }}

      <ul class="edit-cards">
        ${() => {
          const deckId = activeDeck()
          const cards = deckCards(deckId)
          const editingIdx = state.get('editingCardIdx')
          if (cards.length === 0 && editingIdx !== -1) {
            return h`<li class="empty">no cards yet — click '+ add card' below.</li>`
          }
          // Render existing (non-deleted) cards; render the "new card"
          // form at the end if editingIdx === -1.
          const items = []
          for (let i = 0; i < cards.length; i++) {
            const card = cards[i]
            if (card?.deleted) continue
            if (editingIdx === i) {
              items.push(h`
                <li class="edit-card edit-card-editing" data-key=${`edit-${i}`}>
                  <form onsubmit=${handle(saveCard)}>
                    <input name="front" placeholder="front" value=${card.front ?? ''} autofocus>
                    <input name="back" placeholder="back" value=${card.back ?? ''}>
                    <div class="edit-card-actions">
                      <button class="save-btn">save</button>
                      <button type="button" class="cancel-btn" onclick=${handle(cancelEditCard)}>cancel</button>
                    </div>
                  </form>
                </li>
              `)
            } else {
              items.push(h`
                <li class="edit-card" data-key=${`view-${i}`}>
                  <div class="edit-card-front">${card.front || '(blank)'}</div>
                  <div class="edit-card-back">${card.back || ''}</div>
                  <div class="edit-card-actions">
                    <button class="edit-card-btn" onclick=${handle(() => startEditCard(i))}>edit</button>
                    <button class="edit-card-btn delete" onclick=${handle(() => deleteCard(i))}>delete</button>
                  </div>
                </li>
              `)
            }
          }
          if (editingIdx === -1) {
            items.push(h`
              <li class="edit-card edit-card-editing edit-card-new" data-key="new">
                <form onsubmit=${handle(saveCard)}>
                  <input name="front" placeholder="front" autofocus>
                  <input name="back" placeholder="back">
                  <div class="edit-card-actions">
                    <button class="save-btn">add</button>
                    <button type="button" class="cancel-btn" onclick=${handle(cancelEditCard)}>cancel</button>
                  </div>
                </form>
              </li>
            `)
          }
          return items
        }}
      </ul>

      ${() => state.get('editingCardIdx') === -1
        ? null
        : h`<button class="add-card-btn" onclick=${handle(addCard)}>+ add card</button>`}
    </div>
  `)}

  ${when(() => loggedIn() && view() === 'manage', h`
    <div class="manage">
      <div class="study-header">
        <button class="study-back" onclick=${handle(exitManage)}>← back</button>
        <span>${() => {
          const deckId = activeDeck()
          const title = deckRepo(deckId)?.get('title') ?? ''
          return title ? `cards: ${title}` : 'cards…'
        }}</span>
      </div>
      <p class="hint">tap a card to add it to or remove it from your active study set. cards in <em>available</em> stay in the deck but don't appear in study sessions until you add them back.</p>

      ${() => {
        const deckId = activeDeck()
        const cards = deckCards(deckId)
        const now = time.get()  // alive: per-card mastery climbs each tick
        if (cards.length === 0) return h`<p class="empty">no cards in this deck yet.</p>`

        // Partition into active and available, preserving original indices.
        const activeList = [], availableList = []
        for (let i = 0; i < cards.length; i++) {
          if (cards[i]?.deleted) continue
          if (isCardActive(deckId, i)) activeList.push(i)
          else availableList.push(i)
        }

        const renderCard = (i, isActive) => {
          const card = cards[i]
          const review = reviewStateForCard(deckId, i)
          const mastery = masteryOf(review, now)
          const masteryPct = Math.min(100, (mastery / 7) * 100)
          const color = masteryColor(mastery)
          return h`
            <li class="manage-card ${isActive ? 'manage-card-active' : 'manage-card-available'}"
                data-key=${`manage-${i}`}
                onclick=${handle(() => toggleCardActive(deckId, i))}>
              <div class="manage-card-content">
                <div class="manage-card-front">${card.front || '(blank)'}</div>
                <div class="manage-card-back">${card.back || ''}</div>
              </div>
              ${review.lastReviewAt
                ? h`<div class="manage-card-mastery" title=${`mastery: ${mastery.toFixed(7)} / 7`} style=${`color: ${color}`}>
                     <div class="manage-card-mastery-bar" style=${`width:${masteryPct.toFixed(0)}%`}></div>
                   </div>
                   <div class="manage-card-mastery-label" style=${`color: ${color}`}>mastery ${mastery.toFixed(7)}</div>`
                : null}
              <span class="manage-card-toggle">${isActive ? 'remove' : 'add'}</span>
            </li>
          `
        }

        return h`
          <h3 class="manage-section">active <span class="manage-count">(${activeList.length})</span></h3>
          ${activeList.length === 0
            ? h`<p class="empty">no active cards yet — tap one from <em>available</em> below to start learning it.</p>`
            : h`<ul class="manage-cards">${activeList.map(i => renderCard(i, true))}</ul>`}
          <h3 class="manage-section">available <span class="manage-count">(${availableList.length})</span></h3>
          ${availableList.length === 0
            ? h`<p class="empty">all cards in this deck are currently active.</p>`
            : h`<ul class="manage-cards">${availableList.map(i => renderCard(i, false))}</ul>`}
        `
      }}
    </div>
  `)}
`, document.body, recaller)

