import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { Signer } from '../../streamo/Signer.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { bytesToHex } from '../../streamo/utils.js'

const { primaryKeyHex: rootKey } = await fetch('/api/info').then(r => r.json())

function fmt (ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Msg ({ name, text, at, mine }) {
  return h`
    <div class=${['msg', mine ? 'mine' : 'theirs']} data-key=${at}>
      ${!mine ? h`<div class="sender">${name}</div>` : null}
      <div class="text">${text}</div>
      <div class="time">${fmt(at)}</div>
    </div>
  `
}

const loginEl  = document.getElementById('login')
const chatEl   = document.getElementById('chat')
const msgsEl   = document.getElementById('messages')
const inputEl  = document.getElementById('msg-input')
const statusEl = document.getElementById('status')
const joinBtn  = document.getElementById('join-btn')

joinBtn.onclick = async () => {
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value.trim()
  if (!username || !password) { statusEl.textContent = 'enter username and password'; return }

  joinBtn.disabled = true
  statusEl.textContent = 'connecting…'

  try {
    const signer  = new Signer(username, password, 1)
    const { publicKey } = await signer.keysFor('chat')
    const myKey   = bytesToHex(publicKey)
    const registry = new RepoRegistry()

    const session = await registrySync(registry, location.hostname, Number(location.port) || 80, {
      filter:     k => k === rootKey,
      follow:     (keyHex, repo, subscribe) => {
                    for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
                  },
      onAnnounce: key => session.subscribe(key)
    })

    const myRepo = await registry.open(myKey)
    if (!myRepo.get('name')) myRepo.set({ name: username, messages: [] })

    session.interest(rootKey)
    session.announce(myKey, rootKey)

    loginEl.style.display = 'none'
    chatEl.style.display  = 'flex'
    document.getElementById('my-name').textContent = `(${username})`

    // ── Reactive message list ──────────────────────────────────────────────
    //
    // Each repo has its own internal Recaller, so repo.get() inside a mount
    // slot won't automatically re-trigger mount's recaller. Bridge via
    // reportKey*: repo.watch() calls reportKeyMutation when data changes;
    // the slot calls reportKeyAccess to register the dependency.

    const recaller = new Recaller('chat')
    const signal   = {}

    function triggerRender () {
      recaller.reportKeyMutation(signal, 'data')
      requestAnimationFrame(() => { msgsEl.scrollTop = msgsEl.scrollHeight })
    }

    function watchRepo (keyHex, repo) {
      repo.watch(`chat:${keyHex}`, triggerRender)
    }

    for (const [k, r] of registry) watchRepo(k, r)
    registry.onOpen((keyHex, repo) => { watchRepo(keyHex, repo); triggerRender() })

    mount(h`${function messages () {
      recaller.reportKeyAccess(signal, 'data')
      const all = []
      for (const [keyHex, repo] of registry) {
        if (keyHex === rootKey) continue
        const name = repo.get('name')
        for (const msg of repo.get('messages') ?? []) {
          const text = typeof msg === 'string' ? msg : msg?.text ?? String(msg)
          const at   = msg?.at ?? 0
          all.push({ name, text, at, mine: keyHex === myKey })
        }
      }
      all.sort((a, b) => a.at - b.at)
      return all.map(({ name, text, at, mine }) =>
        h`<${Msg} name=${name} text=${text} at=${at} mine=${mine}/>`)
    }}`, msgsEl, recaller)

    // ── Send ────────────────────────────────────────────────────────────────

    const sendBtn = document.getElementById('send-btn')

    function sendMessage () {
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
