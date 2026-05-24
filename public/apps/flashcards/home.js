/**
 * @file Home view — the deck list. One of the four pages this app
 * renders; each page is its own h-template, called from main.js's
 * mount via a `when()` guard on `view() === 'home'`.
 *
 * The dear-future-claudes rule said "inline the markup so the page
 * reads top-to-bottom." 1300 lines later, we found the rule's spirit
 * is about the h-template mapping the OUTPUT'S shape, not the file
 * count. This app outputs four distinct pages, so four h-templates
 * (one per page) IS the mapping; each page reads top-to-bottom on
 * its own.
 */

import { h, handle } from '../../streamo/h.js'
import { time, registry } from './state.js'
import { masteryColor, formatTimeUntil } from './mastery.js'
import {
  homeRepo, myDeckIndex,
  deckStats, deckCards, deckMastery, reviewStateForCard, activeCardIds,
  startStudy, enterEdit, deleteFork, forkDeck
} from './main.js'

export function renderHome () {
  return h`
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
                ${isFork
                  ? h`
                    <button class="deck-action-btn deck-action-edit" onclick=${handle((e) => { e.stopPropagation(); enterEdit(id) })}>edit</button>
                    <button class="deck-action-btn deck-action-delete" onclick=${handle((e) => { e.stopPropagation(); deleteFork(id) })}>delete</button>
                  `
                  : h`<button class="deck-action-btn deck-action-fork" onclick=${handle((e) => { e.stopPropagation(); forkDeck(id) })}>fork</button>`}
              </div>
              ${() => {
                // Live mastery summary — climbs with elapsed time since
                // last review. Reads time.get() so the slot re-renders
                // every second; reads reviews repo so it also updates on
                // grades. Bar width and label color both map to the same
                // mastery value; no gradient stretching, no decorative
                // baked-in colors that don't mean anything.
                //
                // For decks with NO reviewed cards yet, render the bar
                // grayed-out with 'mastery: n/a' so the affordance is
                // still present and clearly says 'no data yet' rather
                // than disappearing entirely.
                const now = time.get()
                const m = deckMastery(id, now)
                const hasHistory = m > 0
                const pct = Math.min(100, (m / 7) * 100)
                const color = hasHistory ? masteryColor(m) : '#aaa'
                return h`
                  <div class="deck-mastery" title=${hasHistory ? `average mastery: ${m.toFixed(4)} / 7` : 'no history yet'} style=${`color: ${color}`}>
                    <div class="deck-mastery-bar" style=${`width:${hasHistory ? pct.toFixed(0) : 0}%`}></div>
                  </div>
                  <div class="deck-mastery-label" style=${`color: ${color}`}>${hasHistory ? `mastery ${m.toFixed(4)}` : 'mastery: n/a'}</div>
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
                  if (!active.has(i)) continue  // active set only
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
  `
}
