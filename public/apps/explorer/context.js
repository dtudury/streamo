// streamo explorer — the app's context. Singletons every other
// module imports from. Constructing them at module-init time means
// each consumer can `import { state, registry, ... }` without main.js
// having to thread them through factory calls.
//
//   recaller     the one Recaller every reactive thing shares
//   registry     RepoRegistry — exposes its own dep/fire via shared recaller
//   state        cross-view UI state (currently just connection-pill)
//   homeKey      the relay's home repo key (set by main.js from `hello`)
//   hovered      live-preview hover address — a single-value LiveSource
//   loc          liveLocation over window.location
//
// Routing accessors:
//   getKeyHex()  the repo identity in the URL (null when on the registry list)
//   getAddress() the byte-address pin within an at-view ('HEAD' when not pinned)
//   go({ keyHex, address })   navigate by writing the hash

import { Recaller } from '../../streamo/utils/Recaller.js'
import { liveObject, liveValue } from '../../streamo/LiveSource.js'
import { liveLocation } from '../../streamo/liveLocation.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'

export const recaller = new Recaller('explorer')
export const registry = new RepoRegistry(undefined, { recaller, name: 'explorer' })

// Cross-view UI state. Currently just the connection pill —
// registrySync writes it, the conn pill in main.js's mount template
// reads it. Anything view-specific belongs in that view's own
// liveObject (e.g. at-view's atTab) rather than here.
export const state = liveObject({
  connection: { status: '', text: 'connecting…' }
}, { recaller, name: 'app' })

// The relay's home repo key, delivered by the `hello` handshake message.
// main.js writes it via the registrySync onHello callback; the registry
// view reads it to render the home card and walk `home.value.members`
// for the cascade. Null until the handshake completes.
export const homeKey = liveValue(null, { recaller, name: 'homeKey' })

// Live-preview hover state — single value. interactions.js writes it
// (mouseover/mouseout); byte-stream and at-view's CONTENT slot read it.
// Per-key reactivity on the recaller means only the inspector + the
// CONTENT slot re-run on hover — never the strip itself, never the
// registry list.
export const hovered = liveValue(null, { recaller, name: 'hovered' })

export const loc = liveLocation({ recaller, name: 'location' })

// Per-repo "recently opened" tracker — drives repoCard's
// "syncing… vs 0 b" distinction. When the registry's onOpen
// callback fires for a key, mark it; clear after a grace window.
// Imperfect (the wire has
// no "I'm done sending existing bytes" signal), but human-invisible:
// by the time a user's gaze lands on a row, 1100ms has passed and
// the display has settled to the actual byte count.
const _openedAt = new Map()
export function isSyncing (keyHex) {
  recaller.reportKeyAccess(_openedAt, keyHex)
  const opened = _openedAt.get(keyHex)
  return opened !== undefined && (Date.now() - opened) < 1000
}
registry.onOpen(keyHex => {
  _openedAt.set(keyHex, Date.now())
  recaller.reportKeyMutation(_openedAt, keyHex)
  setTimeout(() => {
    _openedAt.delete(keyHex)
    recaller.reportKeyMutation(_openedAt, keyHex)
  }, 1100)
})

export const getKeyHex = () => {
  if (loc.get('hashParts', 1) !== 'repo') return null
  return loc.get('hashParts', 2) || null
}

export const getAddress = () => {
  if (loc.get('hashParts', 3) !== 'at') return 'HEAD'
  const at = loc.get('hashParts', 4)
  if (at == null) return 'HEAD'
  return at.toUpperCase() === 'HEAD' ? 'HEAD' : +at
}

export function go ({ keyHex, address }) {
  if (!keyHex) return loc.set('hash', '#/')
  if (address == null || address === 'HEAD') return loc.set('hash', `#/repo/${keyHex}`)
  loc.set('hash', `#/repo/${keyHex}/at/${address}`)
}
