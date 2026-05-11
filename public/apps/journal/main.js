// journal — minimal viable writing surface on streamo.
//
// The whole page lives in one `mount(h\`...\`, document.body, recaller)`
// call near the bottom of this file. See `dear-future-claudes.md` at
// the project root for the style preferences this app demonstrates.

import { h }                            from '../../streamo/h.js'
import { mount }                        from '../../streamo/mount.js'
import { Signer }                       from '../../streamo/Signer.js'
import { Recaller }                     from '../../streamo/utils/Recaller.js'
import { RepoRegistry }                 from '../../streamo/RepoRegistry.js'
import { registrySync }                 from '../../streamo/registrySync.js'
import { bridgeRegistry }               from '../../streamo/bridgeRegistry.js'
import { bytesToHex }                   from '../../streamo/utils.js'

// `when(cond, vnode)` — render `vnode` when cond() is truthy, nothing
// otherwise. The vnode is kept by reference; mount tears it down on
// false and re-mounts the same reference on true.
const when = (cond, vnode) => () => cond() ? vnode : null

// ── app-level state ──────────────────────────────────────────────────

const recaller = new Recaller('journal')

// Reactive login signal. Reading `loggedIn()` inside a slot subscribes
// to it; `setLoggedIn()` flips it true and fires the slot's watchers.
const loginSig = {}
const loggedIn = () => {
  recaller.reportKeyAccess(loginSig, 'in')
  return loginSig.in === true
}
const setLoggedIn = () => {
  loginSig.in = true
  recaller.reportKeyMutation(loginSig, 'in')
}

// Populated by `login` before setLoggedIn fires.
let myRepo, myKey, dep

// Reactive edit signal. `editing()` returns either `null` (compose
// mode) or `{ id, headline, body }` describing the entry currently
// being revised. The form's value=${} cells re-run when this fires,
// pre-populating the inputs; the form button text and the "cancel"
// button also key off the same signal.
const editSig = {}
const editing = () => {
  recaller.reportKeyAccess(editSig, 'data')
  return editSig.data ?? null
}
function startEdit (entry) {
  editSig.data = { id: entry.id, headline: entry.headline, body: entry.body }
  recaller.reportKeyMutation(editSig, 'data')
  // Focus the headline once the form's cells have re-run and the
  // input's value has been updated. rAF gets us past the recaller's
  // microtask flush.
  requestAnimationFrame(() => {
    const el = document.querySelector('input[name="headline"]')
    el?.focus()
    el?.select()
  })
}
function cancelEdit () {
  editSig.data = null
  recaller.reportKeyMutation(editSig, 'data')
}

// Group entries by `id` so multiple versions of the same entry collapse
// to one displayed item (the latest version wins). Entries written
// before edit was a feature don't have an `id` — fall back to a
// per-timestamp synthetic id so each becomes its own group, the same
// as if you'd written it as a brand-new entry today. Newest groups
// (by ORIGINAL creation time) appear first.
function groupEntries (entries) {
  const byId = new Map()
  for (const e of entries) {
    const id = e.id ?? `legacy-${+e.at}`
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(e)
  }
  return [...byId.values()].map(versions => {
    versions.sort((a, b) => +a.at - +b.at)
    return {
      id: versions[0].id ?? `legacy-${+versions[0].at}`,
      original: versions[0],
      latest: versions[versions.length - 1],
      versions
    }
  }).sort((a, b) => +b.original.at - +a.original.at)
}

// ── handlers ─────────────────────────────────────────────────────────

async function login (e) {
  e.preventDefault()
  const f = e.target
  const usernameEl = f.elements.username
  const passwordEl = f.elements.password
  const username = usernameEl.value.trim()
  const password = passwordEl.value.trim()
  if (!username) { usernameEl.focus(); return }
  if (!password) { passwordEl.focus(); return }
  usernameEl.disabled = passwordEl.disabled = true

  const signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('journal')
  myKey = bytesToHex(publicKey)

  const registry = new RepoRegistry()
  await registrySync(registry, location.hostname, +location.port || 80)

  myRepo = await registry.open(myKey)
  myRepo.attachSigner(signer, 'journal')

  dep = bridgeRegistry(registry, recaller, 'journal').dep

  setLoggedIn()
}

function publish (e) {
  e.preventDefault()
  const f = e.target
  const headlineEl = f.elements.headline
  const bodyEl     = f.elements.body
  const headline   = headlineEl.value.trim()
  const body       = bodyEl.value.trim()
  if (!headline && !body) return
  // If we're in edit mode, reuse the existing id — the new entry
  // is another VERSION of the same one, not a separate post. Streamo
  // keeps both versions in the chunk graph; the view (groupEntries)
  // collapses them to the latest. If we're composing fresh, mint a
  // new id.
  const editingEntry = editing()
  const id = editingEntry?.id ?? crypto.randomUUID()
  const entries = myRepo.get('entries') ?? []
  const preview = headline || body.slice(0, 40)
  const verb = editingEntry ? 'edit' : 'entry'
  myRepo.defaultMessage = `${verb}: "${preview.slice(0, 40)}${preview.length > 40 ? '…' : ''}"`
  myRepo.set({ entries: [...entries, { id, headline, body, at: new Date() }] })
  cancelEdit()         // clears form via the editSig→cell→el.value path
  headlineEl.focus()
}

// ── mount ────────────────────────────────────────────────────────────
//
// Note: the entries list used to be a `defineComponent` custom
// element with its own Recaller and shadow DOM. We pulled it back to
// a plain function-as-slot because cross-recaller dep tracking
// doesn't work transparently: the slot watcher inside the component
// was registered with the component's Recaller, but the signals it
// read (loggedIn, the bridge dep) lived on the journal Recaller.
// When those fired, the component's watcher never heard about it.
// The function-as-slot pattern puts everything on one Recaller, no
// bridge needed. The inline `<${defineComponent(...)}/>` pattern is
// still real and useful — just for cases where the component is
// genuinely self-contained, not for cases that need to read
// app-level reactive state.

mount(h`
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    :root {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 15px;
      color: #1c1917;
    }
    body {
      max-width: 40rem;
      margin: 0 auto;
      padding: 2.5rem 1.25rem;
      line-height: 1.55;
    }

    .brand-lockup {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      color: inherit;
      text-decoration: none;
      font-weight: 600;
      font-size: 1.4rem;
    }
    .brand-lockup img {
      width: 1.6rem;
      height: 1.6rem;
    }
    .brand-lockup:hover {
      opacity: 0.85;
    }
    .page-title {
      font-weight: 400;
      color: #888;
      letter-spacing: .04em;
      font-size: 0.9rem;
      margin-left: 0.5rem;
    }
    .page-title::before {
      content: '· ';
      opacity: 0.5;
    }
    h1 {
      display: flex;
      align-items: baseline;
      margin-bottom: 0.4rem;
    }

    .tagline {
      color: #666;
      font-size: 0.92rem;
      margin-bottom: 1.75rem;
    }

    h2 {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #888;
      margin: 1.75rem 0 0.65rem;
      font-weight: 500;
    }

    .login {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .login input {
      padding: 0.5rem 0.75rem;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 1rem;
      font-family: monospace;
    }
    .login input:focus {
      outline: none;
      border-color: #1d4ed8;
    }
    .login input:disabled {
      background: #f9f9f9;
    }
    .login button {
      padding: 0.55rem 1.1rem;
      background: #1d4ed8;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 0.95rem;
      cursor: pointer;
      font-family: inherit;
      align-self: flex-start;
    }
    .login button:hover {
      opacity: 0.88;
    }

    .new-entry {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .new-entry input,
    .new-entry textarea {
      padding: 0.55rem 0.75rem;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 1rem;
      font-family: inherit;
      color: inherit;
    }
    .new-entry textarea {
      min-height: 7rem;
      resize: vertical;
      line-height: 1.5;
    }
    .new-entry input:focus,
    .new-entry textarea:focus {
      outline: none;
      border-color: #1d4ed8;
    }
    .entries {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      padding: 0;
      margin: 0;
    }
    .entry {
      padding: 1rem 1.1rem;
      border: 1px solid #eee;
      border-radius: 6px;
      background: white;
    }
    .entry-headline {
      font-size: 1.05rem;
      font-weight: 600;
      margin-bottom: 0.35rem;
    }
    .entry-body {
      font-size: 0.95rem;
      line-height: 1.6;
      color: #333;
      white-space: pre-wrap;
    }
    .entry-meta {
      display: flex;
      align-items: baseline;
      gap: 0.6rem;
      margin-top: 0.5rem;
    }
    .entry-time {
      font-size: 0.72rem;
      color: #999;
      font-variant-numeric: tabular-nums;
    }
    .entry-edited {
      font-size: 0.65rem;
      color: #999;
      font-style: italic;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .entry-edit-btn {
      margin-left: auto;
      background: none;
      border: none;
      color: #1d4ed8;
      font-size: 0.78rem;
      cursor: pointer;
      padding: 0;
      text-decoration: underline dotted;
      font-family: inherit;
    }
    .entry-edit-btn:hover {
      text-decoration-style: solid;
    }
    .empty {
      font-size: 0.88rem;
      color: #999;
      font-style: italic;
      padding: 0.75rem 0;
    }

    .new-entry-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .new-entry button {
      padding: 0.55rem 1.1rem;
      background: #1d4ed8;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 0.95rem;
      cursor: pointer;
      font-family: inherit;
    }
    .new-entry button:hover {
      opacity: 0.88;
    }
    .new-entry .cancel-btn {
      background: none;
      color: #666;
      border: 1px solid #ddd;
      padding: 0.5rem 0.9rem;
    }
    .new-entry .cancel-btn:hover {
      color: #1c1917;
      border-color: #1c1917;
      opacity: 1;
    }

    .explorer-link {
      font-size: 0.85rem;
      color: #1d4ed8;
      text-decoration: none;
      border-bottom: 1px dotted;
      margin-top: 1.5rem;
      display: inline-block;
    }
    .explorer-link:hover {
      border-bottom-style: solid;
    }
  </style>

  <h1>
    <a class="brand-lockup" href="../../" title="streamo home">
      <img src="../../streamo.svg" alt="">streamo
    </a>
    <span class="page-title">journal</span>
  </h1>
  <p class="tagline">A minimal journaling surface. Each entry is a signed commit on your own streamo Repo — yours forever, append-only, replayable in the explorer.</p>

  <h2>identity</h2>
  <form class="login" onsubmit=${() => login}>
    <input name="username" placeholder="username" autocomplete="username">
    <input name="password" type="password" placeholder="password" autocomplete="current-password">
    <button>sign in</button>
  </form>

  <h2>entries</h2>
  <ol class="entries">
    ${() => {
      if (!loggedIn()) {
        return h`<li class="empty">login above; entries will appear here.</li>`
      }
      dep?.()
      const entries = myRepo?.get('entries') ?? []
      if (entries.length === 0) {
        return h`<li class="empty">no entries yet — write the first one below.</li>`
      }
      // Group versions by id; latest version per id wins the display.
      // The full history is still in the repo and visible in the
      // explorer — this view is the "present" lens.
      return groupEntries(entries).map(g => h`
        <li class="entry" data-key=${g.id}>
          <div class="entry-headline">${g.latest.headline || '(untitled)'}</div>
          <div class="entry-body">${g.latest.body || ''}</div>
          <div class="entry-meta">
            <span class="entry-time">${new Date(g.latest.at).toLocaleString()}</span>
            ${g.versions.length > 1
              ? h`<span class="entry-edited">edited · ${g.versions.length} versions</span>`
              : null}
            <button class="entry-edit-btn" onclick=${() => () => startEdit(g.latest)}>edit</button>
          </div>
        </li>
      `)
    }}
  </ol>

  ${when(loggedIn, h`
    <h2>${() => editing() ? 'edit entry' : 'new entry'}</h2>
    <form class="new-entry" onsubmit=${() => publish}>
      <input name="headline" placeholder="title" value=${() => editing()?.headline ?? ''}>
      <textarea name="body" placeholder="what happened?" value=${() => editing()?.body ?? ''}></textarea>
      <div class="new-entry-actions">
        <button>${() => editing() ? 'save changes' : 'publish'}</button>
        ${when(editing, h`<button type="button" class="cancel-btn" onclick=${() => cancelEdit}>cancel</button>`)}
      </div>
    </form>
  `)}

  ${when(loggedIn, h`
    <a class="explorer-link" href=${() => `../explorer/#/repo/${myKey ?? ''}`}>
      see this journal in the explorer →
    </a>
  `)}
`, document.body, recaller)
