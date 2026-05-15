// streamo explorer — entry point. The map of the app:
//
//   Two routes (selected by URL hash)
//     #/                          →  the inlined registry list, below
//     #/repo/<keyHex>[/at/<a>]    →  AtView                    (at-view.js)
//
//   App singletons   context.js        recaller, registry, state, homeKey,
//                                      loc, hovered, getKeyHex / getAddress / go
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
import { recaller, registry, state, homeKey, loc, getKeyHex, go } from './context.js'
import { setupInteractions } from './interactions.js'
import { AtView, handleAtViewAction } from './at-view.js'

// ── Connect ───────────────────────────────────────────────────────────────

const port = +location.port || (location.protocol === 'https:' ? 443 : 80)

// Session reference, populated when registrySync resolves. The paste-a-key
// form below uses session.subscribe(); the conn pill at the top tells the
// user when the connection is ready, so submit-before-ready is rare.
let session = null

// onHello stores the relay's home key in context; follow walks
// home.value.members and cascades subscriptions. Together these are
// the public face — every other repo is reached by pasting a key.
registrySync(registry, location.hostname, port, {
  onHello: msg => { if (msg.home) homeKey.set(msg.home) },
  follow: (keyHex, repo, subscribe) => {
    for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
  }
})
  .then(s => {
    session = s
    state.set('connection', { status: 'ok',  text: `connected · ${location.hostname}:${port}` })
  })
  .catch(e => state.set('connection', { status: 'err', text: `connection failed: ${e.message}` }))

// Paste-a-key form handler. Accepts a 66-char hex public key, asks the
// session to subscribe, then navigates to that repo's at-view. Repos
// the relay hasn't endorsed aren't enumerated to anyone — this is the
// door for everything off the public list (private repos, repos on
// other relays you know about out-of-band).
async function subscribeToPastedKey (e) {
  e.preventDefault()
  const input = e.target.elements.key
  const keyHex = input.value.trim().toLowerCase()
  if (!/^[0-9a-f]{66}$/.test(keyHex)) {
    input.setCustomValidity('Expected a 66-character hex public key')
    input.reportValidity()
    return
  }
  input.setCustomValidity('')
  if (!session) return
  input.value = ''
  await session.subscribe(keyHex)
  go({ keyHex, address: 'HEAD' })
}

// A clickable repo row used by both the home card and the members
// cascade. `extraClass` lets home call attention to itself (the green
// border treatment). Repo may be undefined if subscription is open but
// no bytes have arrived yet; we show the key + a quiet status.
function repoCard (keyHex, repo, extraClass = null) {
  if (!repo) {
    return h`
      <div class=${['row', extraClass]} data-key=${keyHex} data-action="open-repo">
        <span class="row-label">
          <span class="mono dim">${truncKey(keyHex)}</span>
        </span>
        <span class="when dim">…</span>
        <span class="msg dim">syncing…</span>
      </div>
    `
  }
  const last = repo.lastCommit
  const when = last ? fmtDate(last.date) : `${repo.byteLength} b`
  const name = repo.get('name')
  return h`
    <div class=${['row', extraClass]} data-key=${keyHex} data-action="open-repo">
      <span class="row-label">
        ${name ? h`<span class="row-name">${name}</span> ` : null}
        <span class="mono dim">${truncKey(keyHex)}</span>
      </span>
      <span class=${['when', last ? null : 'dim']}>${when}</span>
      <span class="msg dim">${last?.message || ''}</span>
    </div>
  `
}

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
        <h2>home <span class="dim">the relay's public face</span></h2>
        ${() => {
          // Home card — the repo delivered by `hello`. Reads homeKey,
          // looks it up in the registry, renders the same row shape as
          // members below. Until the handshake's `hello` arrives the
          // key is null; once it arrives but bytes haven't streamed in
          // yet the registry lookup is empty.
          const home = homeKey.get()
          if (!home) return h`<div class="empty">waiting for hello…</div>`
          const repo = registry.get(home)
          return repoCard(home, repo, 'home-card')
        }}
        <h2>members <span class="dim">${() => {
          const home = homeKey.get()
          const list = home ? (registry.get(home)?.get('members') ?? []) : []
          return `(${list.length})`
        }}</span></h2>
        ${() => {
          // Members cascade — read home.value.members reactively so the
          // list grows as new participants join. `follow` has already
          // subscribed each one, so registry.get() will be populated
          // for any member whose bytes have streamed in.
          const home = homeKey.get()
          if (!home) return null
          const members = registry.get(home)?.get('members') ?? []
          if (members.length === 0) return h`<div class="empty">no members yet</div>`
          return members.map(memberKey => repoCard(memberKey, registry.get(memberKey)))
        }}
        <h2>subscribe to a key</h2>
        <p class="hint">Private repos aren't enumerated by the relay. Paste a hex public key you know about to fetch it.</p>
        <form class="subscribe-form" onsubmit=${() => subscribeToPastedKey}>
          <input type="text" name="key" placeholder="66-char hex public key" autocomplete="off" spellcheck="false">
          <button type="submit">subscribe</button>
        </form>
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
    case 'open-foreign-at': {
      // Same-host remoteParent citation — the cited repo might not be in
      // the registry yet.  Subscribe (idempotent) before navigating so the
      // at-view doesn't land on an "opening…" empty state.
      const keyHex = el.dataset.keyhex
      const addr = +el.dataset.addr
      if (!/^[0-9a-f]{66}$/.test(keyHex)) return
      ;(async () => {
        if (session) await session.subscribe(keyHex)
        go({ keyHex, address: addr })
      })()
      return
    }
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
