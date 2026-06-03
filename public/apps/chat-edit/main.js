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

// `uset({...})` on a liveObject is WHOLE-VALUE replacement (LiveSource.js
// lines ~90-114, David's 2026-05-26 fix) — it drops all keys not in the
// passed object. We want MERGE here, so use this helper that does per-key
// path-based set for each entry. See [[ui-set-object-drops-other-keys]].
function uset (obj) { for (const [k, v] of Object.entries(obj)) ui.set(k, v) }

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
  uset({ deriving: true, loginError: null, status: 'deriving identity…' })
  try {
    const signer = new Signer(username, password, 100000)
    const { publicKey } = await signer.keysFor(HIS_STREAM_NAME)
    const derivedHisPubkey = bytesToHex(publicKey)
    if (hisFromHash && hisFromHash !== derivedHisPubkey) {
      uset({
        deriving: false,
        loginError: `credentials derive ${derivedHisPubkey.slice(0, 12)}… but URL hash is ${hisFromHash.slice(0, 12)}…`,
        status: 'idle'
      })
      return
    }
    hisSigner = signer
    uset({ deriving: false, username, hisPubkey: derivedHisPubkey, phase: 'connecting', status: 'connecting…' })
    refreshSignerCell()
    location.hash = derivedHisPubkey
    await connect(derivedHisPubkey, signer)
  } catch (err) {
    uset({ deriving: false, loginError: err.message ?? String(err), status: 'idle' })
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
  uset({ phase: 'editor', status: 'connected' })
  window.__chatEdit = { myRepo, hisRepo, ui }
}

// ── readers ───────────────────────────────────────────────────────────────
function hisValue () {
  return hisRepo?.get() ?? {}
}

function currentValue (field) {
  return hisValue()[field] ?? null
}

// Proposed edits live in MY Record at value.files[<relative-path>] where
// <relative-path> is computed from the app's URL. The app lives at
// /streams/<my-pubkey>/chat-edit/index.html → its sibling proposed-edits.json
// is keyed as 'chat-edit/proposed-edits.json' in the Record's files map.
// Hardcoded for v1; could derive from location.pathname for genericity later.
const PROPOSED_EDITS_PATH = 'chat-edit/proposed-edits.json'

function proposedEdits () {
  if (!myRepo) return []
  const v = myRepo.get()
  const raw = v?.files?.[PROPOSED_EDITS_PATH]
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed.suggestions) ? parsed.suggestions : []
  } catch {
    return []
  }
}

// Render a value: arrays become bulleted lists; strings render as prose.
// Null/undefined → null (caller decides how to show empty state).
function renderValue (v) {
  if (v == null) return null
  if (Array.isArray(v)) {
    return h`<ul class="list-value">${v.map((item, i) => h`<li data-key=${`li-${i}`}>${item}</li>`)}</ul>`
  }
  return h`<div class="prose-value">${v}</div>`
}

// Which fields to render cards for. v1.2: derive from suggestions + repo
// values; v1.1 hardcodes the known set so cards always show even before
// suggestions arrive.
const KNOWN_FIELDS = ['bio', 'idioms']

// ── accept ────────────────────────────────────────────────────────────────
async function acceptSuggestion (s) {
  if (!hisRepo || !hisSigner) {
    ui.set('acceptError', 'must be logged in to accept (need signer)')
    return
  }
  if (!s.field || typeof s.field !== 'string') {
    ui.set('acceptError', `suggestion has no field name`)
    return
  }
  uset({ accepting: true, acceptError: null, status: 'accepting…' })
  try {
    await hisRepo.update(
      c => ({ ...(c ?? {}), [s.field]: s.value, updatedAt: new Date() }),
      { message: `accept iris edit: ${s.field}${s.reason ? ` (${s.reason})` : ''}` }
    )
    ui.set('status', 'accepted')
    markAccepted(s)  // collapse this suggestion from the UI
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

// Go to login view without touching the signer. Used by read-only pill +
// "log in to accept" buttons so those affordances are functional links.
function goToLogin () {
  if (location.hash) {
    history.pushState(null, '', location.pathname + location.search)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    ui.set('phase', 'login')
  }
}

// Track accepted suggestions so they collapse from the UI after accept.
// Module-level Set keyed by field+value-hash; bump an `acceptedTick` cell
// to fire reactivity on the suggestions-filter.
const accepted = new Set()
function suggestionId (s) { return `${s.field}|${JSON.stringify(s.value)}` }
function markAccepted (s) {
  accepted.add(suggestionId(s))
  ui.set('acceptedTick', (ui.get('acceptedTick') ?? 0) + 1)
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
    return h`<button class="who read" data-key="who-read" onclick=${handle(goToLogin)}><span class="dot"></span>read-only · log in to accept</button>`
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

function suggestionsForField (field) {
  ui.get('acceptedTick')  // register reactivity so accept-then-collapse re-renders
  return proposedEdits().filter(s => s.field === field && !accepted.has(suggestionId(s)))
}

function fieldCard (field) {
  return h`<div class="field-card" data-key=${`card-${field}`}>
    <div class="field-name">${field}</div>
    <div class="field-current">${() => {
      const v = currentValue(field)
      const rendered = renderValue(v)
      return rendered ?? h`<span class="field-empty">(empty — accept a suggestion to seed it)</span>`
    }}</div>
    ${() => {
      const ss = suggestionsForField(field)
      if (ss.length === 0) return null
      return ss.map((s, i) => h`
        <div class="suggestion" data-key=${`s-${field}-${i}`}>
          <div class="from">iris proposes</div>
          <div class="proposed">${() => renderValue(s.value) ?? ''}</div>
          ${s.reason ? h`<div class="reason">— ${s.reason}</div>` : null}
          <div class="row">
            <button class="accept" disabled=${() => ui.get('accepting')}
                    onclick=${handle(() => ui.get('signerPresent') ? acceptSuggestion(s) : goToLogin())}>${() => ui.get('signerPresent') ? `accept & set ${field}` : 'log in to accept'}</button>
            <button class="dismiss" disabled=${() => ui.get('accepting')}>dismiss</button>
          </div>
        </div>
      `)
    }}
  </div>`
}

function editorView () {
  return h`<main>
    <div class="hint">chat with iris elsewhere to direct edits.</div>
    ${KNOWN_FIELDS.map(f => fieldCard(f))}
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
    uset({ status: `connect error: ${e.message}`, phase: 'login' })
  })
}

// Back-button support: when the hash changes, navigate the VIEW —
// don't tear down credentials. login() sets location.hash on success,
// pushing a history entry; back pops to the pre-login URL (no hash).
// We just change the displayed phase; hisSigner / hisRepo stay alive
// in memory so going forward again restores the editor seamlessly.
// Actual logout (clearing the signer) is the explicit log-out button.
window.addEventListener('hashchange', () => {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : ''
  const validPubkey = /^[0-9a-f]{66}$/i.test(raw) ? raw : null

  if (!validPubkey) {
    // Hash cleared (back-press). Show login VIEW without touching
    // signer state. If user has a live signer + repo, going forward
    // will restore them.
    ui.set('phase', 'login')
    return
  }

  // Hash present.
  const currentHis = ui.get('hisPubkey')
  if (validPubkey === currentHis) {
    // Forward-nav back to the pubkey we already knew about. Just
    // restore the editor view (no reconnect — session is still alive).
    ui.set('phase', 'editor')
    return
  }

  // Different pubkey hand-typed/pasted — open it read-only. Drop the
  // editor-mode references but KEEP hisSigner intact (it's for the
  // OTHER pubkey we logged in to; user may go back to it).
  hisRepo = null
  uset({ hisPubkey: validPubkey, phase: 'connecting', status: 'connecting…' })
  connect(validPubkey, null).catch(e => {
    uset({ status: `connect error: ${e.message}`, phase: 'login' })
  })
})
