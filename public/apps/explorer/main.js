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

const recaller = new Recaller('explorer')
const signal = {}
const dep  = () => recaller.reportKeyAccess(signal, 'data')
const fire = () => recaller.reportKeyMutation(signal, 'data')

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

let view = { kind: 'registry' }
function go (next) { view = next; fire() }

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
// Rows are inlined as <div data-key=…> rather than function components so
// mount's reconciler can recycle them by key on incremental updates (a new
// commit landing or a new repo opening shouldn't tear down every existing
// row). The slot fns each call dep() at the top so reactive re-runs fire.

function RegistryView () {
  return h`
    <h2>repos <span class="dim">${() => { dep(); return `(${[...registry].length})` }}</span></h2>
    ${() => {
      dep()
      const rows = []
      for (const [keyHex, repo] of registry) {
        const last = repo.lastCommit
        rows.push(h`
          <div class="row" data-key=${keyHex} onclick=${() => go({ kind: 'repo', keyHex })}>
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
    <a class="back" onclick=${() => go({ kind: 'registry' })}>← all repos</a>
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
          <div class="row" data-key=${c.dataAddress}
               onclick=${() => go({ kind: 'commit', keyHex, dataAddress: c.dataAddress })}>
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
    <a class="back" onclick=${() => go({ kind: 'repo', keyHex })}>← commits</a>
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

mount(h`${() => {
  dep()
  switch (view.kind) {
    case 'registry': return RegistryView()
    case 'repo':     return RepoView({ keyHex: view.keyHex })
    case 'commit':   return CommitView({ keyHex: view.keyHex, dataAddress: view.dataAddress })
    default:         return h`<div class="empty">?</div>`
  }
}}`, document.getElementById('app'), recaller)
