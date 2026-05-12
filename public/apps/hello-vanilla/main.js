// hello-vanilla — the same streamo hello-world as /apps/hello/, written
// without `h`. Plain DOM API: createElement / appendChild / textContent /
// addEventListener. Same five moves, same data shape, same network
// path — just no html-in-js. Useful side-by-side reference for someone
// asking "is `h` doing anything I couldn't do myself?"
//
// One thing this version still uses: streamo's Recaller, so that the
// entries list re-renders when chunks arrive. You could replace
// Recaller with a polling timer or a custom event-bus and the rest
// would still work; we keep Recaller because it's part of streamo's
// kit, not part of the html-in-js story.

import { Signer }         from '../../streamo/Signer.js'
import { Recaller }       from '../../streamo/utils/Recaller.js'
import { RepoRegistry }   from '../../streamo/RepoRegistry.js'
import { registrySync }   from '../../streamo/registrySync.js'
import { bytesToHex }     from '../../streamo/utils.js'

// ── DOM refs ─────────────────────────────────────────────────────────

const loginForm    = document.getElementById('login-form')
const addForm      = document.getElementById('add-form')
const addHeading   = document.getElementById('add-heading')
const entriesEl    = document.getElementById('entries')
const keyEl        = document.getElementById('key')
const explorerLink = document.getElementById('explorer-link')

// ── state ────────────────────────────────────────────────────────────

const recaller = new Recaller('hello-vanilla')
let myRepo, myKey, dep

// ── render: rebuild the entries list from scratch on each fire ───────
//
// Vanilla approach — wipe innerHTML, append fresh children. For a
// small list that's fine. (For larger lists you'd want keyed
// reconciliation, which is what `mount` does for you in the h
// version.)

function renderEntries () {
  dep?.()
  const entries = myRepo?.get('entries') ?? []
  entriesEl.innerHTML = ''
  if (entries.length === 0) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'no entries yet — add one below.'
    entriesEl.appendChild(li)
    return
  }
  for (const e of entries.slice().reverse()) {
    const li = document.createElement('li')
    li.className = 'entry'
    li.dataset.key = String(+e.at)

    const text = document.createElement('div')
    text.className = 'entry-text'
    text.textContent = e.text
    li.appendChild(text)

    const time = document.createElement('div')
    time.className = 'entry-time'
    time.textContent = new Date(e.at).toLocaleString()
    li.appendChild(time)

    entriesEl.appendChild(li)
  }
}

// ── handlers ─────────────────────────────────────────────────────────

loginForm.addEventListener('submit', async e => {
  e.preventDefault()
  const usernameEl = loginForm.elements.username
  const passwordEl = loginForm.elements.password
  const username = usernameEl.value.trim()
  const password = passwordEl.value.trim()
  if (!username) { usernameEl.focus(); return }
  if (!password) { passwordEl.focus(); return }
  usernameEl.disabled = passwordEl.disabled = true

  // Move 1: identity.
  const signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('hello')
  myKey = bytesToHex(publicKey)

  // Move 2: registry + sync. The registry shares our Recaller and
  // exposes dep() so the watcher below re-runs whenever any Repo's
  // chunks change.
  const registry = new RepoRegistry(undefined, { recaller, name: 'hello-vanilla' })
  dep = registry.dep
  await registrySync(registry, location.hostname, +location.port || 80)

  // Move 3: my repo, signed.
  myRepo = await registry.open(myKey)
  myRepo.attachSigner(signer, 'hello')

  // Move 4: watch — re-runs the render function on every fire.
  recaller.watch('render-entries', renderEntries)

  // Reveal post-login UI.
  keyEl.textContent = myKey
  keyEl.classList.remove('hidden')
  addHeading.classList.remove('hidden')
  addForm.classList.remove('hidden')
  explorerLink.href = `../explorer/#/repo/${myKey}`
  explorerLink.classList.remove('hidden')
  addForm.elements.text.focus()
})

addForm.addEventListener('submit', e => {
  e.preventDefault()
  const inputEl = addForm.elements.text
  const text = inputEl.value.trim()
  if (!text) return
  const entries = myRepo.get('entries') ?? []
  myRepo.defaultMessage = `entry: "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`
  // Move 5: write. Content-addressed; unchanged chunks deduplicate.
  myRepo.set({ entries: [...entries, { text, at: new Date() }] })
  inputEl.value = ''
  inputEl.focus()
})
