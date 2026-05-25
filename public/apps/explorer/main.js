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
//     - set up document.body event wiring (drag, wheel-spin, post-render sync)
//     - mount one template against document.body
//     - delegate clicks (navigation actions here; view actions to AtView)

import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { registrySync } from '../../streamo/registrySync.js'
import { liveValue } from '../../streamo/LiveSource.js'
import { truncKey, fmtDate } from './format.js'
import { recaller, registry, state, homeKey, loc, getKeyHex, go, isSyncing } from './context.js'
import { setupInteractions } from './interactions.js'
import { setupCommitWheel } from './commit-wheel.js'
import { AtView, handleAtViewAction } from './at-view.js'

// ── Connect ───────────────────────────────────────────────────────────────

const port = +location.port || (location.protocol === 'https:' ? 443 : 80)

// Session reference, populated when registrySync resolves. The paste-a-key
// form below uses session.subscribe(); the conn pill at the top tells the
// user when the connection is ready, so submit-before-ready is rare.
let session = null

// Currently-announcing peers on the home topic — populated live by the
// announce/interest ephemeral layer, which is now how chat-room membership
// is surfaced (no signed `members` array anymore). Append-on-first-seen,
// so the order is stable for the UI; we don't drop entries on peer
// disconnect because the explorer is a passive observer and stale rows
// already render naturally as "syncing…" once their repo stops updating.
const currentMembers = liveValue([], { recaller, name: 'currentMembers' })

// onHello stores the relay's home key in context; follow walks
// home.value.journalists and cascades subscriptions. The `members`
// list, when present (historical data on existing relays), is also
// walked — new joins arrive via announce instead.
registrySync(registry, location.hostname, port, {
  onHello: msg => { if (msg.home) homeKey.set(msg.home) },
  // Connection pill — follows the live socket across reconnects. registrySync
  // reconnects on its own now, so a drop reads "reconnecting…" rather than the
  // old "refresh to reconnect", which no longer reflects what happens.
  onConnectionChange: connected => {
    state.set('connection', connected
      ? { status: 'ok',  text: `connected · ${location.hostname}:${port}` }
      : { status: 'err', text: 'reconnecting…' })
  },
  follow: (keyHex, repo, subscribe) => {
    // Walk both `members` (legacy — historical chat participants on
    // relays from before the announce-based discovery model) and
    // `journalists` (peers whose repos contribute named slices —
    // currently entries + the history streamo). Both are "interesting
    // to the explorer" lists.
    for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
    for (const journalistKey of repo.get('journalists') ?? []) subscribe(journalistKey)
  },
  onAnnounce: (key, topic) => {
    // The relay replays current announces to us on interest, and fans
    // out new ones live. Filter to the home topic and accumulate.
    if (topic !== homeKey.get()) return
    const list = currentMembers.get()
    if (!list.includes(key)) currentMembers.set([...list, key])
    // Subscribe so the row can render the peer's name + lastCommit.
    session?.subscribe(key)
  }
})
  .then(s => {
    session = s
    // The connection pill is driven by `onConnectionChange` above — it
    // tracks the live socket across reconnects, where a handler bound to
    // a single `s.ws` could not.
    // Express interest in the home topic once it's known. The watch
    // re-fires when homeKey arrives from `hello`; idempotent on the
    // server side, so the once-it-arrives behavior is what we want.
    recaller.watch('explorer-interest', () => {
      const home = homeKey.get()
      if (home) session.interest(home)
    })
    // Auto-subscribe to a URL-named key the registry doesn't already hold.
    // Without this, opening `#/repo/<keyHex>` cold (a shared link, a paste)
    // leaves AtView reading `registry.get(keyHex) === undefined` and sitting
    // on "opening…" forever. Reads `getKeyHex()` (URL → hashParts 1+2) and
    // `registry.get(keyHex)` (registry keys) — so the watcher refires on
    // either nav or arrival, and self-quiets once bytes are in.
    recaller.watch('explorer-auto-subscribe', () => {
      const keyHex = getKeyHex()
      if (!keyHex) return
      if (!/^[0-9a-f]{66}$/.test(keyHex)) return
      if (registry.get(keyHex)) return
      session.subscribe(keyHex)
    })
  })
  .catch(e => state.set('connection', { status: 'err', text: `connection failed: ${e.message}` }))

// Paste-a-key form handler. Accepts a 66-char hex public key, asks the
// session to subscribe, then navigates to that repo's at-view. StreamoRecords
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
// border treatment). StreamoRecord may be undefined if subscription is open but
// no bytes have arrived yet; we show the key + a quiet status.
function repoCard (keyHex, repo, extraClass = null) {
  if (!repo) {
    return h`
      <div class=${['row', 'repo-card', extraClass]} data-key=${keyHex} data-action="open-repo">
        <span class="row-label">
          <span class="mono dim">${truncKey(keyHex)}</span>
        </span>
        <span class="bytes dim">syncing…</span>
        <span class="when dim">—</span>
        <span class="msg dim"></span>
      </div>
    `
  }
  const last = repo.lastCommit
  const name = repo.get('name')
  // Bytes column is always visible; "syncing…" only during the
  // grace window after a key first lands in the registry, then
  // falls back to "0 b" / "N b" so 0-byte-but-loaded repos read
  // as truly empty.
  const pendingSync = repo.byteLength === 0 && isSyncing(keyHex)
  return h`
    <div class=${['row', 'repo-card', extraClass]} data-key=${keyHex} data-action="open-repo">
      <span class="row-label">
        ${name ? h`<span class="row-name">${name}</span> ` : null}
        <span class="mono dim">${truncKey(keyHex)}</span>
      </span>
      <span class=${['bytes', pendingSync ? 'dim' : null]}>${pendingSync ? 'syncing…' : `${repo.byteLength} b`}</span>
      <span class=${['when', last ? null : 'dim']}>${last ? fmtDate(last.date) : '—'}</span>
      <span class="msg dim">${last?.message || ''}</span>
    </div>
  `
}

// ── DOM wiring ────────────────────────────────────────────────────────────

const { isClickSuppressed, syncStrips } = setupInteractions({ appEl: document.body })
const { syncWheel } = setupCommitWheel({ appEl: document.body })

// Schedule the post-render pass on bridge fires (chunk arrivals) or
// navigation: pin the byte strip to HEAD and seed any freshly-mounted
// commit wheel. Debounced to one rAF per frame. Hover changes do NOT
// trigger sync — neither the strip nor the wheel re-renders on hover.
let syncScheduled = false
function scheduleSync () {
  if (syncScheduled) return
  syncScheduled = true
  requestAnimationFrame(() => { syncScheduled = false; syncStrips(); syncWheel() })
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
  <h1>
    <a class="brand-lockup" href="/" title="streamo home">
      <img src="/streamo.svg" alt="">streamo
    </a>
    <span class="page-title">explorer</span>
  </h1>
  <div class=${() => ['conn', state.get('connection').status || null]}>${() => state.get('connection').text}</div>
  ${() => {
    const keyHex = getKeyHex()
    if (!keyHex) return h`
      <section class="view" data-key="view-registry">
        <div class="registry-stats">
          <strong>StreamoRecord Registry</strong>
          <span class="dim">·</span>
          ${() => {
            // Iterating registry registers (registry, 'keys') for new-repo
            // opens. Each repo.byteLength registers (repo, 'length') for
            // chunk arrivals. So this cell wakes on either, keeping the
            // counts live.
            let open = 0
            let synced = 0
            for (const [, repo] of registry) {
              open++
              if (repo.byteLength > 0) synced++
            }
            return h`<span><strong>${open}</strong> open</span> <span class="dim">·</span> <span><strong>${synced}</strong> synced</span>`
          }}
        </div>
        <h2>home</h2>
        <p class="subtext">the relay's public face</p>
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
        <h2>online <span class="dim">${() => `(${currentMembers.get().length})`}</span></h2>
        <p class="subtext">chat — currently announcing</p>
        ${() => {
          // Currently-announcing peers on the home topic — the live, ephemeral
          // version of "who's in the room right now." Populated by the
          // announce/interest layer (server replays existing announcers on
          // interest + fans out new ones live). No signed roster involved.
          const members = currentMembers.get()
          if (members.length === 0) return h`<div class="empty">no one is here right now</div>`
          return members.map(memberKey => repoCard(memberKey, registry.get(memberKey)))
        }}
        <h2>journalists <span class="dim">${() => {
          const home = homeKey.get()
          if (!home) return ''
          const list = (registry.get(home)?.get('journalists') ?? []).filter(k => k !== home)
          return `(${list.length})`
        }}</span></h2>
        <p class="subtext">journal — contributing peers</p>
        ${() => {
          // Journalists cascade — repos contributing named slices (entries,
          // the project's git-history streamo, future contributors). The
          // home repo's own key is in the list canonically but is shown as
          // the home card above, so we filter it out here to avoid the
          // duplicate row.
          const home = homeKey.get()
          if (!home) return null
          const journalists = (registry.get(home)?.get('journalists') ?? []).filter(k => k !== home)
          if (journalists.length === 0) return h`<div class="empty">no journalists registered</div>`
          return journalists.map(jKey => repoCard(jKey, registry.get(jKey)))
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
