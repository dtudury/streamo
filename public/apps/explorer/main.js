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
//   All reactive state — URL route AND UI (tab/hover) AND repo data
//   AND subsystem caches (verify, tree expansion) — rides ONE Recaller.
//   Slots subscribe via the reads they already do:
//     getKeyHex(), getAddress() — URL route accessors
//     state.get(...)        — non-URL UI state (tab, hover)
//     repo.byteLength etc.  — repo data (default factory shares the recaller)
//     cache.get(...)        — verify + trees subsystem caches
//   No explicit dep/fire ceremony.
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
import { liveLocation } from '../../streamo/liveLocation.js'
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
const port = +location.port || 80

// ── App state ─────────────────────────────────────────────────────────────

// One LiveSource for the UI state that isn't URL-derived. Route
// state (viewKind/keyHex/address) lives in the URL via `loc` below,
// not here.
//   atTab        'value' | 'storage' | 'refs'  which tab is showing
//   hovered      null | number                 hovered chunk address (live preview)
//   connection   { status, text }              connection-pill state, updated below
const state = liveObject({
  atTab:      'value',
  hovered:    null,
  connection: { status: '', text: 'connecting…' }
}, { recaller, name: 'ui' })

// Connection status — fires `connection` so the conn-pill slot in the
// mount template re-renders. Not awaited: the page paints immediately
// with the "connecting…" state; the .then / .catch flips it later.
registrySync(registry, location.hostname, port)
  .then(() => state.set('connection', { status: 'ok',  text: `connected · ${location.hostname}:${port}` }))
  .catch(e => state.set('connection', { status: 'err', text: `connection failed: ${e.message}` }))

// Signature verification — async cache, LiveSource-backed. Slots that
// call verifyStatus(...) auto-subscribe to their own cacheKey via the
// liveObject inside; nothing to wire here. (See verify.js.)
const verifyStatus = makeVerifier(recaller)

// Three trees (value / storage / refs) + their per-chunk expand/collapse
// state (a LiveSource keyed by `${tree}:${keyHex}:${addr}`) + the action
// dispatcher main.js's click delegator forwards to.
const { valueTree, storageTree, referenceTree, handleTreeAction } = makeTrees(recaller)

// Smaller AtView pieces: the commit-selector dropdown, the sig-detail
// table, the storage-chunks tuck-away, the raw hex dump.
const { sigDetailBody, commitSelectorSection, repoExtras, rawChunkSection } =
  makeSections({ verifyStatus })

// ── Routing ───────────────────────────────────────────────────────────────
//
// The URL hash IS the route state. liveLocation wraps window.location
// as a LiveSource on our recaller — getKeyHex / getAddress parse what
// each consumer needs from `loc.get('hash')` inside the calling slot,
// so the slot re-runs on hashchange / popstate without any explicit
// listener. The mount template uses these accessors in `when(...)`
// clauses for routing; AtView reads getAddress for the current pin.
//
// URL forms:
//   #/                                — registry list (getKeyHex === null)
//   #/repo/<keyHex>                   — at HEAD, shorthand for /at/HEAD
//   #/repo/<keyHex>/at/HEAD           — same thing, explicit form
//   #/repo/<keyHex>/at/<address>      — pinned to a specific byte address

const loc = liveLocation({ recaller, name: 'location' })

const getKeyHex = () => {
  const m = (loc.get('hash') || '').match(/^#\/repo\/([0-9a-f]+)/i)
  return m?.[1] ?? null
}

const getAddress = () => {
  const m = (loc.get('hash') || '').match(/\/at\/(HEAD|\d+)/i)
  if (!m) return 'HEAD'
  return m[1].toUpperCase() === 'HEAD' ? 'HEAD' : +m[1]
}

function go ({ keyHex, address }) {
  if (!keyHex) return loc.set('hash', '#/')
  if (address == null || address === 'HEAD') return loc.set('hash', `#/repo/${keyHex}`)
  loc.set('hash', `#/repo/${keyHex}/at/${address}`)
}

// `when(cond, vnode)` — render `vnode` when cond() is truthy.
const when = (cond, vnode) => () => cond() ? vnode : null

// ── DOM wiring ────────────────────────────────────────────────────────────

// mount() owns the whole body — the header, conn pill, and view all
// live inside one template below. index.html is a minimal shim with
// a "connecting…" loading message that mount() replaces on first paint.

// Drag-to-pan on the byte strip + hover-preview state + post-render
// strip housekeeping. Mutates state.hovered directly; main.js reads
// it back via state.get('hovered') in any slot that wants the peek.
const { isClickSuppressed, syncStrips } = setupInteractions({ appEl: document.body, state })

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
  // Iterating registry registers on (registry, 'keys') — new-repo opens.
  // Touching repo.byteLength registers on each (repo, 'length') — chunk
  // arrivals. Reading loc.hash subscribes us to navigation. Together
  // the watcher wakes on everything that could change strip layout.
  for (const [, repo] of registry) repo.byteLength
  loc.get('hash')
  scheduleSync()
})

// The big SVG strip + per-chunk inspector + reuse-by-type table.
const byteStreamSection = makeByteStreamSection({ state })

// The at-view page — orchestrates header + content for one repo.
const AtView = makeAtView({
  state, getAddress, registry,
  commitSelectorSection, byteStreamSection,
  repoExtras, rawChunkSection, sigDetailBody,
  valueTree, storageTree, referenceTree,
  verifyStatus
})

// ── Views ─────────────────────────────────────────────────────────────────

function RegistryView () {
  return h`
    <h2>repos <span class="dim">${() => `(${[...registry].length})`}</span></h2>
    ${() => {
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

// The whole page in one mount call. The header + conn pill are static
// chrome at the top; the two `when(...)` clauses below are the routes —
// one for the registry list (no repo in the URL), one for an at-view
// (a repo in the URL). Each rendered section's data-key matches
// mount's reconciler so the right thing drops/rebuilds on a route
// transition. Inner reactivity (chunk arrivals, address, tab, hover)
// lives inside RegistryView and AtView.
mount(h`
  <div class="header">
    <a class="brand-lockup" href="/" title="streamo home">
      <img src="/streamo.svg" alt="">streamo
    </a>
    <span class="page-title">explorer</span>
  </div>
  <div class=${() => ['conn', state.get('connection').status || null]}>${() => state.get('connection').text}</div>
  ${when(() => !getKeyHex(), h`<section class="view" data-key="view-registry">${RegistryView()}</section>`)}
  ${when(getKeyHex, h`<section class="view" data-key=${() => `view-at-${getKeyHex()}`}>${() => AtView({ keyHex: getKeyHex() })}</section>`)}
`, document.body, recaller)

// ── Click delegation ──────────────────────────────────────────────────────

document.body.addEventListener('click', e => {
  // Suppress the click that fires at the end of a drag-to-pan, so dragging
  // doesn't accidentally navigate to a chunk under the pointer when the
  // user releases.
  if (isClickSuppressed()) return
  const el = e.target.closest('[data-action]')
  if (!el) return
  switch (el.dataset.action) {
    case 'open-repo':     return go({ keyHex: el.dataset.key,    address: 'HEAD' })
    case 'open-at':       return go({ keyHex: el.dataset.keyhex, address: +el.dataset.addr })
    case 'back-registry': return go({})
    case 'back-repo':     return go({ keyHex: el.dataset.keyhex, address: 'HEAD' })
    case 'set-tab':       return state.set('atTab', el.dataset.tab)
    case 'select-commit': {
      // Picking a commit is just navigation — go to /at/<sigAddress>.
      // Close the dropdown imperatively so the new view renders with
      // the selector collapsed (matches native <select> behavior).
      el.closest('details.commit-selector')?.removeAttribute('open')
      return go({ keyHex: el.dataset.keyhex, address: +el.dataset.addr })
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
