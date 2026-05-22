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

// True while the relay socket is live. registrySync reconnects on its own;
// this just flips so the header can show "reconnecting…" while it works.
// Messages typed while offline are written locally and flush on reconnect.
const connected   = liveValue(true,  { recaller, name: 'connected' })

// Post-login state, written once during login and read thereafter.
// They're plain lets because they don't change after login completes —
// the slots that read them are only created when loggedIn flips to
// true, so closure capture is fine.
let myKey, myName, myRepo, registry, session
// Recovery orchestration handle — set inside login(), called by the
// banner's [Send it now] / [Discard] buttons when the user wants to
// reconcile pushRejected or conflictDetected.
let onRecover = null

// Presence: peer key → last time we saw them announce. The wire carries
// no "peer left" signal, so the dot reads presence by staleness — green
// while announces keep landing, gray once they've been quiet. `presence`
// is a plain object; `presenceTick` is the reactive heartbeat that makes
// the dot re-check staleness as time passes.
const presence = {}
const presenceTick = liveValue(0, { recaller, name: 'presenceTick' })

// Merge function for chat's value shape: concatenate two message lists
// (current relay state + the rejected local writes), dedupe by `at`
// timestamp, return a clean { name, messages: [...] } value. Other apps
// would write their own merge for their value shape.
function mergeChatValue (current, rejected) {
  const seen = new Map()
  for (const m of (current?.messages ?? [])) {
    if (m?.at != null) seen.set(+m.at, m)
  }
  for (const m of (rejected?.messages ?? [])) {
    if (m?.at != null && !seen.has(+m.at)) seen.set(+m.at, m)
  }
  return {
    name: current?.name ?? rejected?.name ?? myName,
    messages: [...seen.values()].sort((a, b) => +a.at - +b.at)
  }
}

// Handler wrappers used by the banner buttons. They route through the
// `onRecover` closure which login() populates — that's where the
// session + registry + myRepo are all in scope.
const handleSend    = () => onRecover?.('merge')
const handleDiscard = () => onRecover?.('discard')

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

// ── the ding ─────────────────────────────────────────────────────────
// A short synthesized chime when a message lands — Web Audio, so there's
// no asset to bundle or serve. Two sine partials a fifth apart, fast
// attack + exponential decay = a little bell. `armAudio()` runs from the
// login click (a real user gesture) so the AudioContext is unlocked
// before any message arrives — browsers won't let audio start otherwise.
let audioCtx = null
function armAudio () {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
  } catch { /* no Web Audio — the room still works, just silently */ }
}
function playDing () {
  if (!audioCtx) return
  if (audioCtx.state === 'suspended') audioCtx.resume()
  const t0 = audioCtx.currentTime
  for (const [freq, delay] of [[880, 0], [1320, 0.09]]) {
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, t0 + delay)
    gain.gain.linearRampToValueAtTime(0.2, t0 + delay + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.9)
    osc.connect(gain).connect(audioCtx.destination)
    osc.start(t0 + delay)
    osc.stop(t0 + delay + 1)
  }
}

// ── web push ─────────────────────────────────────────────────────────
// The ding needs the tab focused; Web Push does not. The service worker
// (/sw.js) shows an OS notification on a `push` from the relay, even
// with no tab open. setupPush opts this browser in — permission,
// subscription, and handing the subscription to the relay.

// VAPID's applicationServerKey wants raw bytes; the relay serves the key
// base64url-encoded, so decode it.
function urlB64ToUint8Array (base64url) {
  const padded = base64url.padEnd(Math.ceil(base64url.length / 4) * 4, '=')
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

// Subscribe this browser to Web Push for the room. `permission` is the
// promise login() kicked off inside the click gesture (browsers require
// a gesture to ask). All best-effort: push is an enhancement — if it's
// unsupported, declined, or the relay has no VAPID key, the room works
// exactly as before, just without OS notifications.
async function setupPush (myKey, permission) {
  try {
    if ((await permission) !== 'granted') return
    const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    await navigator.serviceWorker.ready
    const { key: vapidKey } = await fetch('/api/push/key').then(r => r.json()).catch(() => ({}))
    if (!vapidKey) return  // relay has push disabled
    const sub = await reg.pushManager.getSubscription()
      ?? await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(vapidKey)
      })
    // Hand the subscription to the relay, tagged with our chat key so it
    // can skip notifying us of our own messages. Re-sent on every login,
    // so a relay that restarted (and lost its store) re-learns us.
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), key: myKey })
    })
    console.log('[chat] push notifications on')
  } catch (err) {
    console.warn('[chat] push setup skipped:', err.message)
  }
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
  // Unlock audio while we're still inside the click that submitted the
  // form — a later, gesture-less AudioContext would start suspended.
  armAudio()
  // Ask for notification permission now, while the login click is still
  // a live user gesture (browsers require one). The answer is awaited
  // later by setupPush, once we have a key to subscribe with.
  const pushPermission = ('Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window)
    ? (Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission))
    : Promise.resolve('unsupported')

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
      onConnectionChange: c => connected.set(c),
      follow: (keyHex, repo, subscribe) => {
        for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
      },
      // When a peer announces, subscribe to them AND announce ourselves
      // back so they learn we exist — pure real-time fan-out peer
      // discovery, no server-side member tracking required.
      onAnnounce: key => {
        presence[key] = Date.now()  // feeds the presence dot
        session.subscribe(key)
        if (!announcedTo.has(key)) {
          announcedTo.add(key)
          session.announce(myKey, rootKey)
        }
      }
    })

    // session.subscribe opens the Repo locally AND plumbs it to the wire,
    // so the relay starts streaming our own history down to this tab.
    // Without going through session.subscribe (or having it tripped via
    // another tab's announce), our own bytes would sit unsynced.
    myRepo = await session.subscribe(myKey)
    myRepo.attachSigner(signer, 'chat')
    myRepo.defaultMessage = `joined as ${username} (web)`
    // Expose for manual archive surgery — the relay stores per-key as
    // `.streamo/<myKey>.bin`. Logged at INFO so it's visible without
    // turning on verbose channels.
    console.log(`[chat] my key: ${myKey}`)
    console.log(`[chat] archive file: .streamo/${myKey}.bin`)
    window.streamoMyKey = myKey
    window.streamoMyRepo = myRepo

    session.interest(rootKey)
    session.announce(myKey, rootKey)

    // Recovery orchestration — invoked by the banner buttons when the
    // user wants to reconcile pushRejected or conflictDetected. The
    // closure captures `session` (let — replaceable) and the connection
    // params + signer so we can stand up a fresh session from scratch.
    onRecover = async (mode) => {
      const flag = myRepo.pushRejected ?? myRepo.conflictDetected
      let rejectedValue = null
      if (flag?.dataAddress != null) {
        try { rejectedValue = myRepo.decode(flag.dataAddress) } catch {}
      }
      // Wipe local state (bytes + flags) and tear down the old WS so the
      // fresh sync starts from a clean empty Repo.
      myRepo._reset()
      // session.close() — not session.ws.close() — so the old session
      // doesn't auto-reconnect and race the fresh one we build below.
      session.close()
      const freshAnnouncedTo = new Set()
      session = await registrySync(registry, location.hostname, +location.port || (location.protocol === 'https:' ? 443 : 80), {
        onConnectionChange: c => connected.set(c),
        follow: (keyHex, repo, subscribe) => {
          for (const memberKey of repo.get('members') ?? []) subscribe(memberKey)
        },
        onAnnounce: key => {
          session.subscribe(key)
          if (!freshAnnouncedTo.has(key)) {
            freshAnnouncedTo.add(key)
            session.announce(myKey, rootKey)
          }
        }
      })
      await session.subscribe(myKey)
      session.interest(rootKey)
      session.announce(myKey, rootKey)
      // Brief settle window for the relay's bytes to land. If it's not
      // enough (and our merge races with another peer's push), the push
      // gets rejected again and the banner re-appears — click again,
      // same flow. No exponential retry loop here on purpose.
      await new Promise(r => setTimeout(r, 400))
      if (mode === 'merge' && rejectedValue) {
        const currentValue = myRepo.get() ?? { name: myName, messages: [] }
        myRepo.set(mergeChatValue(currentValue, rejectedValue))
      }
    }

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

    // Ding when a message lands from anyone but me — this is what lets
    // you step away from the keyboard. The early runs (while the relay
    // streams history down) only set the baseline; a 2.5s arm window
    // suppresses dings until that initial sync settles, so opening the
    // room doesn't chime once per backlogged message.
    let lastDingCount = null
    const dingArmedAt = Date.now() + 2500
    recaller.watch('chat-ding', () => {
      let count = 0
      for (const [keyHex, repo] of registry) {
        repo.byteLength  // register the chunk-arrival dependency
        if (keyHex === myKey || keyHex === rootKey) continue
        count += (repo.get('messages') ?? []).length
      }
      if (lastDingCount !== null && count > lastDingCount && Date.now() > dingArmedAt) {
        playDing()
      }
      lastDingCount = count
    })

    // Presence heartbeat — re-evaluate the dot's staleness every 4s, so
    // Claude's dot grays on its own ~30s after her announce heartbeat
    // stops, with no event needed.
    setInterval(() => presenceTick.set(Date.now()), 4000)

    // Opt this browser into Web Push — OS notifications when a message
    // lands with no tab open. Best-effort, fire-and-forget (see setupPush).
    setupPush(myKey, pushPermission)

    // Flip the login signal — the mount template's `when(loggedIn, …)`
    // clauses fire, the login form unmounts, the chat panel takes over.
    // Blur first so the username input doesn't linger as the document's
    // focused element after detach — without this, the chat's text input
    // autofocus gets blocked ("a document already has a focused element").
    document.activeElement?.blur?.()
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
    /* Claude's presence dot — pushed to the right edge of the header.
       Green while her watcher's announce heartbeat is landing; gray once
       it's been quiet ~30s. The dot IS the reply window. */
    .presence {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: .3rem;
      font-size: .75rem;
      font-weight: 400;
      color: #999;
    }
    .presence-dot {
      width: .6rem;
      height: .6rem;
      border-radius: 50%;
      background: #ccc;
    }
    .presence.present { color: #16a34a; }
    .presence.present .presence-dot {
      background: #16a34a;
      box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.18);
    }
    /* Self-connection state — amber while registrySync's backoff loop
       works. Quiet by design: messages typed offline flush on reconnect. */
    .reconnecting {
      font-size: .72rem;
      font-weight: 500;
      color: #b45309;
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

    /* Sync warning — appears when a repo's chain has an issue:
       pushRejected (relay refused our push) or conflictDetected (our
       local push-in-flight collided with incoming relay bytes). */
    .sync-warning {
      padding: .6rem 1rem;
      border-bottom: 1px solid var(--border);
      font-size: .8rem;
      line-height: 1.4;
      display: flex;
      gap: .5rem;
      align-items: flex-start;
    }
    .sync-warning.conflict {
      background: #fff3cd;   /* warm yellow — "your chains diverged, here's what to do" */
      color: #664d03;
      border-bottom-color: #ffe69c;
    }
    .sync-warning .icon { flex: 0 0 auto; font-weight: 700 }
    .sync-warning .body { flex: 1 }
    .sync-warning .body strong { font-weight: 600 }
    .banner-actions { display: flex; gap: .5rem; margin-top: .5rem }
    .banner-actions button {
      background: transparent;
      border: 1px solid #664d03;
      color: #664d03;
      border-radius: 4px;
      padding: .25rem .6rem;
      font-size: .78rem;
      cursor: pointer;
      font-family: inherit;
    }
    .banner-actions button:hover { background: rgba(102, 77, 3, 0.1) }
    .banner-actions button.discard { opacity: .7 }
    .banner-actions button.discard:hover { opacity: 1 }

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
        ${() => connected.get()
          ? null
          : h`<span class="reconnecting" data-key="reconnecting">⟳ reconnecting…</span>`}
        ${() => {
          // Claude's presence dot. No "peer left" signal exists on the
          // wire, so presence is read by staleness: green while watch.js's
          // announce heartbeat keeps landing, gray ~30s after it stops.
          // The dot IS the reply window — green means a reply reaches her.
          const now = presenceTick.get() || Date.now()
          let claudeKey = null
          for (const [keyHex, repo] of registry) {
            if (repo.get('name') === 'claude') claudeKey = keyHex
          }
          if (!claudeKey) return null
          const seen = presence[claudeKey]
          const present = seen != null && now - seen < 30000
          return h`<span class=${['presence', present ? 'present' : 'away']}
                         title=${present ? 'Claude is here — a reply will reach her' : 'Claude is away — no live session'}>
            <span class="presence-dot"></span>claude
          </span>`
        }}
      </div>
      ${() => {
        // Sync warning slot — re-fires when any open repo raises a flag.
        // Two signals, surfaced in priority order:
        //   pushRejected     — the relay explicitly refused our push
        //                      (most reliable; relay said no)
        //   conflictDetected — local receiver caught a push-in-flight race
        //                      (alignment failure on incoming bytes)
        let pushRejectedMine = false
        let conflictMine = false
        let conflictOther = 0
        for (const [keyHex, repo] of registry) {
          if (repo.pushRejected && keyHex === myKey) pushRejectedMine = true
          if (repo.conflictDetected) {
            if (keyHex === myKey) conflictMine = true
            else conflictOther++
          }
        }
        const myConflict = pushRejectedMine || conflictMine
        if (!myConflict && !conflictOther) return null
        return h`<div class="sync-warning conflict" data-key="warn-conflict">
          <span class="icon">⑂</span>
          <div class="body">
            ${myConflict
              ? h`<strong>your last write didn't reach the room.</strong>
                ${pushRejectedMine
                  ? ' the relay refused it — another tab or device pushed in first.'
                  : ' another tab or device signed in with these credentials wrote at the same time.'}
                <div class="banner-actions">
                  <button onclick=${() => handleSend}>send it now</button>
                  <button class="discard" onclick=${() => handleDiscard}>discard</button>
                </div>`
              : h`<strong>a peer's chain has diverged.</strong> ${conflictOther === 1 ? 'one other repo' : `${conflictOther} other repos`} in this room ${conflictOther === 1 ? 'has' : 'have'} conflicting writes across devices.`}
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
