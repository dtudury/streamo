/**
 * @file chat-edit — phase-1 of the chat-as-editor architecture.
 *
 * Future-cold-iris — letter at the top, code below.
 *
 * ## Where this came from
 *
 * 2026-06-02 late afternoon — David's reframe: *"the editor IS chat."*
 * He talks to me; I produce prose; the rendered page IS my prose. He
 * accepts/redirects via more chat. His sentiment is preserved as the
 * chain of what he asked for; viewers see what got written; the chain
 * captures both. Time-travel through history falls out for free.
 *
 * His architecture sketch (2026-06-02 verbatim):
 *
 *   1. yeah, start with one record per page.
 *   2. we don't need chat in place yet. that can be next too
 *   3. the page I'm on follows my chat and edit Record (which won't exist
 *      yet because I'm making them here) and your chat and edit Record...
 *      so I guess your edits need to mention which of my Records they're
 *      for... and has a way to "accept" which is probably just "set field
 *      x to value y"
 *   4. I could redirect. that works too. you'll need to copy a
 *      FolderRecord structure into my Record when you log me in
 *
 * ## What this v1 does
 *
 * - Loads at /streams/<my-pubkey>/chat-edit/index.html (my Record is a
 *   FolderRecord; the app code lives in its files map)
 * - URL hash carries David's pubkey: #<his-pubkey> — if not present, we
 *   prompt for login + derive it via Signer
 * - Subscribes to BOTH Records: mine (for the proposed-edits) + his
 *   (for the current values + the "accept" target)
 * - Renders his current field value (just `bio` for v1)
 * - Renders my proposed edit for that field (read from
 *   value.files['proposed-edits.json'] in MY Record)
 * - "Accept" button → writes the proposed value to HIS Record's `bio`
 *   field, with commit message `accept iris edit: bio`
 *
 * ## What this v1 does NOT do
 *
 * - No chat input in the page (redirection happens via this Claude Code
 *   conversation for now; phase 2 is in-page chat)
 * - No multi-field — just `bio` to demonstrate the architecture
 * - No FolderRecord-template-copy on login (his Record stays empty until
 *   he accepts something; phase 2 could seed from a template)
 * - No time-travel UI (phase 3 walks the chain as conversation transcript)
 *
 * ## See this file's chain
 *
 *   bash scripts/file-history.sh public/apps/chat-edit/main.js
 *
 * — past-iris, 2026-06-02 late evening, after David's "chat IS the editor"
 *   reframe dissolved the markdown-editor-with-suggestions model.
 */

const LIB = 'https://streamo.dev/streams/028d69692fccb952e4e3f5d6e42123602daafc402d8ea34483383415a7e178f1c9'
const { h, handle }            = await import(`${LIB}/h.js`)
const { mount }                = await import(`${LIB}/mount.js`)
const { Recaller }             = await import(`${LIB}/utils/Recaller.js`)
const { StreamoRecord }        = await import(`${LIB}/StreamoRecord.js`)
const { WritableStreamoRecord }= await import(`${LIB}/WritableStreamoRecord.js`)
const { StreamoRecordRegistry }= await import(`${LIB}/StreamoRecordRegistry.js`)
const { registrySync }         = await import(`${LIB}/registrySync.js`)
const { liveObject }           = await import(`${LIB}/LiveSource.js`)
const { Signer }               = await import(`${LIB}/Signer.js`)
const { bytesToHex }           = await import(`${LIB}/utils.js`)

// ── pubkey-from-URL ───────────────────────────────────────────────────────
// /streams/<my-pubkey>/chat-edit/index.html#<his-pubkey>
const m = location.pathname.match(/^\/streams\/([0-9a-f]{66})\b/i)
const myPubkey = m && m[1]
const hisFromHash = location.hash.startsWith('#') && /^[0-9a-f]{66}$/i.test(location.hash.slice(1))
  ? location.hash.slice(1) : null

// ── state ─────────────────────────────────────────────────────────────────
const recaller = new Recaller('chat-edit')

const ui = liveObject({
  phase: hisFromHash ? 'connecting' : 'login',
  loginError: null,
  deriving: false,
  username: null,
  hisPubkey: hisFromHash,
  status: 'idle',
  accepting: false,
  acceptError: null
}, { recaller })

let hisSigner = null      // only set after login (so we can author to his Record)
let myRepo = null         // mine (slim — we only read my proposed edits)
let hisRepo = null        // his (Writable after login — we sign acceptances)
let session = null

// `signerPresent` is a live cell so the header re-renders when login/logout
// flips. The `hisSigner` JS var alone doesn't trigger recaller, so we mirror
// its presence into ui.
function refreshSignerCell () { ui.set('signerPresent', !!hisSigner) }

// The streamName David's identity uses for THIS page's Record. v1 picks
// one arbitrary name; phase 2 could let the user pick per page.
const HIS_STREAM_NAME = 'chat-edit-page-v1'

// ── login + derive his pubkey ─────────────────────────────────────────────
async function login (e) {
  e.preventDefault()
  const f = e.target
  const username = f.elements.username.value.trim()
  const password = f.elements.password.value
  if (!username || !password) return
  ui.set({ deriving: true, loginError: null, status: 'deriving identity…' })
  try {
    const signer = new Signer(username, password, 100000)
    const { publicKey } = await signer.keysFor(HIS_STREAM_NAME)
    const derivedHisPubkey = bytesToHex(publicKey)
    if (hisFromHash && hisFromHash !== derivedHisPubkey) {
      ui.set({
        deriving: false,
        loginError: `credentials derive ${derivedHisPubkey.slice(0, 12)}… but URL hash is ${hisFromHash.slice(0, 12)}…`,
        status: 'idle'
      })
      return
    }
    hisSigner = signer
    ui.set({ deriving: false, username, hisPubkey: derivedHisPubkey, phase: 'connecting', status: 'connecting…' })
    refreshSignerCell()
    location.hash = derivedHisPubkey
    await connect(derivedHisPubkey, signer)
  } catch (err) {
    ui.set({ deriving: false, loginError: err.message ?? String(err), status: 'idle' })
  }
}

// ── subscribe to both Records ─────────────────────────────────────────────
async function connect (hisPubkey, signer) {
  const registry = new StreamoRecordRegistry({
    recaller,
    factory: key => {
      if (signer && key === hisPubkey) return new WritableStreamoRecord({ recaller })
      return new StreamoRecord({ recaller })
    }
  })
  session = await registrySync(registry, location.host, {
    onConnectionChange: c => ui.set('status', c ? 'connected' : 'reconnecting…')
  })
  myRepo  = await session.subscribe(myPubkey)
  hisRepo = await session.subscribe(hisPubkey)
  if (signer) {
    hisRepo.attachSigner(signer, HIS_STREAM_NAME)
    hisRepo.defaultMessage = `${ui.get('username')}'s page`
  }
  ui.set({ phase: 'editor', status: 'connected' })
  window.__chatEdit = { myRepo, hisRepo, ui }
}

// ── readers ───────────────────────────────────────────────────────────────
function currentBio () {
  const v = hisRepo?.get()
  return v?.bio ?? null
}

function proposedEdits () {
  if (!myRepo) return []
  const v = myRepo.get()
  const raw = v?.files?.['proposed-edits.json']
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed.suggestions) ? parsed.suggestions : []
  } catch {
    return []
  }
}

// ── accept ────────────────────────────────────────────────────────────────
async function acceptSuggestion (s) {
  if (!hisRepo || !hisSigner) {
    ui.set('acceptError', 'must be logged in to accept (need signer)')
    return
  }
  if (s.field !== 'bio') {
    ui.set('acceptError', `v1 only supports bio field; got ${s.field}`)
    return
  }
  ui.set({ accepting: true, acceptError: null, status: 'accepting…' })
  try {
    await hisRepo.update(
      c => ({ ...(c ?? {}), [s.field]: s.value, updatedAt: new Date() }),
      { message: `accept iris edit: ${s.field}${s.reason ? ` (${s.reason})` : ''}` }
    )
    ui.set('status', 'accepted')
  } catch (err) {
    ui.set('acceptError', err.message ?? String(err))
  } finally {
    ui.set('accepting', false)
  }
}

// Logout: clear signer state + hash; hashchange listener handles the rest.
function logout () {
  hisSigner = null
  hisRepo = null
  refreshSignerCell()
  // Trigger hashchange by clearing the fragment; the listener resets ui.
  history.pushState(null, '', location.pathname + location.search)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

// ── views ─────────────────────────────────────────────────────────────────
function whoIndicator () {
  return () => {
    const phase = ui.get('phase')
    const signed = ui.get('signerPresent')
    const username = ui.get('username')
    if (phase === 'login' || (!ui.get('hisPubkey'))) {
      return h`<span class="who none" data-key="who-none"><span class="dot"></span>not logged in</span>`
    }
    if (signed) {
      return h`<span data-key="who-author">
        <span class="who author"><span class="dot"></span>${username ? `signed in as ${username}` : 'signed in'}</span>
        <button class="logout" onclick=${handle(logout)}>log out</button>
      </span>`
    }
    return h`<span class="who read" data-key="who-read"><span class="dot"></span>read-only · log in to accept</span>`
  }
}

function loginView () {
  return h`<div class="login">
    <h1>chat-edit</h1>
    <p>log in with your streamo credentials. we'll derive your Record's pubkey via <code>keysFor('${HIS_STREAM_NAME}')</code> and put it in the URL hash.</p>
    <form onsubmit=${handle(login)}>
      <label><span>username</span><input name="username" autofocus required autocomplete="username" disabled=${() => ui.get('deriving')}></label>
      <label><span>password</span><input name="password" type="password" required autocomplete="current-password" disabled=${() => ui.get('deriving')}></label>
      <button type="submit" disabled=${() => ui.get('deriving')}>${() => ui.get('deriving') ? 'deriving…' : 'log in'}</button>
      <div class="error">${() => ui.get('loginError') ?? ''}</div>
    </form>
  </div>`
}

function suggestionsView () {
  const suggestions = proposedEdits()
  if (suggestions.length === 0) return h`<div class="empty-suggestion">no proposed edits yet — iris will write some here</div>`
  return suggestions.map((s, i) => h`
    <div class="suggestion" data-key=${`s-${i}`}>
      <div class="from">iris proposes</div>
      <div class="proposed">${s.value ?? ''}</div>
      ${s.reason ? h`<div class="reason">— ${s.reason}</div>` : null}
      <div class="row">
        <button class="accept" disabled=${() => ui.get('accepting') || !ui.get('signerPresent')}
                onclick=${handle(() => acceptSuggestion(s))}>${() => ui.get('signerPresent') ? `accept & set ${s.field ?? '?'}` : 'log in to accept'}</button>
        <button class="dismiss" disabled=${() => ui.get('accepting')}>dismiss</button>
      </div>
    </div>
  `)
}

function editorView () {
  return h`<main>
    <div class="hint">v1: one field (<code>bio</code>). chat with iris elsewhere to direct edits.</div>
    <div class="field-card">
      <div class="field-name">bio</div>
      <div class="field-current">${() => {
        const v = currentBio()
        return v ? v : h`<span class="field-empty">(empty — accept a suggestion to seed it)</span>`
      }}</div>
    </div>
    ${suggestionsView}
    <div class="hint">${() => ui.get('acceptError') ? `error: ${ui.get('acceptError')}` : ''}</div>
  </main>`
}

// ── boot ──────────────────────────────────────────────────────────────────
mount(h`
  <header>
    <span class="brand">streamo · chat-edit</span>
    <span class="sub">${() => ui.get('hisPubkey') ? ui.get('hisPubkey').slice(0, 12) + '…' : '(awaiting login)'}</span>
    ${whoIndicator()}
    <span class="status">${() => ui.get('status')}</span>
  </header>
  ${() => {
    const phase = ui.get('phase')
    if (phase === 'login') return loginView()
    if (phase === 'connecting') return h`<main><div class="hint">connecting to streamo…</div></main>`
    return editorView()
  }}
`, document.body, recaller)

// If hash-pubkey was present at load, kick off a read-only connection
// (no signer; we can show his current value but can't accept until login).
if (hisFromHash) {
  connect(hisFromHash, null).catch(e => {
    ui.set({ status: `connect error: ${e.message}`, phase: 'login' })
  })
}

// Back-button support: when the hash is cleared (browser back from a
// post-login state), reset UI to the login form. login() sets
// location.hash on success, which pushes a history entry; pressing
// back pops to the pre-login URL (no hash) and fires hashchange.
window.addEventListener('hashchange', () => {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : ''
  const validPubkey = /^[0-9a-f]{66}$/i.test(raw) ? raw : null
  if (validPubkey) {
    // Forward-nav or someone hand-typed a hash; reconnect read-only
    // unless it matches who we already have.
    if (ui.get('hisPubkey') !== validPubkey) {
      hisSigner = null  // can't author for a hash we didn't derive
      ui.set({ hisPubkey: validPubkey, phase: 'connecting', status: 'connecting…' })
      connect(validPubkey, null).catch(e => {
        ui.set({ status: `connect error: ${e.message}`, phase: 'login' })
      })
    }
  } else {
    // Hash cleared → back to login. Drop signer + repo references so a
    // re-login derives fresh.
    hisSigner = null
    hisRepo = null
    refreshSignerCell()
    ui.set({
      phase: 'login',
      hisPubkey: null,
      username: null,
      loginError: null,
      acceptError: null,
      status: 'idle'
    })
  }
})
