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
let session = null
// The learner's deck-index Repo — `{ decks: [<pubkey-hex>, ...] }`,
// signed by them. Lists the decks the learner has authored or forked.
// Populated at login; appended to on fork.
let myDeckIndex = null

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
//
// session.subscribe — not registry.open — is what plumbs the repo to
// the wire. `registry.open` alone makes a local Repo but doesn't tell
// the relay to send bytes; the chat app's main.js spells this out.
async function openReviewsRepo (deckId) {
  const streamName = `flashcards:reviews:${deckId}`
  const { publicKey } = await signer.keysFor(streamName)
  const repoKey = bytesToHex(publicKey)
  const repo = await session.subscribe(repoKey)
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

  // Connect to the relay. The `follow` callback cascades subscription
  // through (a) the home repo's `flashcardsDecks` map for bundled decks
  // and (b) any repo's `decks` array (the deck-index shape) for forks
  // the learner has authored. The home repo doesn't have `decks` and
  // the deck-index doesn't have `flashcardsDecks`, so each clause
  // applies cleanly to its source.
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

  // Bundled decks: discovered via home repo (auto-subscribed via hello).
  const info = await fetch('/api/info').then(r => r.json())
  const homeRepo = await registry.open(info.primaryKeyHex)
  const fd = await awaitField(homeRepo, 'flashcardsDecks', 8000)
  const bundledIds = Object.keys(fd)

  // Open the learner's deck-index Repo — same key-derivation pattern
  // as reviews. Fresh users have no bytes here; we treat the brief
  // timeout as "no forks yet."
  const idxStream = 'flashcards:deck-index'
  const { publicKey: idxPub } = await signer.keysFor(idxStream)
  const idxKey = bytesToHex(idxPub)
  myDeckIndex = await session.subscribe(idxKey)
  myDeckIndex.attachSigner(signer, idxStream)
  myDeckIndex._flashcardsKey = idxKey
  let forkAddrs = []
  try { forkAddrs = await awaitField(myDeckIndex, 'decks', 3000) }
  catch { forkAddrs = [] }

  // Open bundled deck repos.
  await Promise.all(bundledIds.map(async (id) => {
    const repo = await registry.open(fd[id])
    repo._flashcardsKey = fd[id]
    deckRepos.set(id, repo)
    await awaitField(repo, 'title', 8000)
  }))
  // Open forked deck repos. The cascade has already subscribed them;
  // we just wait for content and stash. The fork's deckId is its
  // pubkey-hex (no human-readable string id — the address IS the id).
  await Promise.all(forkAddrs.map(async (addr) => {
    const repo = await registry.open(addr)
    repo._flashcardsKey = addr
    deckRepos.set(addr, repo)
    await awaitField(repo, 'title', 8000)
  }))

  // Reviews repos: one per (learner, deck) for bundled + forks alike.
  const allIds = [...bundledIds, ...forkAddrs]
  await Promise.all(allIds.map(id => openReviewsRepo(id)))

  state.set('deckIds', allIds)
  state.set('connecting', false)
  state.set('loggedIn', true)
}

function logout () {
  signer = null
  registry = null
  session = null
  myDeckIndex = null
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
  const upstreamRepo = deckRepos.get(upstreamId)
  const upstream = upstreamRepo?.get()
  if (!upstream) return

  const forkStream = `flashcards:my-deck:${upstreamId}:${Date.now()}`
  const { publicKey } = await signer.keysFor(forkStream)
  const newDeckKey = bytesToHex(publicKey)

  const forkRepo = await session.subscribe(newDeckKey)
  forkRepo.attachSigner(signer, forkStream)
  forkRepo._flashcardsKey = newDeckKey
  forkRepo.defaultMessage = `fork of ${upstream.title}`
  forkRepo.set({
    title: `${upstream.title} (my fork)`,
    description: `forked from ${upstreamRepo._flashcardsKey.slice(0, 10)}…`,
    cards: [...upstream.cards],
    forkedFrom: upstreamRepo._flashcardsKey
  })

  // Append to the learner's deck-index. First fork from a fresh user
  // initializes the `decks` array; subsequent forks append.
  const currentForks = myDeckIndex.get('decks') ?? []
  myDeckIndex.defaultMessage = `added fork: ${upstream.title}`
  myDeckIndex.set({ decks: [...currentForks, newDeckKey] })

  // Local state — deck repo, its reviews repo, and the home view's id list.
  deckRepos.set(newDeckKey, forkRepo)
  await openReviewsRepo(newDeckKey)
  state.set('deckIds', [...state.get('deckIds'), newDeckKey])
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
                ${isFork
                  ? null
                  : h`<button class="fork-btn" onclick=${handle((e) => { e.stopPropagation(); forkDeck(id) })}>fork</button>`}
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

