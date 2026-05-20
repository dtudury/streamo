// streamo chat — one room, everyone with credentials joins. The
// app's whole UI lives in the `mount(...)` call at the bottom: login
// form, the chat panel, and the inline <style>. Pre-login → the form
// is shown; post-login → the chat panel takes over. The `loggedIn`
// liveValue is what flips between them.
//
// Style preferences for streamo apps live in `dear-future-claudes.md`
// at the project root; this file follows them.

import { h }              from '../../streamo/h.js'
import { mount }          from '../../streamo/mount.js'
import { Signer }         from '../../streamo/Signer.js'
import { Recaller }       from '../../streamo/utils/Recaller.js'
import { RepoRegistry }   from '../../streamo/RepoRegistry.js'
import { registrySync }   from '../../streamo/registrySync.js'
import { liveValue }      from '../../streamo/LiveSource.js'
import { bytesToHex }     from '../../streamo/utils.js'

const { primaryKeyHex: rootKey } = await fetch('/api/info').then(r => r.json())

// `when(cond, vnode)` — render `vnode` when cond() is truthy.
const when = (cond, vnode) => () => cond() ? vnode : null

// ── state ────────────────────────────────────────────────────────────

const recaller = new Recaller('chat')

// Two single-value LiveSources: a boolean for "are we logged in" (flips
// the mount between the login form and the chat panel) and a string
// for the login status message (shown under the form during connect).
const loggedIn    = liveValue(false, { recaller, name: 'loggedIn' })
const loginStatus = liveValue('',    { recaller, name: 'loginStatus' })

// Post-login state, written once during login and read thereafter.
// They're plain lets because they don't change after login completes —
// the slots that read them are only created when loggedIn flips to
// true, so closure capture is fine.
let myKey, myName, myRepo, registry, session

// ── helpers ──────────────────────────────────────────────────────────

const fmt = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

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
  const diff  = (today - that) / 86400000
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

// ── handlers ─────────────────────────────────────────────────────────

async function login (e) {
  e.preventDefault()
  const f = e.target
  const username = f.elements.username.value.trim()
  const password = f.elements.password.value.trim()
  if (!username || !password) {
    loginStatus.set('enter username and password')
    return
  }

  f.elements.username.disabled = f.elements.password.disabled = true
  loginStatus.set('connecting…')

  try {
    const signer = new Signer(username, password, 1)
    const { publicKey } = await signer.keysFor('chat')
    myKey  = bytesToHex(publicKey)
    myName = username
    registry = new RepoRegistry(undefined, { recaller, name: 'chat' })

    // Track who we've already announced ourselves back to, so we don't
    // ping-pong forever. Without this set, every peer-back ricochets into
    // another peer-back and so on.
    const announcedTo = new Set()
    session = await registrySync(registry, location.hostname, +location.port || (location.protocol === 'https:' ? 443 : 80), {
      follow: (keyHex, repo, subscribe) => {
        for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
      },
      // When a peer announces, subscribe to them AND announce ourselves
      // back so they learn we exist — pure real-time fan-out peer
      // discovery, no server-side member tracking required.
      onAnnounce: key => {
        session.subscribe(key)
        if (!announcedTo.has(key)) {
          announcedTo.add(key)
          session.announce(myKey, rootKey)
        }
      }
    })

    myRepo = await registry.open(myKey)
    myRepo.attachSigner(signer, 'chat')
    myRepo.defaultMessage = `joined as ${username} (web)`

    session.interest(rootKey)
    session.announce(myKey, rootKey)

    // Auto-scroll to the bottom whenever a message arrives. The watcher
    // wakes on new-repo opens (iteration) and each repo's chunk
    // arrivals (the byteLength read).
    recaller.watch('chat-scroll', () => {
      for (const [, repo] of registry) repo.byteLength
      requestAnimationFrame(() => {
        const el = document.getElementById('messages')
        if (el) el.scrollTop = el.scrollHeight
      })
    })

    // Flip the login signal — the mount template's `when(loggedIn, …)`
    // clauses fire, the login form unmounts, the chat panel takes over.
    loggedIn.set(true)
  } catch (err) {
    loginStatus.set(`error: ${err.message}`)
    f.elements.username.disabled = f.elements.password.disabled = false
  }
}

function send (e) {
  e.preventDefault()
  const f = e.target
  const input = f.elements.text
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  const messages = myRepo.get('messages') ?? []
  const preview = text.length > 50 ? text.slice(0, 50).trim() + '…' : text
  myRepo.defaultMessage = `"${preview}" (web)`
  myRepo.set({ name: myName, messages: [...messages, { text, at: new Date() }] })
  input.focus()
}

// ── mount ────────────────────────────────────────────────────────────

mount(h`
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    :root {
      font-family: system-ui, sans-serif;
      font-size: 15px;
      --bg: #f5f5f5;
      --surface: #fff;
      --accent: #1d4ed8;
      --border: #ddd;
    }
    body {
      background: var(--bg);
      height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Brand lockup: clickable mark + wordmark linking home, with a
       lighter page-title beside it. Same pattern in login and chat
       headers so the relationship reads consistently. */
    .brand-lockup { display: inline-flex; align-items: center; gap: .4rem; color: inherit; text-decoration: none; font-weight: 600 }
    .brand-lockup:hover { opacity: .8 }
    .page-title { font-weight: 400; color: #888; letter-spacing: .04em }
    .page-title::before { content: '· '; opacity: .5 }

    /* Login */
    .login {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 2rem;
      width: min(360px, 90vw);
      display: flex;
      flex-direction: column;
      gap: .75rem;
    }
    .login h1 { font-size: 1.2rem; font-weight: 600; display: flex; align-items: center; gap: .4rem }
    .login h1 img { width: 1.4rem; height: 1.4rem }
    .login input {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: .5rem .75rem;
      font-size: 1rem;
      width: 100%;
    }
    .login button {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: .6rem;
      font-size: 1rem;
      cursor: pointer;
    }
    .login button:hover { opacity: .85 }
    .login .status { font-size: .8rem; color: #666; min-height: 1.2em }

    /* Chat */
    .chat {
      display: flex;
      flex-direction: column;
      width: min(600px, 100vw);
      height: 100dvh;
      background: var(--surface);
    }
    .chat-header {
      padding: .75rem 1rem;
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      font-size: .95rem;
      display: flex;
      gap: .5rem;
      align-items: center;
    }
    .chat-header img { width: 1.1rem; height: 1.1rem }
    .chat-header .my-name { font-size: .75rem; font-weight: 400; color: #888 }
    /* My color swatch in the header — a small chip that matches the
       accent strip on my own messages. Identity-as-color, deterministic
       from publicKey. */
    .my-swatch {
      display: inline-block;
      width: .65rem;
      height: .65rem;
      border-radius: 2px;
      background: hsl(var(--my-hue, 220), 55%, 45%);
      margin-left: .15rem;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: .35rem;
    }

    /* Message bubbles. Every sender has a stable hue derived from their
       publicKey — same key always renders in the same color, deterministic.
       Visual identity = cryptographic identity. Position (left/right)
       carries the mine-vs-theirs cue; color carries the whose-specifically
       cue. */
    .msg {
      max-width: 75%;
      padding: .45rem .7rem;
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 10px;
      line-height: 1.4;
      word-break: break-word;
    }
    .msg.mine   { align-self: flex-end;   border-bottom-right-radius: 3px; border-right: 3px solid hsl(var(--peer-hue, 220), 55%, 45%) }
    .msg.theirs { align-self: flex-start; border-bottom-left-radius: 3px;  border-left:  3px solid hsl(var(--peer-hue, 220), 55%, 45%) }
    .msg .sender { font-size: .7rem; font-weight: 600; margin-bottom: .2rem; color: hsl(var(--peer-hue, 220), 55%, 35%) }
    .msg .text { font-size: .95rem }
    .msg .time { font-size: .65rem; opacity: .5; margin-top: .2rem; text-align: right }

    /* Date separator between messages from different days. Quiet center
       label, hairlines on either side. */
    .date-sep {
      display: flex;
      align-items: center;
      gap: .6rem;
      margin: .5rem 0 .25rem;
      font-size: .7rem;
      color: #999;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .date-sep::before, .date-sep::after { content: ''; flex: 1; height: 1px; background: var(--border) }

    /* Empty state when the room has no messages from anyone (including you). */
    .empty-state { margin: auto; text-align: center; color: #888; font-size: .85rem; padding: 2rem; line-height: 1.6 }
    .empty-state strong { color: #555 }

    /* Sync warning — appears when a repo's verifier-gate has rejected
       incoming chunks. forkDetected (multi-device write conflict) and
       verificationFailed (attack/corruption) get visually distinct
       palettes so the user can tell the two threats apart at a glance. */
    .sync-warning {
      padding: .6rem 1rem;
      border-bottom: 1px solid var(--border);
      font-size: .8rem;
      line-height: 1.4;
      display: flex;
      gap: .5rem;
      align-items: flex-start;
    }
    .sync-warning.fork {
      background: #fff3cd;   /* warm yellow — "you forked, here's what to do" */
      color: #664d03;
      border-bottom-color: #ffe69c;
    }
    .sync-warning.attack {
      background: #f8d7da;   /* alarm red — "something is wrong, drop the peer" */
      color: #58151c;
      border-bottom-color: #f1aeb5;
    }
    .sync-warning .icon { flex: 0 0 auto; font-weight: 700 }
    .sync-warning .body { flex: 1 }
    .sync-warning .body strong { font-weight: 600 }

    .input-row { display: flex; gap: .5rem; padding: .75rem; border-top: 1px solid var(--border) }
    .input-row input {
      flex: 1;
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: .5rem 1rem;
      font-size: .95rem;
      outline: none;
    }
    .input-row input:focus { border-color: var(--accent) }
    .input-row button {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 50%;
      width: 38px;
      height: 38px;
      cursor: pointer;
      font-size: 1.1rem;
      flex-shrink: 0;
    }
    .input-row button:hover { opacity: .85 }
  </style>

  ${when(() => !loggedIn.get(), h`
    <form class="login" onsubmit=${() => login}>
      <h1>
        <a class="brand-lockup" href="/" title="streamo home">
          <img src="/streamo.svg" alt="">streamo
        </a>
        <span class="page-title">chat</span>
      </h1>
      <input name="username" placeholder="username" autocomplete="username" autofocus>
      <input name="password" type="password" placeholder="password" autocomplete="current-password">
      <button>join</button>
      <div class="status">${() => loginStatus.get()}</div>
    </form>
  `)}

  ${when(loggedIn.get, h`
    <div class="chat" style=${() => `--my-hue: ${hueForKey(myKey)}`}>
      <div class="chat-header">
        <a class="brand-lockup" href="/" title="streamo home">
          <img src="/streamo.svg" alt="">streamo
        </a>
        <span class="page-title">chat</span>
        <span class="my-name">(${() => myName})</span>
        <span class="my-swatch" title="your color — derived from your key"></span>
      </div>
      ${() => {
        // Sync warning slot — re-fires when any open repo raises a verifier
        // flag. The two flags are surfaced separately because the right
        // response differs: forkDetected wants a merge (or at minimum a
        // reload to re-sync), verificationFailed wants the peer dropped.
        let forkedMine = false
        let forkedOther = 0
        let badSig = 0
        for (const [keyHex, repo] of registry) {
          if (repo.forkDetected) {
            if (keyHex === myKey) forkedMine = true
            else forkedOther++
          }
          if (repo.verificationFailed) badSig++
        }
        if (!forkedMine && !forkedOther && !badSig) return null
        if (badSig) {
          return h`<div class="sync-warning attack" data-key="warn-attack">
            <span class="icon">⚠</span>
            <div class="body">
              <strong>bad signature received.</strong>
              ${badSig === 1 ? 'a peer sent bytes that did not crypto-verify.' : `${badSig} peers sent bytes that did not crypto-verify.`}
              the connection has been dropped — refresh if this persists.
            </div>
          </div>`
        }
        return h`<div class="sync-warning fork" data-key="warn-fork">
          <span class="icon">⑂</span>
          <div class="body">
            ${forkedMine
              ? h`<strong>you've written from two places at once.</strong> another tab or device signed in with these credentials wrote while this one did — the histories have diverged. refresh to load the merged state.`
              : h`<strong>a peer has forked.</strong> ${forkedOther === 1 ? 'one other repo' : `${forkedOther} other repos`} in this room ${forkedOther === 1 ? 'has' : 'have'} diverged across devices.`}
          </div>
        </div>`
      }}
      <div id="messages">${() => {
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
            nodes.push(h`<${DateSep} data-key=${`date-${dayKey}`} label=${dateLabel(d)} dayKey=${dayKey}/>`)
            lastDay = dayKey
          }
          nodes.push(h`<${Msg} data-key=${`msg-${+m.at}-${m.mine ? 'me' : m.name}`} name=${m.name} text=${m.text} at=${m.at} mine=${m.mine} hue=${m.hue}/>`)
        }
        return nodes
      }}</div>
      <form class="input-row" onsubmit=${() => send}>
        <input name="text" placeholder="message…" autocomplete="off" autofocus>
        <button>↑</button>
      </form>
    </div>
  `)}
`, document.body, recaller)
