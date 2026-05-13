// streamo explorer — the app's context. Singletons every other
// module imports from. Constructing them at module-init time means
// each consumer can `import { state, registry, ... }` without main.js
// having to thread them through factory calls.
//
//   recaller     the one Recaller every reactive thing shares
//   registry     RepoRegistry — exposes its own dep/fire via shared recaller
//   state        cross-view UI state (currently just connection-pill)
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

// Cross-view UI state.
//   connection  { status, text }              — registrySync writes; conn pill reads
//   atTab       'value' | 'storage' | 'refs'  — at-view's active tab (will likely
//                                               move into at-view's own state)
export const state = liveObject({
  connection: { status: '', text: 'connecting…' },
  atTab:      'value'
}, { recaller, name: 'app' })

// Live-preview hover state — single value. interactions.js writes it
// (mouseover/mouseout); byte-stream and at-view's CONTENT slot read it.
// Per-key reactivity on the recaller means only the inspector + the
// CONTENT slot re-run on hover — never the strip itself, never the
// registry list.
export const hovered = liveValue(null, { recaller, name: 'hovered' })

export const loc = liveLocation({ recaller, name: 'location' })

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
