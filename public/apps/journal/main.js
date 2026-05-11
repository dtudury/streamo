// journal — minimal viable writing surface on streamo.
//
// The whole page is mounted via a single `h` template at the bottom
// of this file. The HTML at boot is just a loading shim; everything
// you see in the running app comes from this script.
//
// ── indenting convention ─────────────────────────────────────────────
//
// HTML and JS take turns nesting inside each other; the rules below
// keep both readable in the same file:
//
//   1. HTML nesting: 2 spaces per level, starting from the column of
//      the surrounding container's opening tag.
//   2. `${expr}` interpolations sit at the current HTML indent —
//      they read as values, not blocks.
//   3. When `${}` contains a helper call with vnode arguments, the
//      opening paren stays on its line; arguments indent +2 from the
//      line of the paren; closing paren aligns with the call.
//   4. When `${}` contains a multi-line `h\`` template, the opening
//      backtick is on the same line as the call; the template content
//      indents +2 from the backtick's column; the closing backtick
//      aligns with the opening.
//   5. Multi-line arrow functions in `${}` follow the same shape as
//      function calls.
//
// The result reads like nested HTML at the outer level and like
// nested JS at the inner level, without either fighting the other.
//
// ── helpers ──────────────────────────────────────────────────────────
//
// Each helper returns a function that mount treats as a reactive slot.
// The condition function is read inside the slot, so reactive signals
// it touches trigger re-renders. The vnode arguments are kept by
// reference — the helpers swap which one mount renders rather than
// rebuilding templates.

import { h }              from '/streamo/h.js'
import { mount }          from '/streamo/mount.js'
import { Signer }         from '/streamo/Signer.js'
import { Recaller }       from '/streamo/utils/Recaller.js'
import { RepoRegistry }   from '/streamo/RepoRegistry.js'
import { registrySync }   from '/streamo/registrySync.js'
import { bridgeRegistry } from '/streamo/bridgeRegistry.js'
import { bytesToHex }     from '/streamo/utils.js'

// `when(cond, vnode)` — render `vnode` when cond() is truthy, nothing
// otherwise. The vnode is kept by reference; mount tears it down on
// false and re-mounts the same reference on true (with the usual
// watcher cleanup in between).
const when = (cond, vnode) => () => cond() ? vnode : null

// `showIfElse(cond, a, b)` — swap between two pre-built vnode trees
// based on cond(). Both trees are kept around; mount swaps which
// one is rendered when cond flips.
const showIfElse = (cond, a, b) => () => cond() ? a : b

// `each(list, fn)` — map a reactive array into vnodes. `list` is a
// function returning the current array (so reading reactive deps
// inside it triggers re-renders); `fn(item, index)` returns the
// vnode for each item.
const each = (list, fn) => () => list().map(fn)

// ── app-level state ──────────────────────────────────────────────────

const recaller = new Recaller('journal')

// `loggedIn` is a reactive boolean. Reading `loggedIn()` inside a
// slot subscribes to it; `setLoggedIn()` flips it to true and fires
// the slot's watchers.
const loginSig = {}
const loggedIn = () => {
  recaller.reportKeyAccess(loginSig, 'in')
  return loginSig.in === true
}
const setLoggedIn = () => {
  loginSig.in = true
  recaller.reportKeyMutation(loginSig, 'in')
}

// Populated by start() before setLoggedIn fires.
let myRepo, myKey, dep

// ── boot + actions ───────────────────────────────────────────────────

async function start () {
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value.trim()
  if (!username || !password) return
  document.getElementById('username').disabled = true
  document.getElementById('password').disabled = true

  // Identity: deterministic keypair from credentials.
  const signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('journal')
  myKey = bytesToHex(publicKey)

  // Registry + bridge to upstream.
  const registry = new RepoRegistry()
  await registrySync(registry, location.hostname, +location.port || 80)

  // My repo, signed.
  myRepo = await registry.open(myKey)
  myRepo.attachSigner(signer, 'journal')

  // Wire the repo's chunk-level signal onto our app recaller.
  dep = bridgeRegistry(registry, recaller, 'journal').dep

  // Flip the login signal — every slot that reads loggedIn() re-runs.
  setLoggedIn()
}

function publish () {
  const headlineEl = document.getElementById('headline-input')
  const bodyEl     = document.getElementById('body-input')
  const headline   = headlineEl.value.trim()
  const body       = bodyEl.value.trim()
  if (!headline && !body) return
  headlineEl.value = ''
  bodyEl.value     = ''
  const entries = myRepo.get('entries') ?? []
  const preview = headline || body.slice(0, 40)
  myRepo.defaultMessage = `entry: "${preview.slice(0, 40)}${preview.length > 40 ? '…' : ''}"`
  myRepo.set({ entries: [...entries, { headline, body, at: new Date() }] })
  headlineEl.focus()
}

// ── styles (lives in <body> via the mounted template) ───────────────

const css = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  :root { font-family: system-ui, -apple-system, sans-serif; font-size: 15px; color: #1c1917 }
  body { max-width: 40rem; margin: 0 auto; padding: 2.5rem 1.25rem; line-height: 1.55 }
  .brand-lockup { display: inline-flex; align-items: center; gap: .4rem; color: inherit; text-decoration: none; font-weight: 600; font-size: 1.4rem }
  .brand-lockup img { width: 1.6rem; height: 1.6rem }
  .brand-lockup:hover { opacity: 0.85 }
  .page-title { font-weight: 400; color: #888; letter-spacing: .04em; font-size: 0.9rem; margin-left: 0.5rem }
  .page-title::before { content: '· '; opacity: 0.5 }
  h1 { display: flex; align-items: baseline; margin-bottom: 0.4rem }
  .tagline { color: #666; font-size: 0.92rem; margin-bottom: 1.75rem }
  h2 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: #888; margin: 1.75rem 0 0.65rem; font-weight: 500 }
  .login { display: flex; flex-direction: column; gap: 0.5rem }
  .login input { padding: 0.5rem 0.75rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem; font-family: monospace }
  .login input:focus { outline: none; border-color: #1d4ed8 }
  .login input:disabled { background: #f9f9f9 }
  .entries { list-style: none; display: flex; flex-direction: column; gap: 1.25rem }
  .entry { padding: 1rem 1.1rem; border: 1px solid #eee; border-radius: 6px; background: white }
  .entry-headline { font-size: 1.05rem; font-weight: 600; margin-bottom: 0.35rem }
  .entry-body { font-size: 0.95rem; line-height: 1.6; color: #333; white-space: pre-wrap }
  .entry-time { font-size: 0.72rem; color: #999; margin-top: 0.5rem; font-variant-numeric: tabular-nums }
  .empty { font-size: 0.88rem; color: #999; font-style: italic; padding: 0.75rem 0 }
  .new-entry { display: flex; flex-direction: column; gap: 0.5rem }
  .new-entry input, .new-entry textarea { padding: 0.55rem 0.75rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem; font-family: inherit; color: inherit }
  .new-entry textarea { min-height: 7rem; resize: vertical; line-height: 1.5 }
  .new-entry input:focus, .new-entry textarea:focus { outline: none; border-color: #1d4ed8 }
  .new-entry button { padding: 0.55rem 1.1rem; background: #1d4ed8; color: white; border: none; border-radius: 6px; font-size: 0.95rem; cursor: pointer; font-family: inherit; align-self: flex-start }
  .new-entry button:hover { opacity: 0.88 }
  .explorer-link { font-size: 0.85rem; color: #1d4ed8; text-decoration: none; border-bottom: 1px dotted; margin-top: 1.5rem; display: inline-block }
  .explorer-link:hover { border-bottom-style: solid }
`

// ── pre-built vnode fragments ────────────────────────────────────────
//
// These are h-templates evaluated once at module load. Helpers like
// `when(...)` pass them around by reference; mount swaps which one
// is rendered as conditions flip, but the vnode objects themselves
// aren't rebuilt.

const brandHeader = h`
  <h1>
    <a class="brand-lockup" href="/" title="streamo home">
      <img src="/streamo.svg" alt="">streamo
    </a>
    <span class="page-title">journal</span>
  </h1>
`

const loginForm = h`
  <h2>identity</h2>
  <div class="login">
    <input id="username" placeholder="username" autocomplete="username">
    <input id="password" type="password" placeholder="password" autocomplete="current-password">
  </div>
`

const newEntryForm = h`
  <h2>new entry</h2>
  <div class="new-entry">
    <input id="headline-input" placeholder="title">
    <textarea id="body-input" placeholder="what happened?"></textarea>
    <button data-action="publish">publish</button>
  </div>
`

// The explorer link's href depends on myKey, which isn't known
// until after login. The cell inside `href=${() => ...}` runs at
// mount time (which is after the login flip), so myKey is set when
// it evaluates.
const explorerLink = h`
  <a class="explorer-link" href=${() => `/apps/explorer/#/repo/${myKey ?? ''}`}>
    see this journal in the explorer →
  </a>
`

const emptyEntry = h`<li class="empty">login above; entries will appear here.</li>`
const noEntries  = h`<li class="empty">no entries yet — write the first one below.</li>`

// Entries list — reactive on the bridge signal (chunks arriving)
// and on the login signal (empty-state copy differs). Newest first.
const entriesList = () => {
  dep?.()
  if (!loggedIn()) return emptyEntry
  const entries = myRepo?.get('entries') ?? []
  if (entries.length === 0) return noEntries
  return entries.slice().reverse().map(e => h`
    <li class="entry" data-key=${+e.at}>
      <div class="entry-headline">${e.headline || '(untitled)'}</div>
      <div class="entry-body">${e.body || ''}</div>
      <div class="entry-time">${new Date(e.at).toLocaleString()}</div>
    </li>
  `)
}

// ── mount ────────────────────────────────────────────────────────────
//
// One mount call brings the whole app to life. The <style> ships
// inside the template so it travels with the markup; the loading
// content in body is replaced wholesale at first render.

mount(h`
  <style>${css}</style>
  ${brandHeader}
  <p class="tagline">A minimal journaling surface. Each entry is a signed commit on your own streamo Repo — yours forever, append-only, replayable in the explorer.</p>
  ${loginForm}
  <h2>entries</h2>
  <ol class="entries">${entriesList}</ol>
  ${when(loggedIn, newEntryForm)}
  ${when(loggedIn, explorerLink)}
`, document.body, recaller)

// ── event delegation ─────────────────────────────────────────────────
//
// One listener at the root handles every interactive moment in the
// app — Enter-to-advance, Cmd/Ctrl-Enter to publish, clicks on
// data-action elements. Keeping handlers OFF individual elements
// means the helpers above stay free to swap their vnodes in and out
// without re-binding.

document.body.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return
  const id = e.target?.id
  const meta = e.metaKey || e.ctrlKey
  if (id === 'username') { e.preventDefault(); document.getElementById('password').focus() }
  else if (id === 'password') { e.preventDefault(); start() }
  else if (id === 'headline-input' && !meta) { e.preventDefault(); document.getElementById('body-input').focus() }
  else if ((id === 'headline-input' || id === 'body-input') && meta) { e.preventDefault(); publish() }
})

document.body.addEventListener('click', e => {
  if (e.target.closest('[data-action="publish"]')) publish()
})
