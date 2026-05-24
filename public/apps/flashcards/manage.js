/**
 * @file Manage view — the standalone partial-deck-learning UI.
 *
 * **Effective dead code as of the combine-pages refactor** — the
 * manage UI now lives on the study page itself (collapsed pill,
 * hover/click to expand). This view stays only for backward URL
 * compatibility (`#manage/<deckId>`); no in-app navigation routes
 * to it. Will be pruned in a follow-up unless it earns its keep.
 *
 * Kept as its own file because the page-as-shape principle says
 * "one h-template per output page" — even a dead page is a page.
 */

import { h, handle } from '../../streamo/h.js'
import { time, activeDeck } from './state.js'
import { masteryOf, masteryColor, barFor, formatTimeUntil } from './mastery.js'
import {
  deckCards, deckRepo, isCardActive, reviewStateForCard
} from './derived.js'
import { toggleCardActive, exitManage } from './main.js'

export function renderManage () {
  return h`
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
          const hasHistory = !!review.lastReviewAt
          const mastery = masteryOf(review, now)
          const color = hasHistory ? masteryColor(mastery) : '#aaa'
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
            <li class="manage-card ${isActive ? 'manage-card-active' : 'manage-card-available'}"
                data-key=${`manage-${i}`}
                onclick=${handle(() => toggleCardActive(deckId, i))}>
              <svg class="manage-card-icon" viewBox="0 0 100 100" aria-hidden="true">
                ${iconLines}
              </svg>
              <div class="manage-card-content">
                <div class="manage-card-front">${card.front || '(blank)'}</div>
                <div class="manage-card-back">${card.back || ''}</div>
              </div>
              <div class="manage-card-mastery-wrap">
                <div class="manage-card-mastery" title=${hasHistory ? `mastery ${mastery.toFixed(4)} · ${dueLabel}` : 'no history yet'} style=${`color: ${color}`}>
                  <div class="manage-card-mastery-bar" style=${barStyle}></div>
                </div>
                <div class="manage-card-mastery-label" style=${`color: ${color}`}>${hasHistory ? `mastery ${mastery.toFixed(4)} · ${dueLabel}` : 'mastery: n/a'}</div>
              </div>
            </li>
          `
        }

        return h`
          <h3 class="manage-section">active <span class="manage-count">(${activeList.length})</span><span class="manage-section-hint">click to remove</span></h3>
          ${activeList.length === 0
            ? h`<p class="empty">no active cards yet — tap one from <em>available</em> below to start learning it.</p>`
            : h`<ul class="manage-cards">${activeList.map(i => renderCard(i, true))}</ul>`}
          <h3 class="manage-section">available <span class="manage-count">(${availableList.length})</span><span class="manage-section-hint">click to add</span></h3>
          ${availableList.length === 0
            ? h`<p class="empty">all cards in this deck are currently active.</p>`
            : h`<ul class="manage-cards">${availableList.map(i => renderCard(i, false))}</ul>`}
        `
      }}
    </div>
  `
}
