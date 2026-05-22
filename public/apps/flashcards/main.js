// flashcards — spaced-repetition demo on streamo.
//
// Step 2: reviews are real signed streamo Repos. Login derives the
// learner's root keypair via Signer; for each bundled deck we derive
// a deck-scoped subkey (`flashcards:reviews:<deckId>`) — same root
// credentials, infinitely many addressable repos. Each grade appends
// a signed commit to the reviews Repo; SM-2 state is recomputed by
// folding over `reviews[]`. The deck itself is still a static JSON
// file in step 2 — step 3 makes decks real Repos too.

import { h }            from '../../streamo/h.js'
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

// Bundled decks shipped with the app. In step 3 these become deck
// Repos addressable on the relay; for now they're static JSON files.
const BUNDLED_DECKS = [
  { id: 'greek-alphabet', path: './decks/greek-alphabet.json' }
]

// Loaded deck content, keyed by id. Populated by loadDecks() at startup.
const decks = liveObject({}, { recaller, name: 'decks' })

// Reviews repos, keyed by deck id. One per (learner, deck), opened
// after login. Reading these reactively is what makes deck stats and
// study state auto-update across the UI without manual refresh hooks.
const reviewRepos = liveObject({}, { recaller, name: 'reviewRepos' })

const state = liveObject({
  loggedIn:   false,
  connecting: false,    // true while login → registry → repos
  user:       null,     // { username, pubkey } once logged in
  view:       'home',   // 'home' | 'study'
  activeDeck: null,     // deck id while studying
  currentIdx: 0,        // pointer into studyQueue
  revealed:   false,    // is the back of the current card shown?
  studyQueue: []        // array of card indices for this session
}, { recaller, name: 'app' })

const loggedIn   = () => state.get('loggedIn')
const connecting = () => state.get('connecting')
const user       = () => state.get('user')
const view       = () => state.get('view')
const activeDeck = () => state.get('activeDeck')
const currentIdx = () => state.get('currentIdx')
const revealed   = () => state.get('revealed')

// Module-level handles populated by login(); reset by logout().
let signer = null
let registry = null

// ── SM-2 lite (the algorithm Anki et al. use) ────────────────────────
//
// Per-card state: { ease, interval (days), due (ms epoch), reps },
// recomputed by folding over the reviews Repo's event log. Grade
// buttons map to SM-2's 0..5 q-scale: again→0, hard→2, good→4, easy→5.
// Fails (q<3) reset reps and re-queue the card later in the session.

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
  r.due = atMs + r.interval * 24 * 60 * 60 * 1000
  return r
}

// Fold every review event for this card to derive current SM-2 state.
// The reviews Repo holds the event log; SM-2 state is never stored,
// always recomputed. Cheap (most cards have very few events).
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

// Walk a deck's review state. Returns { due, new, total }. Reactive:
// reads from the reviews Repo, so this re-renders on every grade.
function deckStats (deckId) {
  const deck = decks.get(deckId)
  if (!deck) return { due: 0, new: 0, total: 0 }
  let due = 0, neu = 0
  const now = Date.now()
  for (let i = 0; i < deck.cards.length; i++) {
    const r = reviewStateForCard(deckId, i)
    if (r.reps === 0) neu++
    else if (r.due <= now) due++
  }
  return { due, new: neu, total: deck.cards.length }
}

// Build the study queue: due cards first, then new, then (so the app
// is always usable for the demo) the rest in deck order.
function buildStudyQueue (deckId) {
  const deck = decks.get(deckId)
  const due = [], neu = [], rest = []
  const now = Date.now()
  for (let i = 0; i < deck.cards.length; i++) {
    const r = reviewStateForCard(deckId, i)
    if (r.reps === 0) neu.push(i)
    else if (r.due <= now) due.push(i)
    else rest.push(i)
  }
  return [...due, ...neu, ...rest]
}

// ── repo opening ─────────────────────────────────────────────────────

// Open (or create — same call) the reviews Repo for (this learner, this
// deck). The deck-scoped stream name derives a fresh keypair from the
// learner's root credentials; same login, different repo per deck.
async function openReviewsRepo (deckId) {
  const streamName = `flashcards:reviews:${deckId}`
  const { publicKey } = await signer.keysFor(streamName)
  const repoKey = bytesToHex(publicKey)
  const repo = await registry.open(repoKey)
  repo.attachSigner(signer, streamName)
  repo._flashcardsKey = repoKey  // stashed for the explorer link
  reviewRepos.set(deckId, repo)
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

  // Identity: derive the learner's "root" pubkey for display. Each
  // deck-scoped Repo derives its own subkey from these credentials.
  signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('flashcards')
  state.set('user', { username, pubkey: bytesToHex(publicKey) })

  // Connect to the registry and open reviews repos for every bundled
  // deck up front. Eager because (a) the home view needs each deck's
  // stats, (b) we only ship a couple of decks, (c) opening is cheap
  // — repos are empty until you grade something.
  registry = new RepoRegistry(undefined, { recaller, name: 'flashcards' })
  await registrySync(registry, location.hostname, +location.port || (location.protocol === 'https:' ? 443 : 80))
  for (const { id } of BUNDLED_DECKS) {
    await openReviewsRepo(id)
  }

  state.set('connecting', false)
  state.set('loggedIn', true)
}

function logout () {
  signer = null
  registry = null
  // Clear the reviewRepos liveObject by replacing target wholesale.
  // The recaller fires on '__root__' so the home view re-renders empty.
  reviewRepos.set({})
  state.set('user', null)
  state.set('loggedIn', false)
  state.set('view', 'home')
  state.set('activeDeck', null)
}

function startStudy (deckId) {
  const queue = buildStudyQueue(deckId)
  state.set('activeDeck', deckId)
  state.set('studyQueue', queue)
  state.set('currentIdx', 0)
  state.set('revealed', false)
  state.set('view', 'study')
}

function backToHome () {
  state.set('view', 'home')
  state.set('activeDeck', null)
}

function reveal () { state.set('revealed', true) }

function grade (gradeIdx) {
  const deckId  = activeDeck()
  const queue   = state.get('studyQueue')
  const idx     = currentIdx()
  const cardIdx = queue[idx]
  const repo    = reviewRepos.get(deckId)
  if (!repo) return
  // Append a review event to the reviews Repo — this is a signed
  // commit. The deck reference stays a stable id today; in step 3 it
  // becomes the deck Repo's address.
  const reviews = repo.get('reviews') ?? []
  repo.defaultMessage = `review: card ${cardIdx} graded ${['again', 'hard', 'good', 'easy'][gradeIdx]}`
  repo.set({
    deck: deckId,
    reviews: [...reviews, { cardIdx, grade: gradeIdx, at: Date.now() }]
  })
  // "Again" → re-queue at the end so the user sees it later this session.
  if (gradeIdx === 0) {
    state.set('studyQueue', [...queue, cardIdx])
  }
  state.set('currentIdx', idx + 1)
  state.set('revealed', false)
}

// ── data loading ─────────────────────────────────────────────────────

async function loadDecks () {
  for (const d of BUNDLED_DECKS) {
    const r = await fetch(d.path)
    const json = await r.json()
    decks.set(d.id, json)
  }
}

// ── view helpers ─────────────────────────────────────────────────────

function currentCard () {
  const deckId = activeDeck()
  const deck   = decks.get(deckId)
  if (!deck) return null
  const queue  = state.get('studyQueue')
  const idx    = currentIdx()
  if (idx >= queue.length) return null  // session complete
  return deck.cards[queue[idx]]
}

// ── boot ─────────────────────────────────────────────────────────────

loadDecks()

// ── mount ────────────────────────────────────────────────────────────

mount(h`
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 15px;
      color: #1c1917;
    }
    body {
      max-width: 36rem;
      margin: 0 auto;
      padding: 2.5rem 1.25rem;
      line-height: 1.55;
    }

    .brand-lockup {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      color: inherit;
      text-decoration: none;
      font-weight: 600;
      font-size: 1.4rem;
    }
    .brand-lockup img { width: 1.6rem; height: 1.6rem; }
    .brand-lockup:hover { opacity: 0.85; }
    .page-title {
      font-weight: 400;
      color: #888;
      letter-spacing: .04em;
      font-size: 0.9rem;
      margin-left: 0.5rem;
    }
    .page-title::before { content: '· '; opacity: 0.5; }
    h1 { display: flex; align-items: baseline; margin-bottom: 0.4rem; }
    .tagline {
      color: #666;
      font-size: 0.92rem;
      margin-bottom: 1.75rem;
    }
    h2 {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #888;
      margin: 1.75rem 0 0.65rem;
      font-weight: 500;
    }
    .who {
      font-size: 0.78rem;
      color: #888;
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      margin-top: -0.4rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }
    .who code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #555;
    }
    .who button {
      background: none;
      border: none;
      color: #1d4ed8;
      font-size: 0.78rem;
      cursor: pointer;
      padding: 0;
      text-decoration: underline dotted;
      font-family: inherit;
    }

    .login { display: flex; flex-direction: column; gap: 0.5rem; }
    .login input {
      padding: 0.5rem 0.75rem;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 1rem;
      font-family: monospace;
    }
    .login input:focus { outline: none; border-color: #1d4ed8; }
    .login input:disabled { background: #f9f9f9; }
    .login button {
      padding: 0.55rem 1.1rem;
      background: #1d4ed8;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 0.95rem;
      cursor: pointer;
      font-family: inherit;
      align-self: flex-start;
    }
    .login button:hover { opacity: 0.88; }
    .hint {
      font-size: 0.82rem;
      color: #888;
      margin-top: 0.5rem;
      font-style: italic;
    }
    .connecting {
      color: #1d4ed8;
      font-size: 0.88rem;
      padding: 0.5rem 0;
    }

    .decks {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: 0;
      margin: 0;
    }
    .deck {
      padding: 1rem 1.1rem;
      border: 1px solid #eee;
      border-radius: 8px;
      background: white;
      cursor: pointer;
      transition: border-color 0.15s, transform 0.05s;
    }
    .deck:hover { border-color: #1d4ed8; }
    .deck:active { transform: scale(0.99); }
    .deck-title {
      font-size: 1.05rem;
      font-weight: 600;
      margin-bottom: 0.3rem;
    }
    .deck-desc {
      font-size: 0.88rem;
      color: #555;
      margin-bottom: 0.55rem;
      line-height: 1.45;
    }
    .deck-stats {
      display: flex;
      gap: 0.85rem;
      font-size: 0.78rem;
      color: #888;
      font-variant-numeric: tabular-nums;
    }
    .deck-stats .due  { color: #b91c1c; }
    .deck-stats .new  { color: #047857; }

    .study {
      padding: 1.5rem 0 0;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 1rem;
    }
    .study-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      font-size: 0.85rem;
      color: #666;
    }
    .study-back {
      background: none;
      border: none;
      color: #1d4ed8;
      font-size: 0.85rem;
      cursor: pointer;
      padding: 0;
      text-decoration: underline dotted;
      font-family: inherit;
    }
    .card {
      border: 1px solid #ddd;
      border-radius: 10px;
      padding: 3rem 1.5rem;
      background: white;
      min-height: 11rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.25rem;
      text-align: center;
    }
    .card-front {
      font-size: 2.6rem;
      font-weight: 500;
      line-height: 1.2;
    }
    .card-back {
      font-size: 1.2rem;
      color: #555;
      border-top: 1px solid #eee;
      padding-top: 1.25rem;
      width: 100%;
    }
    .reveal-btn {
      align-self: center;
      padding: 0.55rem 1.5rem;
      background: white;
      border: 1px solid #1d4ed8;
      color: #1d4ed8;
      border-radius: 6px;
      font-size: 0.92rem;
      cursor: pointer;
      font-family: inherit;
    }
    .reveal-btn:hover { background: #1d4ed8; color: white; }
    .grades {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.5rem;
    }
    .grades button {
      padding: 0.7rem 0.3rem;
      border-radius: 6px;
      font-size: 0.9rem;
      cursor: pointer;
      font-family: inherit;
      border: 1px solid;
      background: white;
    }
    .grade-again { color: #b91c1c; border-color: #fecaca; }
    .grade-hard  { color: #b45309; border-color: #fed7aa; }
    .grade-good  { color: #047857; border-color: #a7f3d0; }
    .grade-easy  { color: #1d4ed8; border-color: #bfdbfe; }
    .grades button:hover { background: #fafafa; }
    .done {
      text-align: center;
      padding: 2rem 1rem;
      color: #555;
    }
    .done h3 { font-weight: 500; font-size: 1.1rem; margin-bottom: 0.5rem; }
    .empty {
      font-size: 0.88rem;
      color: #999;
      font-style: italic;
      padding: 0.75rem 0;
    }
    .explorer-link {
      font-size: 0.82rem;
      color: #1d4ed8;
      text-decoration: none;
      border-bottom: 1px dotted;
      display: inline-block;
      margin-top: 1.25rem;
    }
    .explorer-link:hover { border-bottom-style: solid; }
  </style>

  <h1>
    <a class="brand-lockup" href="../../" title="streamo home">
      <img src="../../streamo.svg" alt="">streamo
    </a>
    <span class="page-title">flashcards</span>
  </h1>
  <p class="tagline">Tiny spaced-repetition where your reviews are a signed Repo you own. Each deck you study lives at its own address — bookmarkable, forkable, yours forever.</p>

  ${when(() => !loggedIn() && !connecting(), h`
    <h2>identity</h2>
    <form class="login" onsubmit=${() => login}>
      <input name="username" placeholder="username" autocomplete="username">
      <input name="password" type="password" placeholder="password" autocomplete="current-password">
      <button>sign in</button>
    </form>
    <p class="hint">Your username + password derive a keypair locally — no account, no server. Each deck you study gets its own derived subkey, so one login signs many repos.</p>
  `)}

  ${when(connecting, h`
    <p class="connecting">connecting to the relay and opening your reviews repos…</p>
  `)}

  ${when(loggedIn, h`
    <div class="who">
      <span>signed in as <code>${() => user()?.username ?? ''}</code> · <code>${() => (user()?.pubkey ?? '').slice(0, 10)}…</code></span>
      <button onclick=${() => logout}>sign out</button>
    </div>
  `)}

  ${when(() => loggedIn() && view() === 'home', h`
    <h2>your decks</h2>
    <ul class="decks">
      ${() => {
        const items = []
        for (const { id } of BUNDLED_DECKS) {
          const deck = decks.get(id)
          if (!deck) {
            items.push(h`<li class="empty" data-key=${`loading-${id}`}>loading…</li>`)
            continue
          }
          const s = deckStats(id)
          items.push(h`
            <li class="deck" data-key=${id} data-action="study" data-deck=${id}>
              <div class="deck-title">${deck.title}</div>
              <div class="deck-desc">${deck.description}</div>
              <div class="deck-stats">
                <span class="due">${s.due} due</span>
                <span class="new">${s.new} new</span>
                <span>${s.total} total</span>
              </div>
            </li>
          `)
        }
        return items
      }}
    </ul>
    <p class="hint">More decks coming — HTTP status codes, US state capitals.</p>
    ${() => {
      // Surface the most-recently-touched reviews Repo as an
      // explorer link, so you can see your signed reviews land.
      const ids = Object.keys(reviewRepos.target)
      if (ids.length === 0) return null
      const id = ids[0]
      const repo = reviewRepos.get(id)
      if (!repo) return null
      return h`<a class="explorer-link" href=${`../explorer/#/repo/${repo._flashcardsKey}`}>see your reviews in the explorer →</a>`
    }}
  `)}

  ${when(() => loggedIn() && view() === 'study', h`
    <div class="study">
      <div class="study-header">
        <button class="study-back" onclick=${() => backToHome}>← back</button>
        <span>${() => {
          const deck = decks.get(activeDeck())
          const queue = state.get('studyQueue')
          const idx = currentIdx()
          if (!deck) return ''
          const remaining = Math.max(0, queue.length - idx)
          return `${deck.title} · ${remaining} left`
        }}</span>
      </div>
      ${() => {
        const card = currentCard()
        if (!card) {
          return h`
            <div class="done">
              <h3>session complete 🌳</h3>
              <p>come back tomorrow, or browse another deck.</p>
              <button class="reveal-btn" style="margin-top: 1.25rem;" onclick=${() => backToHome}>back to decks</button>
            </div>
          `
        }
        return h`
          <div class="card" data-key=${`card-${currentIdx()}`}>
            <div class="card-front">${card.front}</div>
            ${when(revealed, h`<div class="card-back">${() => currentCard()?.back ?? ''}</div>`)}
          </div>
          ${() => revealed()
            ? h`
              <div class="grades">
                <button class="grade-again" onclick=${() => () => grade(0)}>again</button>
                <button class="grade-hard"  onclick=${() => () => grade(1)}>hard</button>
                <button class="grade-good"  onclick=${() => () => grade(2)}>good</button>
                <button class="grade-easy"  onclick=${() => () => grade(3)}>easy</button>
              </div>
            `
            : h`<button class="reveal-btn" onclick=${() => reveal}>reveal</button>`
          }
        `
      }}
    </div>
  `)}
`, document.body, recaller)

// ── event delegation for the deck list ───────────────────────────────
// (`onclick` on dynamically-rendered <li>s is the reactive-cell
// footgun documented in CLAUDE.md; data-action + a single delegated
// listener is the streamo-idiomatic pattern.)
document.body.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]')
  if (!target) return
  if (target.dataset.action === 'study') {
    startStudy(target.dataset.deck)
  }
})
