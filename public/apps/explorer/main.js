// streamo explorer — entry point. The map of the app:
//
//   Two routes (selected by URL hash)
//     #/                          →  the inlined registry list, below
//     #/repo/<keyHex>[/at/<a>]    →  AtView                    (at-view.js)
//
//   App singletons   context.js        recaller, registry, state, loc, hovered,
//                                      getKeyHex / getAddress / go
//   AtView           at-view.js        owns its own atTab + sub-factories
//   DOM event wiring interactions.js   drag / hover / post-render strip pin
//
//   main.js's job:
//     - connect via registrySync (then update state.connection)
//     - set up document.body event wiring (drag + post-render strip sync)
//     - mount one template against document.body
//     - delegate clicks (navigation actions here; view actions to AtView)

import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { registrySync } from '../../streamo/registrySync.js'
import { truncKey, fmtDate } from './format.js'
import { recaller, registry, state, loc, getKeyHex, go } from './context.js'
import { setupInteractions } from './interactions.js'
import { AtView, handleAtViewAction } from './at-view.js'

// ── Connect ───────────────────────────────────────────────────────────────

const port = +location.port || 80

// Connection status — fires `connection` so the conn-pill slot in the
// mount template re-renders. Not awaited: the page paints immediately
// with the "connecting…" state; the .then / .catch flips it later.
registrySync(registry, location.hostname, port)
  .then(() => state.set('connection', { status: 'ok',  text: `connected · ${location.hostname}:${port}` }))
  .catch(e => state.set('connection', { status: 'err', text: `connection failed: ${e.message}` }))

// ── DOM wiring ────────────────────────────────────────────────────────────

const { isClickSuppressed, syncStrips } = setupInteractions({ appEl: document.body })

// Schedule the post-render strip pin-to-HEAD on bridge fires (chunk
// arrivals) or navigation. Debounced to one rAF per frame. Hover
// changes do NOT trigger sync — the strip itself doesn't re-render
// on hover, only the inspector below.
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

// ── Mount ─────────────────────────────────────────────────────────────────

// The whole page in one mount call. Header + conn pill are static
// chrome at the top; the route slot reads getKeyHex() and returns
// either the inlined registry list or AtView. The route slot
// subscribes only to hashParts.1 + .2, so intra-repo address changes
// don't re-run it (only at-view's inner slots wake on those).
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
    if (!keyHex) return h`
      <section class="view" data-key="view-registry">
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
      </section>
    `
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
    case 'select-commit': {
      // Picking a commit is just navigation — go to /at/<sigAddress>.
      // Close the dropdown imperatively so the new view renders with
      // the selector collapsed (matches native <select> behavior).
      el.closest('details.commit-selector')?.removeAttribute('open')
      return go({ keyHex: el.dataset.keyhex, address: +el.dataset.addr })
    }
    // Anything else (set-tab, expand-*, collapse-*) is at-view's business.
    default:
      return handleAtViewAction(el.dataset.action, el)
  }
})
