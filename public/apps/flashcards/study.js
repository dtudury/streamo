/**
 * @file Study view — the active studying flow: card flip, mastery
 * strip, grade buttons, manage panel (collapsed-pill-on-hover, or
 * pinned-open on touch). One of four pages; called from main.js's
 * mount via `when(view() === 'study', renderStudy())`.
 */

import { h, handle } from '../../streamo/h.js'
import { state, time, activeDeck } from './state.js'
import { masteryOf, masteryColor, barFor, formatTimeUntil } from './mastery.js'
import {
  deckCards, deckRepo, buildStudyQueue, reviewStateForCard, activeCardIds,
  retentionTargetFor, hasPendingRetentionChange
} from './derived.js'
import {
  currentCard, currentCardIdx, revealed,
  toggleReveal, grade, backToHome, toggleCardActive, peekCard,
  previewRetentionTarget, saveRetentionTarget
} from './main.js'

export function renderStudy () {
  return h`
    <div class="study">
      <div class="study-header">
        <button class="study-back" onclick=${handle(backToHome)}>← back</button>
        <span>${() => {
          const deckId = activeDeck()
          const title  = deckRepo(deckId)?.get('title') ?? ''
          if (!title) return ''
          // In study-ahead mode, the "N left" count is misleading
          // (the user isn't *required* to study any more), so swap
          // it for a clickable way out of the mode. Going back to
          // the all-caught-up empty state — from there, the back
          // arrow still works, and clicking the empty state can
          // re-enter study-ahead.
          if (state.get('studyAhead')) {
            return h`${title} · <button class="study-ahead-stop" onclick=${handle(() => state.set('studyAhead', false))}>stop studying ahead</button>`
          }
          const remaining = buildStudyQueue(deckId).length
          return `${title} · ${remaining} left`
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
              <div class="study-empty study-empty-clickable"
                   onclick=${handle(() => state.set('studyAhead', true))}
                   title="click to keep studying">
                <h3>all caught up 🌳</h3>
                <p>nothing due right now — <em>click to keep studying</em> (we'll show the next-soonest card), or come back later.</p>
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
              const now = time.get()
              const review = reviewStateForCard(deckId, idx)
              const hasHistory = !!review.lastReviewAt
              const m = masteryOf(review, now)
              const color = hasHistory ? masteryColor(m) : '#aaa'
              const bar = barFor(review, now)
              const dueLabel = hasHistory ? formatTimeUntil(review.due - now) : null
              // Overdue bars right-anchor; pre-due bars left-anchor.
              // Remaining bar anchors RIGHT (drains by shrinking
              // toward the right edge as time runs out). Overdue
              // bar anchors LEFT (grows rightward from the left
              // edge). Visually distinct AND matches David's
              // intuition about which side "represents" each state.
              const barStyle = bar.kind === 'remaining'
                ? `right:0; left:auto; width:${bar.width.toFixed(0)}%`
                : `width:${bar.width.toFixed(0)}%`
              return h`
                <div class="study-mastery" title=${hasHistory ? `mastery ${m.toFixed(4)} · ${dueLabel}` : 'no history yet'} style=${`color: ${color}`}>
                  <div class="study-mastery-bar" style=${barStyle}></div>
                </div>
                <div class="study-mastery-label" style=${`color: ${color}`}>${hasHistory ? `mastery ${m.toFixed(4)} · ${dueLabel}` : 'mastery: n/a'}</div>
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
        // Sort by time-remaining ascending: most overdue at top, then
        // due-now (including never-reviewed cards, treated as
        // due-this-moment), then due-soon, then due-far. Previously
        // we sorted by `due || 0`, which put new cards at the
        // epoch (way before anything else) — confusing.
        allIndices.sort((a, b) => {
          const ra = reviewStateForCard(deckId, a)
          const rb = reviewStateForCard(deckId, b)
          const dueA = ra.lastReviewAt ? ra.due : now
          const dueB = rb.lastReviewAt ? rb.due : now
          return dueA - dueB
        })
        const activeList = allIndices.filter(i => activeSet.has(i))
        const availableList = allIndices.filter(i => !activeSet.has(i))

        const renderCompactCard = (i, isActive) => {
          const c = cards[i]
          const review = reviewStateForCard(deckId, i)
          const hasHistory = !!review.lastReviewAt
          const m = masteryOf(review, now)
          const color = hasHistory ? masteryColor(m) : '#aaa'
          const bar = barFor(review, now)
          const dueLabel = hasHistory ? formatTimeUntil(review.due - now) : null
          const barStyle = bar.kind === 'remaining'
            ? `right:0; left:auto; width:${bar.width.toFixed(0)}%`
            : `width:${bar.width.toFixed(0)}%`
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
                  <button class="manage-card-peek"
                          title="look at this one in the studied slot"
                          onclick=${handle((e) => { e.stopPropagation(); peekCard(i) })}>
                    <svg viewBox="0 0 24 16" aria-hidden="true">
                      <ellipse cx="12" cy="8" rx="10" ry="6" stroke="currentColor" stroke-width="1.5" fill="none"/>
                      <circle cx="12" cy="8" r="3" fill="currentColor"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="manage-card-mastery-wrap">
                <div class="manage-card-mastery" title=${hasHistory ? `mastery ${m.toFixed(4)} · ${dueLabel}` : 'no history yet'} style=${`color: ${color}`}>
                  <div class="manage-card-mastery-bar" style=${barStyle}></div>
                </div>
                <div class="manage-card-mastery-label" style=${`color: ${color}`}>${hasHistory ? `mastery ${m.toFixed(4)} · ${dueLabel}` : 'mastery: n/a'}</div>
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
                ${() => {
                  // Retention slider. Dragging updates `pending`
                  // (live preview — deck re-sorts as you drag), but
                  // doesn't write to the repo. The "save" button
                  // appears when pending differs from saved; click
                  // it to commit. Navigate away → pending clears,
                  // saved value sticks.
                  const target = retentionTargetFor(deckId)
                  const hasUnsaved = hasPendingRetentionChange(deckId)
                  return h`
                    <div class="retention-control">
                      <div class="retention-label-row">
                        <label>aim for <strong>${(target * 100).toFixed(0)}%</strong> retention <span class="retention-hint">${target > 0.92 ? '— ace it' : target < 0.75 ? '— skate by' : '— balanced'}</span></label>
                        ${hasUnsaved ? h`<button class="retention-save" onclick=${handle(saveRetentionTarget)}>save</button>` : null}
                      </div>
                      <input type="range" min="0.5" max="0.99" step="0.01" value=${target}
                             oninput=${handle(previewRetentionTarget)}>
                    </div>
                  `
                }}
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
