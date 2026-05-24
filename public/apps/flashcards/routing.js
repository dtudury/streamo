/**
 * @file URL hash routing — bidirectional sync between
 * `state.view + state.activeDeck` and `location.hash`. Encoded as:
 *
 *   #study/<deckId>   — studying a deck
 *   #edit/<deckId>    — editing a fork
 *   #manage/<deckId>  — managing active set (legacy route, kept for
 *                       URL compat)
 *   (empty hash)      — home
 *
 * Built on streamo's `liveLocation()` LiveSource — the window.location
 * wrapper that fires the recaller on hashchange and exposes hash-parts
 * granularity. Both directions of the sync become *normal reactive
 * watchers* on the same recaller as the rest of the app; no manual
 * `addEventListener('popstate', ...)` and no manual `history.pushState`
 * needed.
 *
 * Echo prevention: each watcher reads the OTHER side and only writes
 * when its value differs from the current. State→hash compares
 * `loc.get('hash')` against the encoded desired hash; hash→state
 * compares each segment against `state.get(...)`. So writes are
 * idempotent, and the recaller's coalescing makes the loop quiet.
 *
 * Importing this module installs both watchers as side effects.
 */

import { liveLocation } from '../../streamo/liveLocation.js'
import { recaller, state } from './state.js'

const loc = liveLocation({ recaller })

// State → hash. When state.view or state.activeDeck changes, encode
// the desired hash and write via loc.set('hash', ...). Guarded so we
// only write when the URL actually needs updating.
recaller.watch('sync-state-to-url-hash', () => {
  if (!state.get('loggedIn')) return  // don't write hash before login
  const v = state.get('view')
  const deck = state.get('activeDeck')
  const want = (v && v !== 'home' && deck) ? `#${v}/${deck}` : ''
  const current = loc.get('hash')
  if (current === want) return
  if (current === '' && want === '') return
  loc.set('hash', want)
})

// Hash → state. Reads the hash via liveLocation's parts-granularity
// API — segment 1 is the view, segment 2 is the deck id. liveLocation's
// internal hashchange listener fires the recaller on any URL change
// (back/forward, paste, JS-driven), so this is just a normal reactive
// read. Guarded so we only mutate state when the values actually
// changed (prevents echo with the other watcher).
recaller.watch('sync-url-hash-to-state', () => {
  const view = loc.get('hashParts', 1) || ''
  const deck = loc.get('hashParts', 2) || ''
  if (!view) {
    if (state.get('view') !== 'home') state.set('view', 'home')
    if (state.get('activeDeck') !== null) state.set('activeDeck', null)
    return
  }
  if (!['study', 'edit', 'manage'].includes(view) || !deck) return
  if (state.get('view') !== view) state.set('view', view)
  if (state.get('activeDeck') !== deck) state.set('activeDeck', deck)
})
