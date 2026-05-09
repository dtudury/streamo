import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { Signer } from '../../streamo/Signer.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { bridgeRegistry } from '../../streamo/bridgeRegistry.js'
import { bytesToHex } from '../../streamo/utils.js'

const { primaryKeyHex: rootKey } = await fetch('/api/info').then(r => r.json())

function fmt (ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Msg ({ name, text, at, mine }) {
  // +at coerces both Date and number to ms — stable key across old (number)
  // and new (Date) message records as we transition.
  return h`
    <div class=${['msg', mine ? 'mine' : 'theirs']} data-key=${+at}>
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

    // Track who we've already announced ourselves back to, so we don't
    // ping-pong forever. Without this set, every peer-back ricochets into
    // another peer-back and so on.
    const announcedTo = new Set()
    const session = await registrySync(registry, location.hostname, Number(location.port) || 80, {
      filter:     k => k === rootKey,
      follow:     (keyHex, repo, subscribe) => {
                    for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
                  },
      // When a peer announces, subscribe to them AND announce ourselves
      // back so they learn we exist — this makes peer discovery work
      // through pure real-time fan-out, no server-side member tracking
      // required. Late-joiner sees us, we see late-joiner.
      onAnnounce: key => {
        session.subscribe(key)
        if (!announcedTo.has(key)) {
          announcedTo.add(key)
          session.announce(myKey, rootKey)
        }
      }
    })

    const myRepo = await registry.open(myKey)
    myRepo.attachSigner(signer, 'chat')
    myRepo.defaultMessage = `joined as ${username} (web)`

    session.interest(rootKey)
    session.announce(myKey, rootKey)

    loginEl.style.display = 'none'
    chatEl.style.display  = 'flex'
    document.getElementById('my-name').textContent = `(${username})`

    // ── Reactive message list ──────────────────────────────────────────────
    //
    // Each repo has its own internal Recaller, so repo.get() inside a mount
    // slot doesn't automatically re-trigger mount's recaller. bridgeRegistry
    // wires every repo (existing and future) into a single signal on the
    // chat recaller; dep() inside the slot subscribes to it. See design.md
    // §6 for the cross-recaller pattern.

    const recaller = new Recaller('chat')
    const { dep } = bridgeRegistry(registry, recaller, 'chat')

    // Auto-scroll to the bottom whenever any chunk arrives. Subscribing
    // via the same `dep` keeps it in lockstep with the mount slot — both
    // re-run when the bridge fires, the slot updates the DOM, and this
    // watcher schedules a post-layout scroll.
    recaller.watch('chat-scroll', () => {
      dep()
      requestAnimationFrame(() => { msgsEl.scrollTop = msgsEl.scrollHeight })
    })

    mount(h`${function messages () {
      dep()
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
      const preview = text.length > 50 ? text.slice(0, 50).trim() + '…' : text
      myRepo.defaultMessage = `"${preview}" (web)`
      myRepo.set({ name: username, messages: [...messages, { text, at: new Date() }] })
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
