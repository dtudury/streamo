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

// Deck Repos and Reviews Repos, both keyed by deck id. Deck Repos are
// authored by the relay's home identity; Reviews Repos are authored by
// the logged-in learner. The deck-id keys in both maps are the only
// thing tying them together at the data layer.
const deckRepos   = liveObject({}, { recaller, name: 'deckRepos' })
const reviewRepos = liveObject({}, { recaller, name: 'reviewRepos' })

const state = liveObject({
  loggedIn:   false,
  connecting: false,    // true while login → discovery → repos
  user:       null,     // { username, pubkey } once logged in
  view:       'home',   // 'home' | 'study'
  activeDeck: null,     // deck id while studying
  currentIdx: 0,        // pointer into studyQueue
  revealed:   false,    // is the back of the current card shown?
  studyQueue: [],       // array of card indices for this session
  deckIds:    []        // ids of discovered & opened decks (drives the home list)
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
  r.due = atMs + r.interval * 24 * 60 * 60 * 1000
  return r
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

function deckCards (deckId) {
  return deckRepos.get(deckId)?.get('cards') ?? []
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

function buildStudyQueue (deckId) {
  const cards = deckCards(deckId)
  const due = [], neu = [], rest = []
  const now = Date.now()
  for (let i = 0; i < cards.length; i++) {
    const r = reviewStateForCard(deckId, i)
    if (r.reps === 0) neu.push(i)
    else if (r.due <= now) due.push(i)
    else rest.push(i)
  }
  return [...due, ...neu, ...rest]
}

// ── one-shot reactive await: resolves when a repo field becomes defined.
//
// We use this to wait for bytes to arrive after `registry.open(...)` —
// the open returns immediately, but subscribed bytes flow in over WS
// and the field of interest may not be populated for a few hundred ms.

function awaitField (repo, field, timeoutMs = 5000) {
  const existing = repo.get(field)
  if (existing !== undefined) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    let done = false
    const fn = () => {
      const v = repo.get(field)
      if (v !== undefined && !done) {
        done = true
        repo.recaller.unwatch(fn)
        clearTimeout(timer)
        resolve(v)
      }
    }
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        repo.recaller.unwatch(fn)
        reject(new Error(`timeout waiting for ${field}`))
      }
    }, timeoutMs)
    repo.recaller.watch(`await-${field}`, fn)
  })
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

  signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('flashcards')
  state.set('user', { username, pubkey: bytesToHex(publicKey) })

  // Connect to the relay.
  registry = new RepoRegistry(undefined, { recaller, name: 'flashcards' })
  await registrySync(registry, location.hostname, +location.port || (location.protocol === 'https:' ? 443 : 80))

  // Discover what decks the relay serves. /api/info gives us the home
  // repo's pubkey; the home repo's `flashcardsDecks` field is the
  // address map. No hardcoded deck addresses anywhere on the client.
  const info = await fetch('/api/info').then(r => r.json())
  const homeRepo = await registry.open(info.primaryKeyHex)
  const fd = await awaitField(homeRepo, 'flashcardsDecks', 8000)
  const ids = Object.keys(fd)

  // Open each deck Repo in parallel; wait for each to have content.
  // Then open the matching reviews Repo for this learner.
  await Promise.all(ids.map(async (id) => {
    const repo = await registry.open(fd[id])
    deckRepos.set(id, repo)
    await awaitField(repo, 'title', 8000)
  }))
  await Promise.all(ids.map(id => openReviewsRepo(id)))

  state.set('deckIds', ids)
  state.set('connecting', false)
  state.set('loggedIn', true)
}

function logout () {
  signer = null
  registry = null
  deckRepos.set({})
  reviewRepos.set({})
  state.set('user', null)
  state.set('deckIds', [])
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
  const reviews = repo.get('reviews') ?? []
  repo.defaultMessage = `review: card ${cardIdx} graded ${['again', 'hard', 'good', 'easy'][gradeIdx]}`
  repo.set({
    deck: deckId,
    reviews: [...reviews, { cardIdx, grade: gradeIdx, at: Date.now() }]
  })
  if (gradeIdx === 0) {
    state.set('studyQueue', [...queue, cardIdx])
  }
  state.set('currentIdx', idx + 1)
  state.set('revealed', false)
}

// ── view helpers ─────────────────────────────────────────────────────

function currentCard () {
  const deckId = activeDeck()
  const cards  = deckCards(deckId)
  const queue  = state.get('studyQueue')
  const idx    = currentIdx()
  if (idx >= queue.length) return null  // session complete
  return cards[queue[idx]]
}

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
        const ids = state.get('deckIds')
        if (!ids.length) return h`<li class="empty">no decks served by this relay yet.</li>`
        return ids.map(id => {
          const repo = deckRepos.get(id)
          const title = repo?.get('title') ?? '(loading)'
          const description = repo?.get('description') ?? ''
          const s = deckStats(id)
          return h`
            <li class="deck" data-key=${id} onclick=${handle(() => startStudy(id))}>
              <div class="deck-title">${title}</div>
              <div class="deck-desc">${description}</div>
              <div class="deck-stats">
                <span class="due">${s.due} due</span>
                <span class="new">${s.new} new</span>
                <span>${s.total} total</span>
              </div>
            </li>
          `
        })
      }}
    </ul>
    ${() => {
      const ids = state.get('deckIds')
      if (!ids.length) return null
      const repo = reviewRepos.get(ids[0])
      if (!repo) return null
      return h`<a class="explorer-link" href=${`../explorer/#/repo/${repo._flashcardsKey}`}>see your reviews in the explorer →</a>`
    }}
  `)}

  ${when(() => loggedIn() && view() === 'study', h`
    <div class="study">
      <div class="study-header">
        <button class="study-back" onclick=${handle(backToHome)}>← back</button>
        <span>${() => {
          const deckId = activeDeck()
          const title  = deckRepos.get(deckId)?.get('title') ?? ''
          const queue  = state.get('studyQueue')
          const idx    = currentIdx()
          const remaining = Math.max(0, queue.length - idx)
          return title ? `${title} · ${remaining} left` : ''
        }}</span>
      </div>
      ${() => {
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
          <div class="card" data-key=${`card-${currentIdx()}`}>
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
