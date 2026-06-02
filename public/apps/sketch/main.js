/**
 * @file sketch — public caricature editor.
 *
 * Future-cold-iris — read as letter, not docs.
 *
 * ## Where this came from
 *
 * 2026-06-02 — David asked for *"a nice public caricature of me"* as the
 * first step of the two-Record / police-sketch arc. The architecture had
 * been mind-built the night before: login + Signer + StreamoRecordRegistry
 * factory + registrySync + session.subscribe + repo.update + recoveryStuck
 * — same shape as shared-note, generalized from one body to many entries.
 *
 * ## What this app is for
 *
 * The sketch substrate (`keysFor('sketch')` at `029dc16a…`) is a curated
 * portrait of David, authored by claude. This app edits it through a
 * browser. The Record is signed by claude credentials; only someone with
 * those credentials can author. Anyone can FETCH the page bytes (it's
 * served from streamo.dev); the EDIT part is gated by login.
 *
 * v1 scope: login-required to even view (matches shared-note). A view-only
 * anonymous mode is a v2 layer.
 *
 * ## Real frictions hit while building this
 *
 *   - **importmap-vs-stream-mount gap**: streamo.dev injects
 *     `<script type="importmap">{"@dtudury/streamo/":"/streamo/"}</script>`
 *     into all served HTML — but `/streamo/*` only resolves on the
 *     homepage Record's mount. Pages served at `/streams/<other>/...`
 *     get the importmap but the targets 404. Worked around with absolute
 *     URLs to `/streams/02e77190.../`. See [[importmap-vs-stream-mount-gap]].
 *   - **pubkey-from-URL is path-only**: the page extracts pubkey from
 *     `/streams/<66-hex>/`. Doesn't work via the friendly subdomain
 *     (sketch.streamo.social) because the path is just `/index.html`.
 *     The hyper-school for this friction is a meta-tag injection from
 *     streamo.dev's mount server — same family as the importmap gap.
 *     See [[sketch-app-needs-its-record-identity]] +
 *     [[hyper-school-meta-tag-injection]].
 *   - **library Record missing files**: imports from
 *     `/streams/02e77190.../StreamoRecord.js` and similar — at the time
 *     this app shipped, those files were 404 because the library Record
 *     hadn't been re-synced post-11.0-rename. Sketch worked only after
 *     the library was caught up (which itself is its own arc — see
 *     [[chain-adoption-still-unsolved]]).
 *
 * ## What works in v1
 *
 *   - Login derives Signer.keysFor('sketch'); only succeeds if creds match URL pubkey
 *   - Subscribe → entries list on the left, editor on the right
 *   - Save commits with a real message (sketch-specific compose: verb + name)
 *   - New-entry pre-fills `entries/<today>-` so the slash convention from
 *     streamon's relaxation gets used naturally
 *   - Rename support (selectedName ≠ draftName → delete-then-write atomic)
 *
 * ## What v2 would add
 *
 *   - Anonymous view-only mode (currently login-required to even view)
 *   - Markdown preview pane
 *   - Frontmatter parsing (born-from links rendered as portals)
 *   - Cross-Record suggestions (David's own sketch-of-self Record alongside)
 *
 * ## Lens portals
 *
 *   - [[importmap-vs-stream-mount-gap]] — workaround for non-homepage Records
 *   - [[git-vs-streamo-message-inconsistency]] — sketch save uses {message}
 *     so the chain reads as narrative; sister to commit-message discipline
 *   - [[police-sketch-architecture]] — the two-Record arc this is step 1 of
 *   - [[within-record-vs-cross-record-different-layers]] — entries live at
 *     value.files; sub-sketches (when v2 wants them) go via mounts.json
 *
 * ## See this file's chain
 *
 *   bash scripts/file-history.sh public/apps/sketch/main.js
 *
 * The chain layer carries the per-edit letter; this file is the snapshot.
 *
 * — past-iris, 2026-06-02 late afternoon, after sketch v1 deployed and the
 *   {message} retrofit aligned chain-narrative with git-narrative.
 */

// Library Record's URL — same pattern as hello.html. The auto-injected
// importmap at streamo.dev doesn't resolve `/streamo/*` from non-homepage
// mounts, so absolute URLs to /streams/<library-pubkey>/ instead.
// See [[importmap-vs-stream-mount-gap]].
// 2026-06-02 fork: library forked from 02e77190…b93a → 028d6969…78f1c9.
// Old library Record was stuck pre-11.0 (Repo.js/RepoRegistry.js names);
// chain-adoption attempts failed all afternoon; we forked under
// keysFor('streamo-library-2') from the same streamo-library credentials.
// See [[fork-and-replace-as-the-actual-unblock]] + design.md §14.5 +
// scripts/file-history.sh public/apps/sketch/main.js for the chain.
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
  const old = ui.get('selectedName')
  // Compose a real commit message so the chain reads as narrative, not
  // silent byte-ship. See [[git-vs-streamo-message-inconsistency]]: every
  // streamo update deserves the same articulation discipline as a git
  // commit. Caller-context here is "the user edited <name> via the sketch
  // app" — that IS the why; encode it.
  const verb    = (old && old === name) ? 'edit' : (old ? `rename ${old} →` : 'add')
  const message = `${verb} ${name} via sketch app`
  ui.set({ saving: true, status: 'saving…' })
  try {
    await myRepo.update(c => {
      const files = { ...(c?.files ?? {}) }
      // If renaming (selectedName ≠ draftName), drop the old key.
      if (old && old !== name) delete files[old]
      files[name] = body
      return { ...(c ?? {}), files, writtenAt: new Date().toISOString() }
    }, { message })
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
