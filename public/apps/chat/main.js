/// <reference lib="dom" />
import { Signer } from '/streamo/Signer.js'
import { RepoRegistry } from '/streamo/RepoRegistry.js'
import { registrySync } from '/streamo/registrySync.js'
import { bytesToHex } from '/streamo/utils.js'

const loginEl  = document.getElementById('login')
const chatEl   = document.getElementById('chat')
const statusEl = document.getElementById('status')
const myNameEl = document.getElementById('my-name')
const msgsEl   = document.getElementById('messages')
const inputEl  = document.getElementById('msg-input')
const sendBtn  = document.getElementById('send-btn')
const joinBtn  = document.getElementById('join-btn')

const { primaryKeyHex: rootKey } = await fetch('/api/info').then(r => r.json())

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt (ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ── Rendering ──────────────────────────────────────────────────────────────

let myKey = null

/** Flat list of { name, text, at, mine } sorted by `at` */
function collectMessages (registry) {
  const all = []
  for (const [keyHex, repo] of registry) {
    const name = repo.get('name')
    const messages = repo.get('messages') ?? []
    for (const msg of messages) {
      const text = typeof msg === 'string' ? msg : msg?.text ?? String(msg)
      const at   = msg?.at ?? 0
      all.push({ name, text, at, mine: keyHex === myKey })
    }
  }
  all.sort((a, b) => a.at - b.at)
  return all
}

let rendered = 0

function renderMessages (registry) {
  const all = collectMessages(registry)
  // Only append new messages (simple: clear + rebuild if out of order, else append)
  if (all.length < rendered) {
    msgsEl.innerHTML = ''
    rendered = 0
  }
  for (let i = rendered; i < all.length; i++) {
    const { name, text, at, mine } = all[i]
    const div = document.createElement('div')
    div.className = `msg ${mine ? 'mine' : 'theirs'}`
    div.innerHTML = `
      ${!mine ? `<div class="sender">${escHtml(name)}</div>` : ''}
      <div class="text">${escHtml(text)}</div>
      <div class="time">${fmt(at)}</div>
    `
    msgsEl.appendChild(div)
  }
  rendered = all.length
  if (all.length > rendered - 1) msgsEl.scrollTop = msgsEl.scrollHeight
}

function escHtml (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Join ───────────────────────────────────────────────────────────────────

joinBtn.onclick = async () => {
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value.trim()
  if (!username || !password) { statusEl.textContent = 'enter username and password'; return }

  joinBtn.disabled = true
  statusEl.textContent = 'connecting…'

  try {
    const signer = new Signer(username, password, 1)
    const { publicKey } = await signer.keysFor('chat')
    myKey = bytesToHex(publicKey)

    const registry = new RepoRegistry()

    const session = await registrySync(registry, location.hostname, Number(location.port) || 80, {
      filter: k => k === rootKey,
      follow: (keyHex, repo, subscribe) => {
        for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
      },
      onAnnounce: (key) => {
        session.subscribe(key)
      }
    })

    // Open own repo
    const myRepo = await registry.open(myKey)
    if (!myRepo.get('name')) {
      myRepo.set({ name: username, messages: [] })
    }

    session.interest(rootKey)
    session.announce(myKey, rootKey)

    // Switch to chat view
    loginEl.style.display = 'none'
    chatEl.style.display = 'flex'
    myNameEl.textContent = `(${username})`

    // Reactive rendering: re-render on any repo change
    function watchRepo (keyHex, repo) {
      repo.watch(`chat-render:${keyHex}`, () => renderMessages(registry))
    }
    for (const [k, r] of registry) watchRepo(k, r)
    registry.onOpen((keyHex, repo) => {
      watchRepo(keyHex, repo)
      renderMessages(registry)
    })
    renderMessages(registry)

    // ── Send ────────────────────────────────────────────────────────────────

    async function sendMessage () {
      const text = inputEl.value.trim()
      if (!text) return
      inputEl.value = ''
      const messages = myRepo.get('messages') ?? []
      myRepo.set({ name: username, messages: [...messages, { text, at: Date.now() }] })
    }

    sendBtn.onclick = sendMessage
    inputEl.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }
    inputEl.focus()

  } catch (e) {
    statusEl.textContent = `error: ${e.message}`
    joinBtn.disabled = false
  }
}

document.getElementById('username').onkeydown = e => { if (e.key === 'Enter') document.getElementById('password').focus() }
document.getElementById('password').onkeydown = e => { if (e.key === 'Enter') joinBtn.click() }
