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
import { liveObject }   from '../../streamo/LiveSource.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { bytesToHex }   from '../../streamo/utils.js'

const when = (cond, vnode) => () => cond() ? vnode : null

// ── app-level state ──────────────────────────────────────────────────

const recaller = new Recaller('flashcards')

// Reviews repos are opened lazily — when the learner clicks Study on
// a deck — so login doesn't pay an O(decks) cost in repos-and-wire
// activity. Deck repos themselves are NOT held in a parallel
// LiveSource: they live in the registry, which is itself a reactive
// LiveSource (registry.get reports access on (this, 'keys')), so
// reads in slots auto-subscribe.
const reviewRepos = liveObject({}, { recaller, name: 'reviewRepos' })

const state = liveObject({
  loggedIn:   false,
  connecting: false,  // true while login → connect → subscribe(deck-index)
  user:       null,   // { username, pubkey } once logged in
  view:       'home', // 'home' | 'study'
  activeDeck: null,   // deck id while studying
  revealed:   false   // is the back of the current card shown?
  // No studyQueue, no currentIdx — both derive from the reviews repo
  // each render. The "next card" is buildStudyQueue[0]; grading commits
  // a review event and the queue shifts naturally as a side effect.
}, { recaller, name: 'app' })

const loggedIn   = () => state.get('loggedIn')
const connecting = () => state.get('connecting')
const user       = () => state.get('user')
const view       = () => state.get('view')
const activeDeck = () => state.get('activeDeck')
const revealed   = () => state.get('revealed')

// Module-level handles populated by login(); reset by logout().
let signer = null
let registry = null
let session = null
let homeRepo = null     // the relay's home repo, source of bundled-deck addresses
let myDeckIndex = null  // learner's deck-index Repo: { decks: [<pubkey-hex>, ...] }

// ── SM-2 lite ────────────────────────────────────────────────────────

const DEFAULT_REVIEW = { ease: 2.5, interval: 0, due: 0, reps: 0 }
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
  if (!cards.length) return { due: 0, new: 0, total: 0 }
  let due = 0, neu = 0
  const now = Date.now()
  for (let i = 0; i < cards.length; i++) {
    const r = reviewStateForCard(deckId, i)
    if (r.reps === 0) neu++
    else if (r.due <= now) due++
  }
  return { due, new: neu, total: cards.length }
}

// Live-derived study queue: due cards first, then truly-new (never
// reviewed). Cards that have been reviewed and aren't yet due fall out
// — they'll be back when their due-time arrives. The queue is rebuilt
// on every read; session-relevance comes from the SM-2 due times in
// the reviews repo, not from a stateful array.
function buildStudyQueue (deckId) {
  const cards = deckCards(deckId)
  const due = [], neu = []
  const now = Date.now()
  for (let i = 0; i < cards.length; i++) {
    const r = reviewStateForCard(deckId, i)
    const everReviewed = r.due > 0  // DEFAULT_REVIEW has due=0; any grade sets a timestamp
    if (!everReviewed) neu.push(i)
    else if (r.due <= now) due.push(i)
    // else: in 'rest' — has reviews, not yet due. Not in the queue.
  }
  return [...due, ...neu]
}

// ── reactive readiness gates ─────────────────────────────────────────
//
// For repos we WRITE to, we need to know the relay's current state
// before the first write — otherwise our commit lands on the wrong
// chain head and either overwrites existing history (if our local
// chain is shorter) or gets pushRejected. Two writes-on-open in this
// app: appending to the learner's deck-index on fork, appending to a
// reviews repo on grade.
//
// Instead of pre-awaiting at open-time (a UX wall), we open
// immediately and "gate" the write action with a reactive ready
// check: the action's button only appears (or fires) when the relevant
// field has arrived OR a fallback timeout has elapsed. The timeout is
// a `setTimeout` that flips a state flag — itself recaller-tracked —
// so both branches of the gate are reactive.

function scheduleReady (repo, fieldName, key, timeoutMs = 2000) {
  // No-op if already ready (avoid stacking timeouts on repeat opens).
  if (repo.get(fieldName) !== undefined) return
  if (state.get(`ready-${key}`)) return
  setTimeout(() => state.set(`ready-${key}`, true), timeoutMs)
}

function isReady (repo, fieldName, key) {
  if (!repo) return false
  if (repo.get(fieldName) !== undefined) return true
  return state.get(`ready-${key}`) === true
}

// ── repo opening ─────────────────────────────────────────────────────

// Lazily open the reviews Repo for (this learner, this deck) on the
// first study-click. The deck-scoped stream name derives a fresh
// keypair from the learner's root credentials; same login, different
// repo per deck.
//
// No pre-await on the `reviews` field — instead, the grade buttons in
// the study view gate themselves on `isReady(reviewRepo, 'reviews',
// reviewsKey)`. View switches instantly; buttons appear when ready.
async function ensureReviewsRepo (deckId) {
  const existing = reviewRepos.get(deckId)
  if (existing) return existing
  const streamName = `flashcards:reviews:${deckId}`
  const { publicKey } = await signer.keysFor(streamName)
  const repoKey = bytesToHex(publicKey)
  const repo = await session.subscribe(repoKey)
  repo.attachSigner(signer, streamName)
  reviewRepos.set(deckId, repo)
  scheduleReady(repo, 'reviews', `reviews-${deckId}`, 2000)
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
  // Reactive readiness instead of an await: the Fork button gates
  // itself on `isReady(myDeckIndex, 'decks', ...)`. Login doesn't
  // wall on it.
  scheduleReady(myDeckIndex, 'decks', 'deck-index', 3000)

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
    activeDeck: null,
    revealed:   false
  })
}

// Purely declarative. Setting activeDeck triggers the
// 'ensure-reviews-for-active-deck' watcher below to open the reviews
// repo as a side effect; the study view's reactive gate handles the
// "wait until ready" UX. No await here, no side effects in the click
// path — state change in, side effect out, the unidirectional shape.
function startStudy (deckId) {
  state.set('activeDeck', deckId)
  state.set('revealed', false)
  state.set('view', 'study')
}

function backToHome () {
  state.set('view', 'home')
  state.set('activeDeck', null)
}

function reveal () { state.set('revealed', true) }

function grade (gradeIdx) {
  const deckId = activeDeck()
  const repo   = reviewRepos.get(deckId)
  if (!repo) return
  // The current card is whichever one tops the live queue right now.
  const queue = buildStudyQueue(deckId)
  if (queue.length === 0) return
  const cardIdx = queue[0]
  const reviews = repo.get('reviews') ?? []
  repo.defaultMessage = `review: card ${cardIdx} graded ${['again', 'hard', 'good', 'easy'][gradeIdx]}`
  repo.set({
    deck: deckId,
    reviews: [...reviews, { cardIdx, grade: gradeIdx, at: Date.now() }]
  })
  // No queue mutation, no index advance — the commit above updates
  // the reviews repo, which shifts buildStudyQueue's output, which
  // makes the new queue[0] the next card. Just hide the back so the
  // next card's front is what's shown.
  state.set('revealed', false)
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

recaller.watch('ensure-reviews-for-active-deck', () => {
  const deckId = state.get('activeDeck')
  if (!deckId) return                            // home view, nothing to open
  if (reviewRepos.get(deckId)) return            // already opened
  if (!signer || !session) return                // not yet logged in / connected
  ensureReviewsRepo(deckId)                      // fire and forget
})

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
        // The Fork button is gated on the learner's deck-index being
        // ready (either bytes arrived or the timeout flag flipped) —
        // forking before the existing fork list has loaded would
        // overwrite history. The deck row itself renders regardless.
        const forkReady = isReady(myDeckIndex, 'decks', 'deck-index')
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
                <span>${s.total} total</span>
                ${isFork || !forkReady
                  ? null
                  : h`<button class="fork-btn" onclick=${handle((e) => { e.stopPropagation(); forkDeck(id) })}>fork</button>`}
              </div>
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
        // Gate the card display on reviews being ready — otherwise a
        // returning learner sees card[0] briefly before the loaded
        // reviews re-derive the queue to a different first card. With
        // the gate, the card area shows 'loading review state…' until
        // reviews land (or the readiness timeout flips for new decks),
        // then settles on the correct first card.
        const deckId = activeDeck()
        const reviewRepo = reviewRepos.get(deckId)
        if (!isReady(reviewRepo, 'reviews', `reviews-${deckId}`)) {
          return h`<div class="done"><p>loading review state…</p></div>`
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
`, document.body, recaller)

