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
 * Two-way sync:
 *
 *   - **state → hash** via a recaller watcher. When state.view or
 *     state.activeDeck change, the watcher writes a fresh hash via
 *     `history.pushState`. Idempotent — only pushes when the hash
 *     actually needs to change.
 *
 *   - **hash → state** via a `popstate` listener. Fires on back/
 *     forward navigation; parses the hash and sets state.view +
 *     state.activeDeck.
 *
 * Both sides check-before-write so the two updates don't echo into
 * an infinite loop. Importing this module installs both bindings as
 * side effects.
 *
 * **Future cleanup:** the existing `liveLocation()` LiveSource in
 * `public/streamo/liveLocation.js` already wraps window.location
 * reactively with hash-parts-level granularity. Rewriting this
 * file to use it would unify the routing on the LiveSource
 * substrate and drop the manual popstate listener. Not done
 * tonight — relocate first, refactor later.
 */

import { recaller, state } from './state.js'

function stateToHashValue () {
  const v = state.get('view')
  const deck = state.get('activeDeck')
  if (v && v !== 'home' && deck) return `#${v}/${deck}`
  return ''
}

function applyHashToState () {
  const raw = location.hash.replace(/^#/, '')
  if (!raw) {
    if (state.get('view') !== 'home') state.set('view', 'home')
    if (state.get('activeDeck') !== null) state.set('activeDeck', null)
    return
  }
  const slash = raw.indexOf('/')
  if (slash < 0) return
  const view = raw.slice(0, slash)
  const deck = raw.slice(slash + 1)
  if (!['study', 'edit', 'manage'].includes(view) || !deck) return
  if (state.get('view') !== view) state.set('view', view)
  if (state.get('activeDeck') !== deck) state.set('activeDeck', deck)
}

recaller.watch('sync-state-to-url-hash', () => {
  if (!state.get('loggedIn')) return  // don't write hash before login
  const want = stateToHashValue()
  const current = location.hash
  if (current === want) return
  if (current === '' && want === '') return
  history.pushState(null, '', want || (location.pathname + location.search))
})

window.addEventListener('popstate', applyHashToState)
