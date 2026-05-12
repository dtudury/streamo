// streamo explorer — read-only registry / address browser.
//
// Two view kinds, navigated by URL hash:
//   #/                                — registry list
//   #/repo/<keyHex>                   — at HEAD, the most-recent sig
//                                       (symbolic, like git's HEAD ref).
//                                       Shorthand for /at/HEAD.
//   #/repo/<keyHex>/at/HEAD           — same thing, explicit form.
//   #/repo/<keyHex>/at/<address>      — pinned to a specific byte address.
//
// When the resolved chunk is a SIGNATURE, the page is the polished
// signed-commit view (selector dropdown at top, polished detail below,
// storage chunks tucked into a <details>). Otherwise it's storage
// drilling — value/storage tabs for that chunk, no selector.
//
// Reactivity is bridged from each Repo's internal Recaller into the
// app-level Recaller via bridgeRegistry — see design.md §6 for why
// each Repo has its own Recaller and how the bridge connects them.

import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { bridgeRegistry } from '../../streamo/bridgeRegistry.js'
import { truncKey, fmtDate } from './format.js'
import { makeVerifier } from './verify.js'
import { makeTrees } from './trees.js'
import { setupInteractions } from './interactions.js'
import { makeByteStreamSection } from './byte-stream.js'
import { makeSections } from './sections.js'
import { makeAtView } from './at-view.js'

// ── Connect ───────────────────────────────────────────────────────────────

const registry = new RepoRegistry()
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

// ── App-level reactivity ──────────────────────────────────────────────────

const recaller = new Recaller('explorer')
const { dep, fire: bridgeFire } = bridgeRegistry(registry, recaller, 'explorer')

// Wrap bridgeFire to also schedule the byte-strip pin-to-HEAD side effect
// after the next render. Reactive mutation is synchronous (so the slot
// re-runs at next tick); only the post-render DOM peek goes through rAF.
let stripSyncScheduled = false
function fire () {
  bridgeFire()
  if (stripSyncScheduled) return
  stripSyncScheduled = true
  requestAnimationFrame(() => { stripSyncScheduled = false; syncByteStrips() })
}

// Signature-verification cache, bound to fire() so async-resolved
// statuses trigger a re-render. See verify.js for the cache shape.
const verifyStatus = makeVerifier(fire)

// Three tree renderers + their expand/collapse state + their action
// dispatcher, all bound to fire() — see trees.js.
const { valueTree, storageTree, referenceTree, handleTreeAction } = makeTrees(fire)

// The smaller AtView sections (commit selector dropdown, sig detail
// table, "other storage chunks" tuck-away, raw hex dump). Closed over
// dep + verifyStatus for the per-commit badge slot.
const { sigDetailBody, commitSelectorSection, repoExtras, rawChunkSection } =
  makeSections({ dep, verifyStatus })

// Hover-only signal — separate from the bridge. Hover events that
// only set hoveredAddress fire hoverSignal exclusively; slots that
// read hoverDep() re-run, slots that don't are left alone. This is
// what keeps hovering the strip from re-rendering the strip itself.
const hoverSignal = {}
const hoverDep = () => recaller.reportKeyAccess(hoverSignal, 'data')
const hoverFire = () => recaller.reportKeyMutation(hoverSignal, 'data')

// View-shape signal — fires only when view.kind or view.keyHex
// changes. The outer mount slot watches this (NOT bridge), so
// intra-repo navigation (address changes within an at-view) does
// NOT re-run the outer slot, does NOT recreate AtView's inner slots,
// does NOT fresh-mount the byte-strip-container. Inner slots watch
// bridge — they re-run on address change, chunk arrivals, tab clicks,
// async results — and recursive-reconcile preserves the strip's DOM
// (scrollLeft, focus, keyed children) across those re-runs.
//
// Together with hoverSignal, this is the full signal decomposition:
//   viewKindSignal — kind/keyHex (registry ↔ at-view, repo switch)
//   bridge         — chunks, address, tab, async (everything else)
//   hoverSignal    — strip hover preview
const viewKindSignal = {}
const viewKindDep = () => recaller.reportKeyAccess(viewKindSignal, 'data')
const viewKindFire = () => recaller.reportKeyMutation(viewKindSignal, 'data')

// ── Hash routing ──────────────────────────────────────────────────────────

function viewFromHash () {
  const m = (location.hash || '#/').match(/^#\/repo\/([0-9a-f]+)(?:\/at\/(HEAD|\d+))?\/?$/i)
  if (!m) return { kind: 'registry' }
  // Bare `/repo/<hex>` is shorthand for `/at/HEAD` — the symbolic pointer
  // to the most recent signed commit (like git's HEAD).
  const raw = m[2]
  const address = raw == null || raw.toUpperCase() === 'HEAD' ? 'HEAD' : +raw
  return { kind: 'at', keyHex: m[1], address }
}

function hashFromView (v) {
  if (v.kind !== 'at') return '#/'
  // Canonical form for HEAD is the bare URL — concise and analogous to
  // tools that imply HEAD when no ref is given.
  if (v.address === 'HEAD') return `#/repo/${v.keyHex}`
  return `#/repo/${v.keyHex}/at/${v.address}`
}

let view = viewFromHash()
function go (next) {
  const kindChanged = next.kind !== view.kind || next.keyHex !== view.keyHex
  view = next
  const target = hashFromView(next)
  if (location.hash !== target) location.hash = target
  if (kindChanged) viewKindFire()
  fire()
}
window.addEventListener('hashchange', () => {
  const next = viewFromHash()
  if (next.kind === view.kind && next.keyHex === view.keyHex && next.address === view.address) return
  const kindChanged = next.kind !== view.kind || next.keyHex !== view.keyHex
  view = next
  if (kindChanged) viewKindFire()
  fire()
})

// At-view tab state — persists across at-view navigations so a user who
// wants to keep a "storage" lens on doesn't have to re-click after every
// drill-down. Reset to default on registry/repo views (set in go()).
let atTab = 'value'

// ── Helpers ───────────────────────────────────────────────────────────────


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
        const len = repo.byteLength
        const when = last ? fmtDate(last.date) : `${len} b`
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

const appEl = document.getElementById('app')

// Drag/hover/strip-sync wiring + the closure-local state they share.
// AtView slots reach for getHoveredAddress() when peeking; the click
// delegator reaches for isClickSuppressed() to avoid the end-of-drag
// click; fire() invokes syncByteStrips after each reactive cycle.
const { isClickSuppressed, getHoveredAddress, syncByteStrips } =
  setupInteractions({ appEl, onHoverChange: hoverFire })

// The big SVG byte-strip + per-chunk inspector + per-codec rollup
// table. Reads hoverDep (from this module's recaller) so the inspector
// re-renders on hover; reads getHoveredAddress (from interactions) for
// the current peek.
const byteStreamSection = makeByteStreamSection({ hoverDep, getHoveredAddress })

// AtView — the big repo page. Closes over getters for the mutable
// view + atTab module state (so its slots re-read on every reactive
// run) plus the factory-instances above.
const AtView = makeAtView({
  getView: () => view,
  getAtTab: () => atTab,
  registry,
  dep, hoverDep, getHoveredAddress,
  commitSelectorSection, byteStreamSection,
  repoExtras, rawChunkSection, sigDetailBody,
  valueTree, storageTree, referenceTree,
  verifyStatus
})

// Outer mount slot. Reads viewKindDep ONLY — re-runs on view.kind
// or view.keyHex changes (registry ↔ at, or switching repos). It does
// NOT re-run on address changes, chunk arrivals, tab clicks, or any
// other bridge fire. That's the whole point of the decomposition:
// keep the at-view's <section> (and the strip-container inside it)
// alive across intra-repo navigation so click-to-navigate doesn't
// rebuild the strip and reset its scrollLeft.
//
// Each view gets a data-keyed <section> so mount's matcher distinguishes
// them — switching from registry to an at-view, or between repos, drops
// the old section and fresh-mounts the new one. RegistryView and AtView
// each do their own internal reactivity (inner slots reading dep() and
// hoverDep()) for everything within a view.
mount(h`${() => {
  viewKindDep()
  switch (view.kind) {
    case 'registry': return h`<section class="view" data-key="view-registry">${RegistryView()}</section>`
    case 'at':       return h`<section class="view" data-key=${`view-at-${view.keyHex}`}>${AtView({ keyHex: view.keyHex })}</section>`
    default:         return h`<div class="empty">?</div>`
  }
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
    case 'open-repo':     return go({ kind: 'at', keyHex: el.dataset.key, address: 'HEAD' })
    case 'open-at':       return go({ kind: 'at', keyHex: el.dataset.keyhex, address: +el.dataset.addr })
    case 'back-registry': return go({ kind: 'registry' })
    case 'back-repo':     return go({ kind: 'at', keyHex: el.dataset.keyhex, address: 'HEAD' })
    case 'set-tab':       atTab = el.dataset.tab; return fire()
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
      handleTreeAction(el.dataset.action, `${el.dataset.keyhex}:${el.dataset.addr}`)
      return
  }
})

