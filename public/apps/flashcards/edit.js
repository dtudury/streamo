/**
 * @file Edit view — the card editor for owners of a forked deck.
 * Inline form-based editing (save/cancel per card) with soft-delete
 * to preserve cardIdx alignment with existing reviews. One of four
 * pages; called from main.js's mount via
 * `when(view() === 'edit', renderEdit())`.
 */

import { h, handle } from '../../streamo/h.js'
import { state, activeDeck } from './state.js'
import {
  deckCards, deckRepo,
  exitEdit, saveCard, cancelEditCard, startEditCard, deleteCard, addCard
} from './main.js'

export function renderEdit () {
  return h`
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
  `
}
