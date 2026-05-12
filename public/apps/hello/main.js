// hello — the smallest possible streamo app.
//
// Five conceptual moves, all running inside one
// `mount(h\`...\`, document.body, recaller)` call at the bottom of this
// file. Style preferences for streamo apps live in
// `dear-future-claudes.md` at the project root; this app and the
// journal app are the worked examples of that style.

import { h }              from '../../streamo/h.js'
import { mount }          from '../../streamo/mount.js'
import { Signer }         from '../../streamo/Signer.js'
import { Recaller }       from '../../streamo/utils/Recaller.js'
import { RepoRegistry }   from '../../streamo/RepoRegistry.js'
import { registrySync }   from '../../streamo/registrySync.js'
import { bytesToHex }     from '../../streamo/utils.js'

// `when(cond, vnode)` — render `vnode` when cond() is truthy.
const when = (cond, vnode) => () => cond() ? vnode : null

// ── state ────────────────────────────────────────────────────────────

const recaller = new Recaller('hello')

const loginSig = {}
const loggedIn = () => {
  recaller.reportKeyAccess(loginSig, 'in')
  return loginSig.in === true
}
const setLoggedIn = () => {
  loginSig.in = true
  recaller.reportKeyMutation(loginSig, 'in')
}

let myRepo, myKey

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

  // Move 1: identity. Deterministic keypair from (username, password)
  // via PBKDF2. Same credentials → same key, on any device.
  const signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('hello')
  myKey = bytesToHex(publicKey)

  // Move 2: registry + sync. WebSocket bridge to upstream. The registry
  // shares our Recaller, so reading myRepo.get(...) in a slot below
  // auto-subscribes that slot to chunk arrivals.
  const registry = new RepoRegistry(undefined, { recaller, name: 'hello' })
  await registrySync(registry, location.hostname, +location.port || 80)

  // Move 3: my repo, with signer attached. Every set() becomes a
  // signed commit automatically.
  myRepo = await registry.open(myKey)
  myRepo.attachSigner(signer, 'hello')

  // Flip the login signal — every slot that reads loggedIn() re-runs.
  setLoggedIn()
}

// Move 5: write. repo.set replaces the whole value; streamo is
// content-addressed, so unchanged chunks are reused. The attached
// signer kicks in automatically.
function add (e) {
  e.preventDefault()
  const f = e.target
  const inputEl = f.elements.text
  const text = inputEl.value.trim()
  if (!text) return
  const entries = myRepo.get('entries') ?? []
  myRepo.defaultMessage = `entry: "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`
  myRepo.set({ entries: [...entries, { text, at: new Date() }] })
  inputEl.value = ''
  inputEl.focus()
}

// ── mount ────────────────────────────────────────────────────────────

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
      max-width: 36rem;
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
      margin-bottom: 0.4rem;
    }
    .tagline code {
      font-family: monospace;
      background: #f5f5f5;
      padding: 0 0.3rem;
      border-radius: 3px;
      font-size: 0.85em;
    }
    .note {
      color: #888;
      font-size: 0.78rem;
      margin-bottom: 2rem;
    }
    .note a {
      color: #1d4ed8;
      text-decoration: underline dotted;
    }

    h2 {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #888;
      margin: 1.75rem 0 0.65rem;
      font-weight: 500;
    }

    .login,
    .add {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .login input,
    .add input {
      padding: 0.5rem 0.75rem;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 1rem;
      font-family: monospace;
    }
    .add input {
      font-family: inherit;
    }
    .login input:focus,
    .add input:focus {
      outline: none;
      border-color: #1d4ed8;
    }
    .login input:disabled,
    .add input:disabled {
      background: #f9f9f9;
    }
    .login button,
    .add button {
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
    .login button:hover,
    .add button:hover {
      opacity: 0.88;
    }

    .key {
      font-family: monospace;
      font-size: 0.72rem;
      color: #4d7c0f;
      background: rgba(132, 204, 22, 0.08);
      border: 1px solid rgba(132, 204, 22, 0.18);
      padding: 0.45rem 0.65rem;
      border-radius: 6px;
      word-break: break-all;
      margin-top: 0.5rem;
    }

    .entries {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      padding: 0;
      margin: 0;
    }
    .entry {
      padding: 0.6rem 0.85rem;
      border: 1px solid #eee;
      border-radius: 6px;
      background: white;
    }
    .entry-text {
      font-size: 0.95rem;
    }
    .entry-time {
      font-size: 0.7rem;
      color: #999;
      margin-top: 0.2rem;
      font-variant-numeric: tabular-nums;
    }
    .empty {
      font-size: 0.88rem;
      color: #999;
      font-style: italic;
      padding: 0.75rem 0;
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
    <span class="page-title">hello</span>
  </h1>
  <p class="tagline">The smallest possible streamo app — five moves in <code>main.js</code>, top-to-bottom. Enter credentials, write entries, watch them appear. Copy-paste and adapt.</p>
  <p class="note">Your credentials derive a deterministic keypair via PBKDF2; same credentials always produce the same identity. Made-up credentials get a made-up identity that's still yours, signed and content-addressed. Open <a href="./main.js">main.js</a> in another tab to read along.</p>

  <h2>identity</h2>
  <form class="login" onsubmit=${() => login}>
    <input name="username" placeholder="username" autocomplete="username">
    <input name="password" type="password" placeholder="password" autocomplete="current-password">
    <button>sign in</button>
    ${when(loggedIn, h`
      <div class="key">${() => myKey ?? ''}</div>
    `)}
  </form>

  <h2>entries</h2>
  <ol class="entries">
    ${() => {
      if (!loggedIn()) {
        return h`<li class="empty">login above; entries will appear here.</li>`
      }
      const entries = myRepo?.get('entries') ?? []
      if (entries.length === 0) {
        return h`<li class="empty">no entries yet — add one below.</li>`
      }
      return entries.slice().reverse().map(e => h`
        <li class="entry" data-key=${+e.at}>
          <div class="entry-text">${e.text}</div>
          <div class="entry-time">${new Date(e.at).toLocaleString()}</div>
        </li>
      `)
    }}
  </ol>

  ${when(loggedIn, h`
    <h2>add</h2>
    <form class="add" onsubmit=${() => add}>
      <input name="text" placeholder="what's on your mind?">
      <button>add</button>
    </form>
  `)}

  ${when(loggedIn, h`
    <a class="explorer-link" href=${() => `../explorer/#/repo/${myKey ?? ''}`}>
      see this repo in the explorer →
    </a>
  `)}
`, document.body, recaller)
