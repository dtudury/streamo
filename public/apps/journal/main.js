// journal — minimal viable writing surface on streamo.
//
// Mirrors hello-world's five moves, but writes journal-shaped entries:
// `{ headline, body, at }`. Same data shape the homepage's existing
// journal renders, so the two are interoperable if connected later.
// The polish (typography, longer-form editing, permalinks via the
// explorer, etc.) is a future iteration — this is the bones.

import { h }              from '/streamo/h.js'
import { mount }          from '/streamo/mount.js'
import { Signer }         from '/streamo/Signer.js'
import { Recaller }       from '/streamo/utils/Recaller.js'
import { RepoRegistry }   from '/streamo/RepoRegistry.js'
import { registrySync }   from '/streamo/registrySync.js'
import { bridgeRegistry } from '/streamo/bridgeRegistry.js'
import { bytesToHex }     from '/streamo/utils.js'

const usernameEl    = document.getElementById('username')
const passwordEl    = document.getElementById('password')
const statusEl      = document.getElementById('status')
const entriesEl     = document.getElementById('entries')
const headlineEl    = document.getElementById('headline-input')
const bodyEl        = document.getElementById('body-input')
const publishBtn    = document.getElementById('publish-btn')
const explorerLink  = document.getElementById('explorer-link')

let started = false

async function start () {
  if (started) return
  const username = usernameEl.value.trim()
  const password = passwordEl.value.trim()
  if (!username || !password) return
  started = true
  usernameEl.disabled = passwordEl.disabled = true
  statusEl.textContent = 'deriving keypair…'

  // Move 1: identity from credentials.
  const signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('journal')
  const myKey = bytesToHex(publicKey)
  statusEl.textContent = `key ${myKey.slice(0, 16)}…`

  // Move 2: registry + sync.
  const registry = new RepoRegistry()
  await registrySync(registry, location.hostname, +location.port || 80)

  // Move 3: my repo, signed.
  const myRepo = await registry.open(myKey)
  myRepo.attachSigner(signer, 'journal')

  // Move 4: reactive view of entries.
  const recaller = new Recaller('journal')
  const { dep } = bridgeRegistry(registry, recaller, 'journal')

  mount(h`${() => {
    dep()
    const entries = myRepo.get('entries') ?? []
    if (entries.length === 0) {
      return h`<li class="empty">no entries yet — write the first one below.</li>`
    }
    // Newest first.
    return entries.slice().reverse().map(e => h`
      <li class="entry" data-key=${+e.at}>
        <div class="entry-headline">${e.headline || '(untitled)'}</div>
        <div class="entry-body">${e.body || ''}</div>
        <div class="entry-time">${new Date(e.at).toLocaleString()}</div>
      </li>
    `)
  }}`, entriesEl, recaller)

  // Move 5: write a new entry.
  function publish () {
    const headline = headlineEl.value.trim()
    const body = bodyEl.value.trim()
    if (!headline && !body) return
    headlineEl.value = ''
    bodyEl.value = ''
    const entries = myRepo.get('entries') ?? []
    const preview = headline || body.slice(0, 40)
    myRepo.defaultMessage = `entry: "${preview.slice(0, 40)}${preview.length > 40 ? '…' : ''}"`
    myRepo.set({ entries: [...entries, { headline, body, at: new Date() }] })
    headlineEl.focus()
  }

  headlineEl.disabled = false
  bodyEl.disabled = false
  publishBtn.disabled = false
  headlineEl.focus()
  publishBtn.onclick = publish
  // Enter in the headline jumps to the body; submit is the publish
  // button or Cmd/Ctrl-Enter from anywhere in the form.
  headlineEl.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); bodyEl.focus() } }
  const submitOnMeta = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); publish() } }
  bodyEl.onkeydown = submitOnMeta
  headlineEl.addEventListener('keydown', submitOnMeta)

  explorerLink.href = `/apps/explorer/#/repo/${myKey}`
  explorerLink.style.display = 'inline-block'
}

usernameEl.onkeydown = e => { if (e.key === 'Enter') passwordEl.focus() }
passwordEl.onkeydown = e => { if (e.key === 'Enter') start() }
