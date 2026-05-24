/**
 * @file Study view — the active studying flow: card flip, mastery
 * strip, grade buttons, manage panel (collapsed-pill-on-hover, or
 * pinned-open on touch). One of four pages; called from main.js's
 * mount via `when(view() === 'study', renderStudy())`.
 */

import { h, handle } from '../../streamo/h.js'
import { state, time, activeDeck } from './state.js'
import { masteryOf, masteryColor } from './mastery.js'
import {
  deckCards, deckRepo, currentCard, currentCardIdx, revealed,
  buildStudyQueue, reviewStateForCard, activeCardIds,
  toggleReveal, grade, backToHome, toggleCardActive
} from './main.js'

export function renderStudy () {
  return h`
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
        const now = time.get()  // alive: per-card mastery climbs each tick
        const card = currentCard()
        const activeSet = activeCardIds(deckId)

        // Studied-card spot: either the flip card OR an empty-state.
        // Both share the same outer height so the layout doesn't jump
        // when transitioning between (card → no-card → card).
        const studyArea = card
          ? h`
            <div class="card ${() => revealed() ? 'revealed' : ''}"
                 data-key=${`card-${currentCardIdx()}`}
                 onclick=${handle(toggleReveal)}>
              <div class="card-inner">
                <div class="card-face card-face-front">
                  <div class="card-front-text">${card.front}</div>
                  <div class="card-flip-hint">
                    <svg class="card-flip-icon" viewBox="0 0 24 16" aria-hidden="true">
                      <ellipse cx="12" cy="8" rx="10" ry="6" stroke="currentColor" stroke-width="1.5" fill="none"/>
                      <circle cx="12" cy="8" r="3" fill="currentColor"/>
                    </svg>
                    <span>tap to reveal</span>
                  </div>
                </div>
                <div class="card-face card-face-back">
                  <div class="card-back-text">${() => currentCard()?.back ?? ''}</div>
                </div>
              </div>
            </div>
          `
          : activeSet.size === 0
            ? h`
              <div class="study-empty">
                <h3>no cards yet</h3>
                <p>tap <em>manage deck</em> below and click a card to add it to your study set.</p>
              </div>
            `
            : h`
              <div class="study-empty">
                <h3>all caught up 🌳</h3>
                <p>nothing due right now — come back later, or manage your deck below to add more cards.</p>
              </div>
            `

        // Mastery strip — always rendered so its presence doesn't shift
        // the layout between card / no-card states. When there's no
        // current card, the bar is empty and the label reads
        // "mastery: n/a" in the same gray as a no-history card.
        const masteryStrip = h`
          <div class="study-mastery-wrap">
            ${() => {
              if (!card) {
                return h`
                  <div class="study-mastery" title="no cards" style="color: #aaa">
                    <div class="study-mastery-bar" style="width:0%"></div>
                  </div>
                  <div class="study-mastery-label" style="color: #aaa">mastery: n/a</div>
                `
              }
              const idx = currentCardIdx()
              if (idx == null) return null
              const review = reviewStateForCard(deckId, idx)
              const hasHistory = !!review.lastReviewAt
              const m = masteryOf(review, time.get())
              const pct = Math.min(100, (m / 7) * 100)
              const color = hasHistory ? masteryColor(m) : '#aaa'
              return h`
                <div class="study-mastery" title=${hasHistory ? `mastery: ${m.toFixed(4)} / 7` : 'no history yet'} style=${`color: ${color}`}>
                  <div class="study-mastery-bar" style=${`width:${hasHistory ? pct.toFixed(0) : 0}%`}></div>
                </div>
                <div class="study-mastery-label" style=${`color: ${color}`}>${hasHistory ? `mastery ${m.toFixed(4)}` : 'mastery: n/a'}</div>
              `
            }}
          </div>
        `

        // Manage panel: collapsed pill by default; the whole deck's
        // cards revealed on hover. Sorted by due-time ascending (next
        // due at top; never-reviewed = due 0 = bubbles to the top of
        // its section). All cards rendered compact (mastery bar only)
        // by default; hover over a card to reveal its front/back.
        const allIndices = []
        for (let i = 0; i < cards.length; i++) {
          if (!cards[i]?.deleted) allIndices.push(i)
        }
        allIndices.sort((a, b) => {
          const ra = reviewStateForCard(deckId, a)
          const rb = reviewStateForCard(deckId, b)
          return (ra.due || 0) - (rb.due || 0)
        })
        const activeList = allIndices.filter(i => activeSet.has(i))
        const availableList = allIndices.filter(i => !activeSet.has(i))

        const renderCompactCard = (i, isActive) => {
          const c = cards[i]
          const review = reviewStateForCard(deckId, i)
          const hasHistory = !!review.lastReviewAt
          const m = masteryOf(review, now)
          const pct = Math.min(100, (m / 7) * 100)
          const color = hasHistory ? masteryColor(m) : '#aaa'
          // Both icons live on a 3×3 grid in a 100×100 viewBox; each
          // bar is 100 long × 33.33 wide (3 cells × 1 cell). The plus
          // is two axis-aligned rects; the X is the same two bars
          // rotated ±45° around the center — identical bar dimensions
          // in both icons, only the angle changes.
          const iconLines = isActive
            ? h`<rect x="0" y="33.33" width="100" height="33.33" transform="rotate(45 50 50)"/>
                <rect x="0" y="33.33" width="100" height="33.33" transform="rotate(-45 50 50)"/>`
            : h`<rect x="0" y="33.33" width="100" height="33.33"/>
                <rect x="33.33" y="0" width="33.33" height="100"/>`
          return h`
            <li class="manage-card manage-card-compact ${isActive ? 'manage-card-active' : 'manage-card-available'}"
                data-key=${`manage-${i}`}
                onclick=${handle(() => toggleCardActive(deckId, i))}>
              <svg class="manage-card-icon" viewBox="0 0 100 100" aria-hidden="true">
                ${iconLines}
              </svg>
              <div class="manage-card-content-wrap">
                <div class="manage-card-content">
                  <div class="manage-card-front">${c.front || '(blank)'}</div>
                  <div class="manage-card-back">${c.back || ''}</div>
                </div>
              </div>
              <div class="manage-card-mastery-wrap">
                <div class="manage-card-mastery" title=${hasHistory ? `mastery: ${m.toFixed(4)} / 7` : 'no history yet'} style=${`color: ${color}`}>
                  <div class="manage-card-mastery-bar" style=${`width:${hasHistory ? pct.toFixed(0) : 0}%`}></div>
                </div>
                <div class="manage-card-mastery-label" style=${`color: ${color}`}>${hasHistory ? `mastery ${m.toFixed(4)}` : 'mastery: n/a'}</div>
              </div>
            </li>
          `
        }

        const managePanel = h`
          <div class="manage-deck ${() => state.get('managePinned') ? 'manage-deck-pinned' : ''}">
            <div class="manage-deck-pill"
                 onclick=${handle(() => state.set('managePinned', !state.get('managePinned')))}>
              manage deck${() => state.get('managePinned') ? ' ▾' : ''}
            </div>
            <div class="manage-deck-expanded">
              <div class="manage-deck-inner">
                <h3 class="manage-section">active <span class="manage-count">(${activeList.length})</span><span class="manage-section-hint">click to remove</span></h3>
                ${activeList.length === 0
                  ? h`<p class="empty">no active cards yet.</p>`
                  : h`<ul class="manage-cards">${activeList.map(i => renderCompactCard(i, true))}</ul>`}
                <h3 class="manage-section">available <span class="manage-count">(${availableList.length})</span><span class="manage-section-hint">click to add</span></h3>
                ${availableList.length === 0
                  ? h`<p class="empty">every card in this deck is active.</p>`
                  : h`<ul class="manage-cards">${availableList.map(i => renderCompactCard(i, false))}</ul>`}
              </div>
            </div>
          </div>
        `

        // Grade buttons live inside a fixed-height slot that's ALWAYS
        // present (just empty when not revealed). The manage panel
        // sits below; the slot's reserved height keeps the panel from
        // moving when grade buttons appear/disappear.
        const actionsSlot = h`
          <div class="study-actions-slot">
            ${() => (card && revealed())
              ? h`
                <div class="grades">
                  <button class="grade-again" onclick=${handle(() => grade(0))}>again</button>
                  <button class="grade-hard"  onclick=${handle(() => grade(1))}>hard</button>
                  <button class="grade-good"  onclick=${handle(() => grade(2))}>good</button>
                  <button class="grade-easy"  onclick=${handle(() => grade(3))}>easy</button>
                </div>
              `
              : null
            }
          </div>
        `

        return h`
          ${studyArea}
          ${masteryStrip}
          ${actionsSlot}
          ${managePanel}
        `
      }}
    </div>
  `
}
