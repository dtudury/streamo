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

// Stable hue derived from a publicKey hex — same key always renders in
// the same color, everywhere, for everyone. The streamo answer to
// "how do I tell who's talking?" is identity-as-color: your color is
// derived from the same keypair that signs your messages. Avoids the
// 30-60° band (greens/yellows that read poorly on light backgrounds)
// by stretching into a 300° usable range centered on blues/purples/
// reds/oranges.
function hueForKey (keyHex) {
  let h = 0
  for (let i = 0; i < keyHex.length; i++) h = (h * 31 + keyHex.charCodeAt(i)) >>> 0
  return (h % 300 + 30) % 360
}

// Group label for a date — "today" / "yesterday" / weekday for the
// current week / locale-formatted for older messages. Used by the
// date-separator inserts in the message list.
function dateLabel (d) {
  const now = new Date()
  const startOfDay = (x) => { const c = new Date(x); c.setHours(0,0,0,0); return c.getTime() }
  const today = startOfDay(now)
  const that  = startOfDay(d)
  const dayMs = 86400000
  const diff  = (today - that) / dayMs
  if (diff === 0) return 'today'
  if (diff === 1) return 'yesterday'
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: now.getFullYear() === d.getFullYear() ? undefined : 'numeric' })
}

function Msg ({ name, text, at, mine, hue }) {
  // +at coerces both Date and number to ms — stable key across old (number)
  // and new (Date) message records as we transition.
  return h`
    <div class=${['msg', mine ? 'mine' : 'theirs']} data-key=${+at} style=${`--peer-hue: ${hue}`}>
      ${!mine ? h`<div class="sender">${name}</div>` : null}
      <div class="text">${text}</div>
      <div class="time">${fmt(at)}</div>
    </div>
  `
}

function DateSep ({ label, dayKey }) {
  return h`<div class="date-sep" data-key=${`date-${dayKey}`}>${label}</div>`
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
    const recaller = new Recaller('chat')
    const registry = new RepoRegistry(undefined, { recaller, name: 'chat' })

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
    // Light up my-swatch with my own hue — the same color my messages
    // wear in the stream. Done via a CSS custom property on the chat
    // root so the swatch's hsl() expression picks it up.
    document.getElementById('chat').style.setProperty('--my-hue', hueForKey(myKey))

    // ── Reactive message list ──────────────────────────────────────────────
    //
    // The registry shares our Recaller (passed in at construction
    // above) so reading any repo's state inside a slot re-runs the
    // slot on chunk arrival. dep() subscribes to that bridge signal.

    const { dep } = registry

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
          all.push({ name, text, at, mine: keyHex === myKey, hue: hueForKey(keyHex) })
        }
      }
      all.sort((a, b) => (+a.at) - (+b.at))
      if (all.length === 0) {
        return h`<div class="empty-state" data-key="empty">
          <strong>this room is quiet.</strong><br>
          send a message to start the conversation.
        </div>`
      }
      // Walk in order, emitting a date separator whenever the day rolls
      // over. dayKey is YYYY-MM-DD so the data-key stays stable for
      // mount's recycling.
      const nodes = []
      let lastDay = null
      for (const m of all) {
        const d = new Date(+m.at)
        const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (dayKey !== lastDay) {
          nodes.push(h`<${DateSep} label=${dateLabel(d)} dayKey=${dayKey}/>`)
          lastDay = dayKey
        }
        nodes.push(h`<${Msg} name=${m.name} text=${m.text} at=${m.at} mine=${m.mine} hue=${m.hue}/>`)
      }
      return nodes
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
