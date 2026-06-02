/**
 * streamo notes — sketch substrate editor (v1)
 *
 * Phase 2: list + read + write against streamon's HTTP API. No smart-surfaces
 * yet (bracket-autocomplete + hover-preview come in the next phase). Plain
 * textarea editor + sidebar of entries + save button.
 *
 * Assumes streamon is running locally on 127.0.0.1:8088 (the daemon's HTTP
 * endpoint). If absent: shows a message; user starts daemon via
 *   node scripts/streamon-do.mjs ping
 * (which spawns it if needed).
 */
const STREAMON_API = 'http://127.0.0.1:8088/api'

const el = id => document.getElementById(id)
const $sidebar  = el('sidebar')
const $name     = el('name-input')
const $editor   = el('editor')
const $save     = el('save-btn')
const $status   = el('status')
const $main     = el('main')
const $loading  = el('loading')

let state = {
  currentName: null,   // currently-loaded entry name (or null = new unsaved)
  loadedBody: '',      // body as last loaded (for dirty-detection)
  pubkey: null,
  list: []
}

// ── streamon API ──────────────────────────────────────────────────────────

async function api (path, options = {}) {
  const res = await fetch(`${STREAMON_API}${path}`, options)
  if (!res.ok && res.status !== 400) throw new Error(`streamon http ${res.status}`)
  return res.json()
}

// Notes is a markdown app — slugs become `<slug>.md` filenames.
// streamon used to auto-append `.md`; that magic moved out (sketch-specific
// aesthetic doesn't belong in the daemon). Apps own their extensions now.
const toFilename = slug => slug.endsWith('.md') ? slug : `${slug}.md`
const toSlug     = name => name.replace(/\.md$/, '')

async function ping ()             { return api('/ping') }
async function listEntries ()      {
  const r = await api('/list')
  if (!r.ok) return r
  // streamon now returns raw filenames; strip .md for the UI slug-view.
  return { ...r, names: r.names.filter(n => n.endsWith('.md')).map(toSlug) }
}
async function readEntry (slug)    { return api(`/read?name=${encodeURIComponent(toFilename(slug))}`) }
async function writeEntry (slug, body) {
  return api('/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: toFilename(slug), body })
  })
}

// ── rendering ─────────────────────────────────────────────────────────────

function renderSidebar () {
  $sidebar.innerHTML = ''
  const newBtn = document.createElement('div')
  newBtn.className = 'new-btn'
  newBtn.textContent = '+ new entry'
  newBtn.onclick = () => selectEntry(null)
  $sidebar.appendChild(newBtn)
  for (const name of state.list) {
    const item = document.createElement('div')
    item.className = 'list-item' + (name === state.currentName ? ' active' : '')
    item.textContent = name
    item.onclick = () => selectEntry(name)
    $sidebar.appendChild(item)
  }
}

function setDirty () {
  const dirty = $name.value !== (state.currentName ?? '') || $editor.value !== state.loadedBody
  const valid = /^[a-z0-9][a-z0-9-]*$/i.test($name.value) && $editor.value.length > 0
  $save.disabled = !valid || !dirty
  $save.classList.toggle('dirty', dirty && valid)
}

async function selectEntry (name) {
  if (name === null) {
    state.currentName = null
    state.loadedBody = ''
    $name.value = ''
    $editor.value = ''
    $name.focus()
  } else {
    const res = await readEntry(name)
    if (!res.ok) { $status.textContent = `read failed: ${res.error}`; return }
    state.currentName = name
    state.loadedBody = res.body
    $name.value = name
    $editor.value = res.body
  }
  renderSidebar()
  setDirty()
}

async function saveCurrent () {
  const name = $name.value.trim()
  const body = $editor.value
  $save.disabled = true; $save.textContent = 'saving…'
  try {
    const res = await writeEntry(name, body)
    if (res.ok) {
      state.currentName = name
      state.loadedBody = body
      const head = await listEntries()
      if (head.ok) state.list = head.names
      renderSidebar()
      $status.textContent = `saved · chain ${res.chainHash?.slice(0, 12)}…`
    } else {
      $status.textContent = `write failed: ${res.error}`
    }
  } catch (e) {
    $status.textContent = `error: ${e.message}`
  } finally {
    $save.textContent = 'save'
    setDirty()
  }
}

// ── boot ──────────────────────────────────────────────────────────────────

$save.onclick = saveCurrent
$name.oninput = setDirty
$editor.oninput = setDirty

try {
  const p = await ping()
  if (!p.ok) throw new Error('ping failed')
  state.pubkey = p.pubkey
  const list = await listEntries()
  if (!list.ok) throw new Error(list.error || 'list failed')
  state.list = list.names
  $status.textContent = `streamon · ${state.pubkey.slice(0, 12)}… · ${state.list.length} entries`
  renderSidebar()
  $loading.remove()
  $main.style.display = 'flex'
  if (state.list[0]) selectEntry(state.list[0])
} catch (e) {
  $loading.innerHTML = `<p>streamon not reachable at 127.0.0.1:8088</p>
    <p style="font-size:0.85rem;color:#888;margin-top:1rem">start it with: <code style="background:#eee;padding:0.2rem 0.4rem">node scripts/streamon-do.mjs ping</code></p>
    <p style="font-size:0.85rem;color:#888;margin-top:0.4rem">then refresh.</p>`
}
