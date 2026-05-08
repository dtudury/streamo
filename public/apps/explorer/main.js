// streamo explorer — read-only registry / repo / commit browser.
//
// Three views, single click-through navigation: registry list → repo's
// commit history → value at commit. State lives in plain JS variables;
// reactivity is bridged from each Repo's internal Recaller into the
// app-level Recaller via the `signal` pattern (see chat/main.js for the
// same approach).

import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'

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
//
// Each Repo has its own Recaller. mount() needs a single Recaller to drive
// re-renders. Bridge by watching each repo's length (which fires on both
// new local commits and incoming sync chunks) and forwarding a single
// mutation onto the app-level recaller. Slots that depend on any registry
// state call dep() to register the dependency.
//
// fire() is coalesced via requestAnimationFrame so the chaos of many repos
// streaming chunks during initial sync collapses into one render per frame —
// otherwise each chunk re-fires the outer slot and Recaller's flush loop
// hits its iteration limit.

const recaller = new Recaller('explorer')
const signal = {}
const dep = () => recaller.reportKeyAccess(signal, 'data')

const schedule = typeof requestAnimationFrame !== 'undefined'
  ? fn => requestAnimationFrame(fn)
  : fn => queueMicrotask(fn)
let scheduled = false
function fire () {
  if (scheduled) return
  scheduled = true
  schedule(() => { scheduled = false; recaller.reportKeyMutation(signal, 'data') })
}

const watched = new Set()
function watchRepo (key, repo) {
  if (watched.has(key)) return
  watched.add(key)
  repo.watch(`explorer:${key}`, () => {
    repo.byteLength
    fire()
  })
}
for (const [k, r] of registry) watchRepo(k, r)
registry.onOpen((k, r) => { watchRepo(k, r); fire() })

// ── Navigation ────────────────────────────────────────────────────────────
//
// View state is reflected in location.hash so refresh / bookmark / back-button
// all work. Hash shapes:
//   #/                              → registry
//   #/repo/<keyHex>                 → repo
//   #/repo/<keyHex>/commit/<addr>   → commit
// Anything we don't understand falls back to registry.

function viewFromHash () {
  const m = (location.hash || '#/').match(/^#\/repo\/([0-9a-f]+)(?:\/commit\/(\d+))?\/?$/i)
  if (!m) return { kind: 'registry' }
  if (m[2] != null) return { kind: 'commit', keyHex: m[1], dataAddress: +m[2] }
  return { kind: 'repo', keyHex: m[1] }
}

function hashFromView (v) {
  switch (v.kind) {
    case 'repo':   return `#/repo/${v.keyHex}`
    case 'commit': return `#/repo/${v.keyHex}/commit/${v.dataAddress}`
    default:       return '#/'
  }
}

let view = viewFromHash()
function go (next) {
  view = next
  const target = hashFromView(next)
  if (location.hash !== target) location.hash = target
  fire()
}
window.addEventListener('hashchange', () => {
  const next = viewFromHash()
  if (next.kind === view.kind && next.keyHex === view.keyHex && next.dataAddress === view.dataAddress) return
  view = next
  fire()
})

// ── Helpers ───────────────────────────────────────────────────────────────

const truncKey = k => k.slice(0, 12) + '…'
const fmtDate  = d => d ? d.toLocaleString() : ''

function safeJSON (value) {
  return JSON.stringify(value, (_, v) => {
    if (v instanceof Uint8Array) return `Uint8Array(${v.length})`
    if (v instanceof Date) return v.toISOString()
    return v
  }, 2)
}

// ── Views ─────────────────────────────────────────────────────────────────
//
// Rows are inlined as <div data-key=…> so mount's reconciler can recycle
// them by key. The slot fns each call dep() at the top so reactive re-runs
// fire on registry/repo state changes.
//
// Click handling uses event delegation (see below) rather than onclick=${fn}
// in the h template — the latter is a reactive-cell pattern that treats the
// function as `cell(el)` and assigns its return value to el.onclick, which
// (a) calls the handler on every mount, (b) sets el.onclick to undefined.

function RegistryView () {
  return h`
    <h2>repos <span class="dim">${() => { dep(); return `(${[...registry].length})` }}</span></h2>
    ${() => {
      dep()
      const rows = []
      for (const [keyHex, repo] of registry) {
        const last = repo.lastCommit
        rows.push(h`
          <div class="row" data-key=${keyHex} data-action="open-repo">
            <span class="mono">${truncKey(keyHex)}</span>
            <span class="when">${last ? fmtDate(last.date) : '(no commits)'}</span>
            <span class="msg dim">${last?.message || ''}</span>
          </div>
        `)
      }
      return rows.length ? rows : h`<div class="empty">waiting for repos…</div>`
    }}
  `
}

function RepoView ({ keyHex }) {
  return h`
    <a class="back" data-action="back-registry">← all repos</a>
    <div class="keyfull">${keyHex}</div>
    ${() => {
      dep()
      const repo = registry.get(keyHex)
      if (!repo) return h`<div class="empty">opening…</div>`
      const commits = [...repo.history()]
      if (!commits.length) {
        return h`
          <h2>commits <span class="dim">(0)</span></h2>
          <div class="empty">no commits yet</div>
        `
      }
      return h`
        <h2>commits <span class="dim">(${commits.length})</span></h2>
        ${commits.map(c => h`
          <div class="row" data-key=${c.dataAddress} data-action="open-commit"
               data-keyhex=${keyHex} data-addr=${c.dataAddress}>
            <span class="msg">${c.message || h`<span class="dim">(no message)</span>`}</span>
            <span class="when">${fmtDate(c.date)}</span>
            <span class="mono dim">@${c.dataAddress}</span>
          </div>
        `)}
      `
    }}
  `
}

function CommitView ({ keyHex, dataAddress }) {
  return h`
    <a class="back" data-action="back-repo" data-keyhex=${keyHex}>← commits</a>
    <div class="keyfull">${truncKey(keyHex)} @ ${dataAddress}</div>
    ${() => {
      dep()
      const repo = registry.get(keyHex)
      if (!repo) return h`<div class="empty">opening…</div>`
      if (dataAddress >= repo.byteLength) return h`<div class="empty">loading…</div>`
      let value
      try { value = repo.decode(dataAddress) }
      catch (e) { return h`<pre class="value">decode error: ${e.message}</pre>` }
      return h`<pre class="value">${safeJSON(value)}</pre>`
    }}
  `
}

// ── Mount ─────────────────────────────────────────────────────────────────

const appEl = document.getElementById('app')

mount(h`${() => {
  dep()
  switch (view.kind) {
    case 'registry': return RegistryView()
    case 'repo':     return RepoView({ keyHex: view.keyHex })
    case 'commit':   return CommitView({ keyHex: view.keyHex, dataAddress: view.dataAddress })
    default:         return h`<div class="empty">?</div>`
  }
}}`, appEl, recaller)

// ── Click delegation ──────────────────────────────────────────────────────
//
// Single listener, attached to the app container once. Survives every
// re-render because the listener is on the container, not on rows that
// come and go.

appEl.addEventListener('click', e => {
  const el = e.target.closest('[data-action]')
  if (!el) return
  switch (el.dataset.action) {
    case 'open-repo':     return go({ kind: 'repo', keyHex: el.dataset.key })
    case 'open-commit':   return go({ kind: 'commit', keyHex: el.dataset.keyhex, dataAddress: +el.dataset.addr })
    case 'back-registry': return go({ kind: 'registry' })
    case 'back-repo':     return go({ kind: 'repo', keyHex: el.dataset.keyhex })
  }
})
