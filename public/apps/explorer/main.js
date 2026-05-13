// streamo explorer — entry point. The map of the app:
//
//   Two routes (selected by URL hash)
//     #/                          →  RegistryView   home, list of repos
//     #/repo/<keyHex>[/at/<a>]    →  AtView         a single repo, at an address
//
//   App singletons   context.js        recaller, registry, state, loc, hovered,
//                                      getKeyHex / getAddress / go
//   RegistryView     below, in this file
//   AtView           at-view.js
//   tree renderers   trees.js          valueTree / storageTree / referenceTree
//   AtView sections  sections.js       commit selector / sig detail / extras / raw
//   the byte strip   byte-stream.js    SVG strip + inspector + reuse-by-type
//   verify badge     verify.js         sig cache + visual primitives
//   value renderers  render.js         typedValue / bytesChart
//   pure helpers     format.js, shapes.js, walking.js, analytics.js
//   DOM event wiring interactions.js   drag / hover / post-render strip pin

import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { registrySync } from '../../streamo/registrySync.js'
import { truncKey, fmtDate } from './format.js'
import { recaller, registry, state, loc, getKeyHex, getAddress, go } from './context.js'
import { makeVerifier } from './verify.js'
import { makeTrees } from './trees.js'
import { setupInteractions } from './interactions.js'
import { makeByteStreamSection } from './byte-stream.js'
import { makeSections } from './sections.js'
import { makeAtView } from './at-view.js'

// ── Connect ───────────────────────────────────────────────────────────────

const port = +location.port || 80

// Connection status — fires `connection` so the conn-pill slot in the
// mount template re-renders. Not awaited: the page paints immediately
// with the "connecting…" state; the .then / .catch flips it later.
registrySync(registry, location.hostname, port)
  .then(() => state.set('connection', { status: 'ok',  text: `connected · ${location.hostname}:${port}` }))
  .catch(e => state.set('connection', { status: 'err', text: `connection failed: ${e.message}` }))

// ── Sub-factory wiring (lifted from main.js will likely move into at-view.js) ──

const verifyStatus = makeVerifier(recaller)
const { valueTree, storageTree, referenceTree, handleTreeAction } = makeTrees(recaller)
const { sigDetailBody, commitSelectorSection, repoExtras, rawChunkSection } =
  makeSections({ verifyStatus })

const { isClickSuppressed, syncStrips } = setupInteractions({ appEl: document.body })

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
  // arrivals. Reading loc.hash subscribes us to navigation.
  for (const [, repo] of registry) repo.byteLength
  loc.get('hash')
  scheduleSync()
})

const byteStreamSection = makeByteStreamSection()
const AtView = makeAtView({
  getAddress, registry,
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

// The whole page in one mount call. Header + conn pill are static
// chrome at the top; the route slot reads getKeyHex() and returns
// the right view section. Each section's data-key is a static-per-
// render string (interpolated in the h template at slot-run time) so
// mount's reconciler keys correctly — same keyHex → DOM reused,
// different keyHex → fresh-mount. Inner reactivity (chunk arrivals,
// address, tab, hover) lives inside RegistryView and AtView. The
// route slot subscribes only to hashParts.1 + .2, so intra-repo
// address changes don't re-run it.
mount(h`
  <div class="header">
    <a class="brand-lockup" href="/" title="streamo home">
      <img src="/streamo.svg" alt="">streamo
    </a>
    <span class="page-title">explorer</span>
  </div>
  <div class=${() => ['conn', state.get('connection').status || null]}>${() => state.get('connection').text}</div>
  ${() => {
    const keyHex = getKeyHex()
    if (!keyHex) return h`<section class="view" data-key="view-registry">${RegistryView()}</section>`
    return h`<section class="view" data-key=${`view-at-${keyHex}`}>${AtView({ keyHex })}</section>`
  }}
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
