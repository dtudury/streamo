// hello — the smallest possible streamo app.
//
// Five moves, numbered below. Read them top-to-bottom and you have the
// complete loop: identity, sync, signed writes, reactive reads, and a
// way to commit new entries. Everything streamo offers is reachable
// from these primitives; this file is a working starter you can copy.

import { h }              from '/streamo/h.js'
import { mount }          from '/streamo/mount.js'
import { Signer }         from '/streamo/Signer.js'
import { Recaller }       from '/streamo/utils/Recaller.js'
import { RepoRegistry }   from '/streamo/RepoRegistry.js'
import { registrySync }   from '/streamo/registrySync.js'
import { bridgeRegistry } from '/streamo/bridgeRegistry.js'
import { bytesToHex }     from '/streamo/utils.js'

// DOM refs.
const usernameEl    = document.getElementById('username')
const passwordEl    = document.getElementById('password')
const keyEl         = document.getElementById('key')
const entriesEl     = document.getElementById('entries')
const inputEl       = document.getElementById('entry-input')
const addBtn        = document.getElementById('add-btn')
const explorerLink  = document.getElementById('explorer-link')

let started = false

async function start () {
  if (started) return
  const username = usernameEl.value.trim()
  const password = passwordEl.value.trim()
  if (!username || !password) return
  started = true
  usernameEl.disabled = passwordEl.disabled = true

  // ── Move 1: identity ──────────────────────────────────────────────
  //
  // Signer derives a secp256k1 keypair from (username, password) via
  // PBKDF2. Same credentials → same key, forever, on any device. No
  // key files, no seed phrases. The trailing `1` is a key-iterations
  // hint kept small here for fast demo turnaround (production
  // defaults to 100k+ via STREAMO_KEY_ITERATIONS).
  const signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('hello')
  const myKey = bytesToHex(publicKey)
  keyEl.textContent = myKey

  // ── Move 2: registry + sync ───────────────────────────────────────
  //
  // RepoRegistry holds every Repo we know about (ours + peers'). The
  // registrySync helper opens a WebSocket to the server we were
  // served from and bridges chunks both ways — our writes flow up,
  // others' writes flow down.
  const registry = new RepoRegistry()
  await registrySync(registry, location.hostname, +location.port || 80)

  // ── Move 3: my repo, signed ───────────────────────────────────────
  //
  // registry.open returns the Repo at our key (creates a fresh one
  // for keys we haven't seen yet). attachSigner means every set()
  // below automatically produces a signed commit — no separate
  // sign-this-commit call required.
  const myRepo = await registry.open(myKey)
  myRepo.attachSigner(signer, 'hello')

  // ── Move 4: reactive view ─────────────────────────────────────────
  //
  // Each Repo has its own internal Recaller for tracking chunk
  // mutations; the app has its own Recaller for tracking UI
  // dependencies. bridgeRegistry wires them together: dep() inside a
  // mount slot subscribes to ANY change on ANY Repo in the registry,
  // so the slot re-renders whenever new chunks arrive — from our own
  // writes or from a peer's.
  const recaller = new Recaller('hello')
  const { dep } = bridgeRegistry(registry, recaller, 'hello')

  mount(h`${() => {
    dep()
    const entries = myRepo.get('entries') ?? []
    if (entries.length === 0) {
      return h`<div class="empty">no entries yet — add one below.</div>`
    }
    return entries.slice().reverse().map(e => h`
      <div class="entry" data-key=${+e.at}>
        <div class="entry-text">${e.text}</div>
        <div class="entry-time">${new Date(e.at).toLocaleString()}</div>
      </div>
    `)
  }}`, entriesEl, recaller)

  // ── Move 5: write ─────────────────────────────────────────────────
  //
  // repo.set replaces the whole value. Streamo is content-addressed,
  // so unchanged chunks are deduplicated — the cost of writing is
  // proportional to what actually changed, not to total value size.
  // The attached signer kicks in automatically; the commit's message
  // comes from defaultMessage (or "" if not set).
  function add () {
    const text = inputEl.value.trim()
    if (!text) return
    inputEl.value = ''
    const entries = myRepo.get('entries') ?? []
    myRepo.defaultMessage = `entry: "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`
    myRepo.set({ entries: [...entries, { text, at: new Date() }] })
  }

  // Wire up the add button + Enter-to-submit.
  inputEl.disabled = false
  addBtn.disabled = false
  inputEl.focus()
  addBtn.onclick = add
  inputEl.onkeydown = e => { if (e.key === 'Enter') add() }

  // Drop a link to this repo in the explorer — once you've written
  // an entry, this is the fastest way to see the chunks, the signed
  // commit, and the rest of streamo's machinery in motion.
  explorerLink.href = `/apps/explorer/#/repo/${myKey}`
  explorerLink.style.display = 'inline-block'
}

usernameEl.onkeydown = e => { if (e.key === 'Enter') passwordEl.focus() }
passwordEl.onkeydown = e => { if (e.key === 'Enter') start() }
