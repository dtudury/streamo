/**
 * @file Derived data — pure read functions over the app's repo state.
 *
 * "How the app reads its state," kept separate from "how it mutates
 * its state." These functions take a deckId (or other inputs) and
 * return a value — no side effects, no DOM, no event handling. All
 * reads are recaller-tracked because they go through registry /
 * reviewRepos / homeRepo (all LiveSources), so slots that call any
 * of these from within a render auto-subscribe to the right keys.
 *
 *   - **addrFor(deckId)** — bundled-deck id → address; forks have no
 *     separate id so the deckId IS the address
 *   - **deckRepo(deckId)** — the deck Repo for this id (via registry)
 *   - **deckCards(deckId)** — the cards array (`[] if loading)
 *   - **reviewStateForCard(deckId, cardIdx)** — SM-2 state for one
 *     card, derived by folding all review events
 *   - **activeCardIds(deckId)** — the learner's active-set Set (empty
 *     if undefined; new decks start with no active cards)
 *   - **isCardActive(deckId, cardIdx)** — convenience boolean
 *   - **deckStats(deckId)** — `{ due, new, active }` counts
 *   - **buildStudyQueue(deckId)** — ordered cardIdx list for study
 *   - **deckMastery(deckId, now)** — average mastery over the active
 *     ever-reviewed cards, 0 if nothing reviewed
 */

import { DEFAULT_REVIEW, applySM2, retentionMultiplier, DEFAULT_RETENTION_TARGET } from './sm2.js'
import { masteryOf }                from './mastery.js'
import { registry, reviewRepos, state } from './state.js'
import { homeRepo }                 from './main.js'

// Translate a deckId into the address of its deck Repo. Bundled decks
// have a human-readable id ('greek-alphabet') and live at the address
// listed in homeRepo.flashcardsDecks. Forks have no separate id —
// their address IS their id. All reads here are recaller-tracked, so
// callers in slots auto-subscribe to updates in either source.
export function addrFor (deckId) {
  if (!deckId) return null
  const fd = homeRepo?.get('flashcardsDecks') ?? {}
  return fd[deckId] ?? deckId
}

export function deckRepo (deckId) {
  const addr = addrFor(deckId)
  return addr ? registry?.get(addr) : undefined
}

export function deckCards (deckId) {
  return deckRepo(deckId)?.get('cards') ?? []
}

// SM-2 state derived by folding every review event for this card.
// After the fold, the deck's retention-target multiplier is applied
// to the `due` time — so the deck visibly re-sorts as the user
// slides the target. Past grades stored at their original intervals;
// only the PROJECTED due is reinterpreted live.
export function reviewStateForCard (deckId, cardIdx) {
  const repo = reviewRepos.get(deckId)
  if (!repo) return { ...DEFAULT_REVIEW }
  const reviews = repo.get('reviews') ?? []
  let r = { ...DEFAULT_REVIEW }
  for (const ev of reviews) {
    if (ev.cardIdx === cardIdx) r = applySM2(r, ev.grade, ev.at)
  }
  if (r.lastReviewAt) {
    const target = repo.get('retentionTarget') ?? DEFAULT_RETENTION_TARGET
    const mult = retentionMultiplier(target)
    const rawIntervalMs = r.due - r.lastReviewAt
    r.due = r.lastReviewAt + rawIntervalMs * mult
  }
  return r
}

// The deck's current retention target — readable from anywhere (slot,
// handler, render). Defaults to DEFAULT_RETENTION_TARGET when the
// learner hasn't set one for this deck.
export function retentionTargetFor (deckId) {
  const repo = reviewRepos.get(deckId)
  if (!repo) return DEFAULT_RETENTION_TARGET
  return repo.get('retentionTarget') ?? DEFAULT_RETENTION_TARGET
}

// ── active set (partial-deck learning) ──────────────────────────────
//
// Per-(learner, deck) state stored in the reviews repo: which cards
// the learner is *currently* studying. Cards not in the active set
// are *available* (in the deck) but don't appear in the study queue.
//
// **Default: empty.** A fresh deck has no active cards; the learner
// opts cards in via the manage UI on the study page.

export function activeCardIds (deckId) {
  const repo = reviewRepos.get(deckId)
  if (!repo) return new Set()
  const active = repo.get('active')
  if (!Array.isArray(active)) return new Set()
  return new Set(active)
}

export function isCardActive (deckId, cardIdx) {
  return activeCardIds(deckId).has(cardIdx)
}

export function deckStats (deckId) {
  const cards = deckCards(deckId)
  const active = activeCardIds(deckId)
  if (!cards.length) return { due: 0, new: 0, active: 0 }
  let due = 0, neu = 0, activeCount = 0
  const now = Date.now()
  for (let i = 0; i < cards.length; i++) {
    if (cards[i]?.deleted) continue
    if (!active.has(i)) continue
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
//
// **Study-ahead mode** — when the normal queue is empty AND the learner
// has opted in via `state.studyAhead`, surface ALL active non-deleted
// cards sorted by next-due (earliest first), regardless of whether
// they're due yet. Lets the user keep grading past the algorithm's
// "all caught up" threshold; the math doesn't care about timing
// (`applySM2` integrates a review event with `atMs = now` no matter
// what the current due-time was), so this is safe.
export function buildStudyQueue (deckId) {
  const cards = deckCards(deckId)
  const active = activeCardIds(deckId)
  const due = [], neu = []
  const now = Date.now()
  for (let i = 0; i < cards.length; i++) {
    if (cards[i]?.deleted) continue   // soft-deleted cards don't appear in study
    if (!active.has(i)) continue  // not in active set
    const r = reviewStateForCard(deckId, i)
    const everReviewed = r.due > 0  // DEFAULT_REVIEW has due=0; any grade sets a timestamp
    if (!everReviewed) neu.push(i)
    else if (r.due <= now) due.push(i)
    // else: in 'rest' — has reviews, not yet due. Not in the queue.
  }
  const normal = [...due, ...neu]
  if (normal.length > 0 || !state.get('studyAhead')) return normal
  // Study-ahead fallback: every active card, sorted by next-due.
  const ahead = []
  for (let i = 0; i < cards.length; i++) {
    if (cards[i]?.deleted) continue
    if (!active.has(i)) continue
    ahead.push(i)
  }
  ahead.sort((a, b) => {
    const ra = reviewStateForCard(deckId, a)
    const rb = reviewStateForCard(deckId, b)
    return (ra.due || 0) - (rb.due || 0)
  })
  return ahead
}

// Mastery for the deck's *active set* — average over non-deleted,
// active, ever-reviewed cards. Represents "how well I know what I'm
// currently studying," not "the whole deck's potential." Returns 0
// if nothing's been reviewed yet.
export function deckMastery (deckId, now) {
  const cards = deckCards(deckId)
  if (cards.length === 0) return 0
  const active = activeCardIds(deckId)
  let total = 0, n = 0
  for (let i = 0; i < cards.length; i++) {
    if (cards[i]?.deleted) continue
    if (!active.has(i)) continue
    const r = reviewStateForCard(deckId, i)
    if (r.lastReviewAt) { total += masteryOf(r, now); n++ }
  }
  return n === 0 ? 0 : total / n
}
