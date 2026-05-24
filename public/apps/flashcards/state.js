/**
 * @file Runtime singletons for the flashcards app — the module-level
 * state that everything else reads. *Not* "constants" exactly: the
 * bindings are stable but the wrapped LiveSources mutate constantly,
 * and `registry` is late-bound (assigned during login, nulled during
 * logout). What unifies them is that they're shared across every part
 * of the app and want exactly one home.
 *
 *   - `recaller` — the shared Recaller. One per app (the streamo
 *     convention); every LiveSource here passes it in so reads inside
 *     slots self-subscribe.
 *   - `time` — a `liveTime` ticker firing every second. Slots that
 *     read `time.get()` auto-rerender on tick.
 *   - `reviewRepos` — liveObject of opened reviews repos keyed by
 *     deckId. Opened lazily on first study-click.
 *   - `state` — liveObject of UI state (view, activeDeck,
 *     revealedCardIdx, managePinned, etc.).
 *   - `registry` — the RepoRegistry, late-bound. Created in main.js's
 *     login() flow; reassigned via `setRegistry()` because ES module
 *     bindings are read-only to importers. Live binding means
 *     importers see the new value after a login without re-importing.
 *
 * Derived getters live here too — they're trivial reads over `state`
 * and want to be importable from any module that needs them.
 */

import { Recaller }              from '../../streamo/utils/Recaller.js'
import { liveObject, liveTime }  from '../../streamo/LiveSource.js'

export const recaller    = new Recaller('flashcards')
export const time        = liveTime({ recaller, name: 'flashcards-time', tickMs: 1000 })
export const reviewRepos = liveObject({}, { recaller, name: 'reviewRepos' })

export const state = liveObject({
  loggedIn:   false,
  connecting: false,    // true while login → connect → subscribe(deck-index)
  user:       null,     // { username, pubkey } once logged in
  view:       'home',   // 'home' | 'study' | 'edit' | 'manage'
  activeDeck: null,     // deck id while studying / editing / managing
  revealedCardIdx: null, // which card has been flipped (not a session-level bool)
  editingCardIdx:  null, // null = not editing; N = editing card N; -1 = adding new card
  managePinned:    false // click the manage-deck pill to keep it open
                         // independent of hover (mobile: no hover events)
  // No studyQueue, no currentIdx — both derive from the reviews repo
  // each render. The "next card" is buildStudyQueue[0]; grading commits
  // a review event and the queue shifts naturally as a side effect.
}, { recaller, name: 'app' })

// `registry` is late-bound — created in main.js's login() and reset
// to null by logout(). Living here means other modules can import
// it (live binding) without main.js owning the declaration. The
// setter exists because only the source module can reassign an
// exported `let`; main.js uses setRegistry() to swap in a fresh
// RepoRegistry on each login.
export let registry = null
export function setRegistry (r) { registry = r }

// Thin derived getters — read `state` reactively (slots that call
// them auto-subscribe via the recaller). Same shape as the originals
// from main.js, just imported from here instead.
export const loggedIn   = () => state.get('loggedIn')
export const connecting = () => state.get('connecting')
export const user       = () => state.get('user')
export const view       = () => state.get('view')
export const activeDeck = () => state.get('activeDeck')
