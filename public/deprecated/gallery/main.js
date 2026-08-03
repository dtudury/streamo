/**
 * @file gallery — Stage 1: identity session.
 *
 * The frame in which a streamo identity is loaded once per session and
 * Records can be opened, edited, signed, and managed. Stage 1 builds
 * only the identity-session layer: master salt + username → in-memory
 * `Signer` → derived pubkey shown with a visual swatch.
 *
 * Layered scope (future stages):
 * - Stage 1 (this): login + show derived identity pubkey + visual hash
 * - Stage 2: subscribe to one image, render read-only
 * - Stage 3: records-index Record + list view + create
 * - Stage 4: edit + save (record.update())
 * - Stage 5+: multi-pane, suggest(), nested galleries
 *
 * The Signer is held in JS memory only. Reload clears it. Per
 * `feedback_redact_dont_exclude_secrets` and the deck's identity model:
 * the master salt never leaves this page.
 */
import { h, handle } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { Signer } from '../../streamo/Signer.js'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { liveObject } from '../../streamo/LiveSource.js'
import { bytesToHex } from '../../streamo/utils.js'

const recaller = new Recaller('gallery')
const ui = liveObject(
  { phase: 'login', username: null, pubkey: null, deriving: false, error: null },
  { recaller }
)

// In-memory only. Never written to disk, localStorage, or sent over the wire.
let signer = null

async function login (e) {
  e.preventDefault()
  const f = e.target
  const username = f.elements.username.value.trim()
  const password = f.elements.password.value
  if (!username || !password) return
  ui.set({ deriving: true, error: null })
  try {
    signer = new Signer(username, password, 100000)
    const { publicKey } = await signer.keysFor('gallery')
    const pubkey = bytesToHex(publicKey)
    ui.set({ phase: 'identity', username, pubkey, deriving: false })
  } catch (err) {
    ui.set({ deriving: false, error: err.message ?? String(err) })
  }
}

function logout () {
  signer = null
  ui.set({ phase: 'login', username: null, pubkey: null, error: null })
}

// Visual hash: 4 colour swatches drawn from 24 bytes of the pubkey, skipping
// the 02/03 compression-prefix. Same input → same swatch row; a typo gives a
// visibly different row before the user has to read 66 hex characters.
function swatchColours (pubkey) {
  const body = pubkey.slice(2)
  return [0, 1, 2, 3].map(i => `#${body.slice(i * 6, i * 6 + 6)}`)
}

function loginView () {
  const deriving = ui.get('deriving')
  const error = ui.get('error')
  return h`<main class="login">
    <h1>gallery</h1>
    <p class="hint">your streamo identity, in browser. master salt never leaves this page.</p>
    <form onsubmit=${handle(login)}>
      <label>
        <span>username</span>
        <input name="username" autofocus required autocomplete="username" disabled=${deriving}>
      </label>
      <label>
        <span>master salt</span>
        <input name="password" type="password" required autocomplete="current-password" disabled=${deriving}>
      </label>
      <button type="submit" disabled=${deriving}>${deriving ? 'deriving…' : 'enter'}</button>
      ${error ? h`<p class="error">${error}</p>` : ''}
    </form>
    <p class="footer">iterations: 100,000 · derivation takes a moment</p>
  </main>`
}

function identityView () {
  const username = ui.get('username')
  const pubkey = ui.get('pubkey')
  const colours = swatchColours(pubkey)
  return h`<main class="identity">
    <header>
      <h1>${username}</h1>
      <button class="logout" onclick=${handle(logout)}>log out</button>
    </header>
    <div class="swatches" title="visual identity — same input always produces the same swatch row">
      ${colours.map(c => h`<span class="swatch" style="background:${c}"></span>`)}
    </div>
    <div class="pubkey">
      <span class="label">pubkey (stream: gallery)</span>
      <code>${pubkey}</code>
    </div>
    <p class="hint">in-memory only — reload to clear. stages 2+ will add records.</p>
  </main>`
}

function view () {
  return ui.get('phase') === 'login' ? loginView() : identityView()
}

mount(view, document.body, recaller)
