// streamo explorer — entry point. The map of the app:
//
//   Two routes (selected by URL hash)
//     #/                          →  RegistryView   home, list of repos
//     #/repo/<keyHex>[/at/<a>]    →  AtView         a single repo, at an address
//
//   RegistryView      below, in this file
//   AtView            at-view.js
//   tree renderers    trees.js          valueTree / storageTree / referenceTree
//   AtView sections   sections.js       commit selector / sig detail / extras / raw
//   the byte strip    byte-stream.js    SVG strip + inspector + reuse-by-type
//   verify badge      verify.js         sig cache + visual primitives
//   value renderers   render.js         typedValue / bytesChart
//   pure helpers      format.js, shapes.js, walking.js, analytics.js
//   DOM event wiring  interactions.js   drag / hover / post-render strip pin
//
//   App-level reactive state is a single LiveSource — `state`, below.
//   Slots read with state.get(...) (auto-reports access on the recaller);
//   mutations via state.set(...) fire only watchers that touched the
//   changed key. Repo data changes ride the separate bridge channel
//   (registry.dep / registry.fire) — the registry's own Recaller IS
//   the app recaller, so reading repo state in a slot just works.
//
//   URL forms in detail:
//     #/                                — registry list
//     #/repo/<keyHex>                   — at HEAD, shorthand for /at/HEAD
//     #/repo/<keyHex>/at/HEAD           — same thing, explicit form
//     #/repo/<keyHex>/at/<address>      — pinned to a specific byte address

import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { liveObject } from '../../streamo/LiveSource.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { truncKey, fmtDate } from './format.js'
import { makeVerifier } from './verify.js'
import { makeTrees } from './trees.js'
import { setupInteractions } from './interactions.js'
import { makeByteStreamSection } from './byte-stream.js'
import { makeSections } from './sections.js'
import { makeAtView } from './at-view.js'

// ── Connect ───────────────────────────────────────────────────────────────

const recaller = new Recaller('explorer')
const registry = new RepoRegistry(undefined, { recaller, name: 'explorer' })
const { dep, fire } = registry
const port = +location.port || 80
const connEl = document.getElementById('conn')

try {
  await registrySync(registry, location.hostname, port)
  connEl.textContent = `connected · ${location.hostname}:${port}`
  connEl.classList.add('ok')
} catch (e) {
  connEl.textContent = `connection failed: ${e.message}`
  connEl.classList.add('err')
  throw e
}

// ── App state ─────────────────────────────────────────────────────────────

// One LiveSource for all UI state. Every slot's read self-reports on
// the recaller; every set fires only the watchers that touched the
// changed key. That's how the strip stays untouched on hover (only the
// inspector slot reads `hovered`), and how a tab click doesn't disturb
// the address-display in the header (only the tab indicator reads
// `atTab`). The keys, in detail:
//
//   viewKind  'registry' | 'at'              route selector
//   keyHex    string | null                  repo identity within an at-view
//   address   'HEAD' | number | null         byte address within a repo
//   atTab     'value' | 'storage' | 'refs'   which tab is showing
//   hovered   null | number                  hovered chunk address (live preview)
const state = liveObject({
  viewKind: 'registry',
  keyHex:   null,
  address:  null,
  atTab:    'value',
  hovered:  null
}, { recaller, name: 'ui' })

// Signature verification — async cache; fire() triggers a re-render
// when a verify resolves. (See verify.js for the cache shape.)
const verifyStatus = makeVerifier(fire)

// Three trees (value / storage / refs) + their per-chunk expand/collapse
// Sets + the action dispatcher main.js's click delegator forwards to.
const { valueTree, storageTree, referenceTree, handleTreeAction } = makeTrees(fire)

// Smaller AtView pieces: the commit-selector dropdown, the sig-detail
// table, the storage-chunks tuck-away, the raw hex dump.
const { sigDetailBody, commitSelectorSection, repoExtras, rawChunkSection } =
  makeSections({ dep, verifyStatus })

// ── Hash routing ──────────────────────────────────────────────────────────

function viewFromHash () {
  const m = (location.hash || '#/').match(/^#\/repo\/([0-9a-f]+)(?:\/at\/(HEAD|\d+))?\/?$/i)
  if (!m) return { kind: 'registry', keyHex: null, address: null }
  // Bare `/repo/<hex>` is shorthand for `/at/HEAD` — the symbolic pointer
  // to the most recent signed commit (like git's HEAD).
  const raw = m[2]
  const address = raw == null || raw.toUpperCase() === 'HEAD' ? 'HEAD' : +raw
  return { kind: 'at', keyHex: m[1], address }
}

function hashFromView (kind, keyHex, address) {
  if (kind !== 'at') return '#/'
  // Canonical form for HEAD is the bare URL — concise and analogous to
  // tools that imply HEAD when no ref is given.
  if (address === 'HEAD') return `#/repo/${keyHex}`
  return `#/repo/${keyHex}/at/${address}`
}

function go ({ kind, keyHex = null, address = null }) {
  state.set('viewKind', kind)
  state.set('keyHex',   keyHex)
  state.set('address',  address)
  const hash = hashFromView(kind, keyHex, address)
  if (location.hash !== hash) location.hash = hash
}

// Hydrate from the URL on load.
{
  const v = viewFromHash()
  state.set('viewKind', v.kind)
  state.set('keyHex',   v.keyHex)
  state.set('address',  v.address)
}

window.addEventListener('hashchange', () => {
  const v = viewFromHash()
  if (v.kind    === state.get('viewKind') &&
      v.keyHex  === state.get('keyHex')   &&
      v.address === state.get('address')) return
  state.set('viewKind', v.kind)
  state.set('keyHex',   v.keyHex)
  state.set('address',  v.address)
})

// ── DOM wiring ────────────────────────────────────────────────────────────

const appEl = document.getElementById('app')

// Drag-to-pan on the byte strip + hover-preview state + post-render
// strip housekeeping. Mutates state.hovered directly; main.js reads
// it back via state.get('hovered') in any slot that wants the peek.
const { isClickSuppressed, syncStrips } = setupInteractions({ appEl, state })

// Schedule the post-render strip pin-to-HEAD on bridge fires (chunk
// arrivals) or navigation (repo or address change). Debounced to one
// rAF per frame. Hover changes do NOT trigger sync — the strip itself
// doesn't re-render on hover, only the inspector below.
let syncScheduled = false
function scheduleSync () {
  if (syncScheduled) return
  syncScheduled = true
  requestAnimationFrame(() => { syncScheduled = false; syncStrips() })
}
recaller.watch('strip-sync', () => {
  dep()
  state.get('keyHex')
  state.get('address')
  scheduleSync()
})

// The big SVG strip + per-chunk inspector + reuse-by-type table.
const byteStreamSection = makeByteStreamSection({ state })

// The at-view page — orchestrates header + content for one repo.
const AtView = makeAtView({
  state, registry, dep,
  commitSelectorSection, byteStreamSection,
  repoExtras, rawChunkSection, sigDetailBody,
  valueTree, storageTree, referenceTree,
  verifyStatus
})

// ── Views ─────────────────────────────────────────────────────────────────

function RegistryView () {
  return h`
    <h2>repos <span class="dim">${() => { dep(); return `(${[...registry].length})` }}</span></h2>
    ${() => {
      dep()
      const rows = []
      for (const [keyHex, repo] of registry) {
        // No claims about state we can't verify — show the date when we
        // resolve a commit, otherwise show the byte count. byteLength
        // is honest: it's what we actually have on hand. The watcher
        // fires as more chunks land and the row settles to a date once
        // the commit chunk resolves at the end of the stream.
        const last = repo.lastCommit
        const when = last ? fmtDate(last.date) : `${repo.byteLength} b`
        rows.push(h`
          <div class="row" data-key=${keyHex} data-action="open-repo">
            <span class="mono">${truncKey(keyHex)}</span>
            <span class=${['when', last ? null : 'dim']}>${when}</span>
            <span class="msg dim">${last?.message || ''}</span>
          </div>
        `)
      }
      return rows.length ? rows : h`<div class="empty">waiting for repos…</div>`
    }}
  `
}

// ── Mount ─────────────────────────────────────────────────────────────────

// Outer slot reads viewKind + keyHex so it re-runs only on route
// transitions (registry ↔ at) and repo switches — NOT on intra-repo
// navigation, chunk arrivals, tab clicks, or hover. Each view gets a
// data-keyed <section> so mount's reconciler drops/rebuilds the right
// thing on a switch. Inner reactivity (chunk arrivals, address, tab,
// hover) lives inside RegistryView and AtView.
mount(h`${() => {
  const kind = state.get('viewKind')
  if (kind === 'registry') {
    return h`<section class="view" data-key="view-registry">${RegistryView()}</section>`
  }
  const keyHex = state.get('keyHex')
  return h`<section class="view" data-key=${`view-at-${keyHex}`}>${AtView({ keyHex })}</section>`
}}`, appEl, recaller)

// ── Click delegation ──────────────────────────────────────────────────────

appEl.addEventListener('click', e => {
  // Suppress the click that fires at the end of a drag-to-pan, so dragging
  // doesn't accidentally navigate to a chunk under the pointer when the
  // user releases.
  if (isClickSuppressed()) return
  const el = e.target.closest('[data-action]')
  if (!el) return
  switch (el.dataset.action) {
    case 'open-repo':     return go({ kind: 'at', keyHex: el.dataset.key,    address: 'HEAD' })
    case 'open-at':       return go({ kind: 'at', keyHex: el.dataset.keyhex, address: +el.dataset.addr })
    case 'back-registry': return go({ kind: 'registry' })
    case 'back-repo':     return go({ kind: 'at', keyHex: el.dataset.keyhex, address: 'HEAD' })
    case 'set-tab':       return state.set('atTab', el.dataset.tab)
    case 'select-commit': {
      // Picking a commit is just navigation — go to /at/<sigAddress>.
      // Close the dropdown imperatively so the new view renders with
      // the selector collapsed (matches native <select> behavior).
      el.closest('details.commit-selector')?.removeAttribute('open')
      return go({ kind: 'at', keyHex: el.dataset.keyhex, address: +el.dataset.addr })
    }
    case 'expand-tree':
    case 'collapse-tree':
    case 'expand-storage':
    case 'collapse-storage':
    case 'expand-refs':
    case 'collapse-refs':
      return handleTreeAction(el.dataset.action, `${el.dataset.keyhex}:${el.dataset.addr}`)
  }
})
