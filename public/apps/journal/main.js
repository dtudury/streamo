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
import { defineComponent }              from '../../streamo/StreamoComponent.js'

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
  const entries = myRepo.get('entries') ?? []
  const preview = headline || body.slice(0, 40)
  myRepo.defaultMessage = `entry: "${preview.slice(0, 40)}${preview.length > 40 ? '…' : ''}"`
  myRepo.set({ entries: [...entries, { headline, body, at: new Date() }] })
  headlineEl.value = ''
  bodyEl.value = ''
  headlineEl.focus()
}

// ── mount ────────────────────────────────────────────────────────────
//
// The entries list is a `defineComponent` custom element registered
// inline as a slot tag: `<${defineComponent(name, renderFn)}/>`.
// `defineComponent` returns the tag name string; h takes a slot value
// in tag position; mount sees a string tag and instantiates the
// registered custom element. Idempotent — re-evaluating the template
// re-registers (no-op after first time) and re-embeds the same name.
//
// For this app it's exposition value rather than necessity — a plain
// function-as-slot would do the same job with less machinery (shadow
// DOM, own Recaller). The pattern earns its place when shadow-style
// encapsulation is wanted or when `componentKey(prefix, address)`
// generates a fresh element name per content version (hot-reload).

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
    .new-entry button {
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
    .new-entry button:hover {
      opacity: 0.88;
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
  <${defineComponent('journal-entries', () => h`
    <style>
      :host {
        display: block;
        font-family: system-ui, -apple-system, sans-serif;
        color: #1c1917;
      }
      ol {
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
        padding: 0;
        margin: 0;
      }
      li.entry {
        padding: 1rem 1.1rem;
        border: 1px solid #eee;
        border-radius: 6px;
        background: white;
      }
      li.empty {
        font-size: 0.88rem;
        color: #999;
        font-style: italic;
        padding: 0.75rem 0;
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
      .entry-time {
        font-size: 0.72rem;
        color: #999;
        margin-top: 0.5rem;
        font-variant-numeric: tabular-nums;
      }
    </style>
    <ol>
      ${() => {
        if (!loggedIn()) {
          return h`<li class="empty">login above; entries will appear here.</li>`
        }
        dep?.()
        const entries = myRepo?.get('entries') ?? []
        if (entries.length === 0) {
          return h`<li class="empty">no entries yet — write the first one below.</li>`
        }
        return entries.slice().reverse().map(e => h`
          <li class="entry" data-key=${+e.at}>
            <div class="entry-headline">${e.headline || '(untitled)'}</div>
            <div class="entry-body">${e.body || ''}</div>
            <div class="entry-time">${new Date(e.at).toLocaleString()}</div>
          </li>
        `)
      }}
    </ol>
  `)}/>

  ${when(loggedIn, h`
    <h2>new entry</h2>
    <form class="new-entry" onsubmit=${() => publish}>
      <input name="headline" placeholder="title">
      <textarea name="body" placeholder="what happened?"></textarea>
      <button>publish</button>
    </form>
  `)}

  ${when(loggedIn, h`
    <a class="explorer-link" href=${() => `../explorer/#/repo/${myKey ?? ''}`}>
      see this journal in the explorer →
    </a>
  `)}
`, document.body, recaller)
