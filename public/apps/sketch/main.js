/**
 * @file sketch — public caricature editor.
 *
 * A streamo app that's served FROM the same Record it edits. Page loads at
 * /streams/<pubkey>/index.html (or via hostMap at sketch.streamo.social);
 * the JS extracts <pubkey> from the URL and subscribes to it. Login with
 * credentials whose `keysFor('sketch')` matches the URL pubkey attaches a
 * signer, enabling edits.
 *
 * Architecture echoes shared-note (login + Signer + factory + subscribe +
 * update + recoveryStuck), generalized from one body to many entries.
 * Entries live at `value.files[<filename>]` — within-Record file storage.
 * (Cross-Record nesting via mounts.json is its own thing; not used here.)
 *
 * For now this is the public-caricature-of-David Record. The public part
 * is the URL; anyone can fetch the page bytes. The edit part is the login,
 * which only succeeds with creds that derive the matching pubkey.
 *
 * v1 scope: login-required to even view (matches shared-note). A view-only
 * anonymous mode is a v2 layer.
 */

// Library Record's URL — same pattern as hello.html. The auto-injected
// importmap at streamo.dev doesn't resolve `/streamo/*` from non-homepage
// mounts, so absolute URLs to /streams/<library-pubkey>/ instead.
// See [[importmap-vs-stream-mount-gap]].
const LIB = 'https://streamo.dev/streams/02e77190d3761da3dc3e4cc69d2daca2e946a32fe212e62209de42c68c51bdb93a'
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
// The page subscribes to whatever Record it was served from.
// URL shape: /streams/<66-hex>/<path>... → pubkey is segment 1 of pathname.
// If we're served via hostMap (sketch.streamo.social/...), this won't match.
// v1 limitation: only works at /streams/<pubkey>/ URLs. v2: fetch from
// /api/info or a meta tag.

const m = location.pathname.match(/^\/streams\/([0-9a-f]{66})\b/i)
const urlPubkey = m && m[1]

// ── state ─────────────────────────────────────────────────────────────────

const recaller = new Recaller('sketch')

const ui = liveObject({
  phase:        'login',     // 'login' | 'editor'
  loginError:   null,
  deriving:     false,
  username:     null,
  status:       'idle',
  selectedName: null,        // active entry filename (e.g. 'foo.md')
  draftName:    '',
  draftBody:    '',
  loadedBody:   '',          // what we last loaded — for dirty-detection
  saving:      false
}, { recaller })

// Set during login; populated only when creds match urlPubkey.
let signer = null
let myRepo = null
let session = null

// ── login ─────────────────────────────────────────────────────────────────

async function login (e) {
  e.preventDefault()
  if (!urlPubkey) {
    ui.set('loginError', 'this page must be served at /streams/<pubkey>/index.html')
    return
  }
  const f = e.target
  const username = f.elements.username.value.trim()
  const password = f.elements.password.value
  if (!username || !password) return
  ui.set({ deriving: true, loginError: null, status: 'deriving identity…' })
  try {
    const candidateSigner = new Signer(username, password, 100000)
    const { publicKey } = await candidateSigner.keysFor('sketch')
    const derived = bytesToHex(publicKey)
    if (derived !== urlPubkey) {
      ui.set({
        deriving: false,
        loginError: `credentials don't match this sketch (derived ${derived.slice(0,12)}…, page is ${urlPubkey.slice(0,12)}…)`,
        status: 'idle'
      })
      return
    }
    signer = candidateSigner
    // Now spin up the registry — Writable factory for our key.
    const registry = new StreamoRecordRegistry({
      recaller,
      factory: key => key === urlPubkey
        ? new WritableStreamoRecord({ recaller })
        : new StreamoRecord({ recaller })
    })
    ui.set('status', 'connecting…')
    session = await registrySync(registry, location.host, {
      onConnectionChange: c => ui.set('status', c ? 'connected' : 'reconnecting…')
    })
    myRepo = await session.subscribe(urlPubkey)
    myRepo.attachSigner(signer, 'sketch')
    myRepo.defaultMessage = `edit by ${username}`
    window.sketchRepo = myRepo
    ui.set({ deriving: false, username, phase: 'editor' })
  } catch (err) {
    ui.set({ deriving: false, loginError: err.message ?? String(err), status: 'idle' })
  }
}

// ── editor ────────────────────────────────────────────────────────────────

function isDirty () {
  return ui.get('draftName') !== (ui.get('selectedName') ?? '') ||
         ui.get('draftBody') !== ui.get('loadedBody')
}

function nameIsValid () {
  // filename must end in something reasonable; slashes ok for sub-dirs.
  const n = ui.get('draftName')
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.md$/.test(n)
}

function listEntries () {
  if (!myRepo) return []
  const value = myRepo.get()
  const files = (value?.files && typeof value.files === 'object' && !(value.files instanceof Uint8Array))
    ? value.files : {}
  return Object.keys(files).filter(n => n.endsWith('.md')).sort()
}

function selectEntry (name) {
  if (!myRepo) return
  if (name === null) {
    ui.set({ selectedName: null, draftName: '', draftBody: '', loadedBody: '' })
    return
  }
  const value = myRepo.get()
  const body = value?.files?.[name] ?? ''
  ui.set({ selectedName: name, draftName: name, draftBody: body, loadedBody: body })
}

async function save (e) {
  e?.preventDefault?.()
  if (!myRepo || !nameIsValid()) return
  const name = ui.get('draftName')
  const body = ui.get('draftBody')
  ui.set({ saving: true, status: 'saving…' })
  try {
    await myRepo.update(c => {
      const files = { ...(c?.files ?? {}) }
      // If renaming (selectedName ≠ draftName), drop the old key.
      const old = ui.get('selectedName')
      if (old && old !== name) delete files[old]
      files[name] = body
      return { ...(c ?? {}), files, writtenAt: new Date().toISOString() }
    })
    ui.set({ selectedName: name, loadedBody: body, status: 'saved' })
  } catch (err) {
    ui.set('status', `save failed: ${err.message ?? err}`)
  } finally {
    ui.set('saving', false)
  }
}

function newEntry () {
  const ts = new Date().toISOString().slice(0, 10)
  ui.set({
    selectedName: null,
    draftName: `entries/${ts}-.md`,
    draftBody: '',
    loadedBody: ''
  })
}

// ── views ─────────────────────────────────────────────────────────────────

function loginView () {
  return h`<main class="login">
    <h1>sketch</h1>
    <p class="hint">public caricature of david, edited by claude. log in with credentials that derive this Record's pubkey to author.</p>
    <form onsubmit=${handle(login)}>
      <label>
        <span>username</span>
        <input name="username" autofocus required autocomplete="username" disabled=${() => ui.get('deriving')}>
      </label>
      <label>
        <span>password</span>
        <input name="password" type="password" required autocomplete="current-password" disabled=${() => ui.get('deriving')}>
      </label>
      <button type="submit" disabled=${() => ui.get('deriving')}>${() => ui.get('deriving') ? 'deriving…' : 'log in'}</button>
      <div class="error">${() => ui.get('loginError') ?? ''}</div>
    </form>
  </main>`
}

function entryListView () {
  const entries = listEntries()
  if (entries.length === 0) {
    return h`<div class="empty">no entries yet — click <em>+ new</em></div>`
  }
  return entries.map(name => h`
    <div class="list-item ${() => ui.get('selectedName') === name ? 'active' : ''}"
         data-key=${name}
         onclick=${handle(() => selectEntry(name))}>
      ${name}
    </div>`)
}

function editorView () {
  return h`<main>
    <aside>
      <div class="new-btn" onclick=${handle(newEntry)}>+ new entry</div>
      ${entryListView}
    </aside>
    <section>
      <div class="name-row">
        <input value=${() => ui.get('draftName')}
               oninput=${handle(e => ui.set('draftName', e.target.value))}
               placeholder="entries/YYYY-MM-DD-slug.md"
               spellcheck="false" autocomplete="off">
        <button class=${() => isDirty() && nameIsValid() ? 'dirty' : ''}
                disabled=${() => ui.get('saving') || !isDirty() || !nameIsValid()}
                onclick=${handle(save)}>${() => ui.get('saving') ? 'saving…' : 'save'}</button>
      </div>
      <textarea spellcheck="false"
                placeholder="write here…"
                oninput=${handle(e => ui.set('draftBody', e.target.value))}>${() => ui.get('draftBody')}</textarea>
    </section>
  </main>`
}

// ── mount ─────────────────────────────────────────────────────────────────

const pubkeyBanner = () => urlPubkey
  ? null
  : h`<div class="banner">No pubkey in URL — this page must be served at /streams/&lt;pubkey&gt;/index.html. Falling back to login-only view.</div>`

mount(h`
  <header>
    <span class="brand">streamo · sketch</span>
    <span class="sub">${() => urlPubkey ? urlPubkey.slice(0, 12) + '…' : '(no pubkey)'}</span>
    <span class="status">${() => ui.get('status')}</span>
  </header>
  ${pubkeyBanner}
  ${() => ui.get('phase') === 'login' ? loginView() : editorView()}
`, document.body, recaller)
