/**
 * @file shared-note — the canonical recovery-UX demo.
 *
 * Single text field. Two browser tabs editing in real time. When two
 * pushes race, the relay arbitrates; one wins, the other gets
 * `pushRejected`; `repo.update`'s retry loop resyncs and re-applies.
 * When auto-resolution can't converge (sustained contention or a
 * resync race), `recoveryStuck` fires and the resolve UI appears.
 *
 * The UX is one view. *"Edited locally and couldn't push"* and
 * *"saved but the relay raced you"* are the same case — both
 * surface as recoveryStuck, both show their-value-vs-yours side by
 * side, both resolve by calling `repo.update(() => userChoice)`.
 * That's the architecture promise made visible at the app layer.
 *
 * Open two tabs, log in (same creds in both for the canonical
 * same-identity-two-devices conflict; different creds for two
 * peers' Records but no contention). Edit. Save in both. Watch.
 */
import { h, handle } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { Signer } from '../../streamo/Signer.js'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { StreamoRecord } from '../../streamo/StreamoRecord.js'
import { WritableStreamoRecord } from '../../streamo/WritableStreamoRecord.js'
import { StreamoRecordRegistry } from '../../streamo/StreamoRecordRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { liveObject } from '../../streamo/LiveSource.js'
import { bytesToHex } from '../../streamo/utils.js'

const recaller = new Recaller('shared-note')
const ui = liveObject({ phase: 'login', username: null, connected: false, saving: false }, { recaller })

let myRepo

async function login (e) {
  e.preventDefault()
  const f = e.target
  const username = f.elements.username.value.trim()
  const password = f.elements.password.value.trim()
  if (!username || !password) return
  f.elements.username.disabled = f.elements.password.disabled = true

  const signer = new Signer(username, password, 1)
  const { publicKey } = await signer.keysFor('shared-note')
  const myKey = bytesToHex(publicKey)

  // Writable for own key (we author); slim for anyone we subscribe to
  // (e.g., if the URL ever pointed at someone else's note in a future
  // version). The type-level guard from 11.0 keeps observer Records
  // from accidentally pushing.
  const registry = new StreamoRecordRegistry({
    recaller,
    factory: key => key === myKey
      ? new WritableStreamoRecord({ recaller })
      : new StreamoRecord({ recaller })
  })

  const port = +location.port || (location.protocol === 'https:' ? 443 : 80)
  const session = await registrySync(registry, location.hostname, port, {
    onConnectionChange: c => ui.set('connected', c)
  })
  myRepo = await session.subscribe(myKey)
  myRepo.attachSigner(signer, 'shared-note')
  myRepo.defaultMessage = `edit by ${username}`
  // Make the repo inspectable from the devtools console.
  window.sharedNoteRepo = myRepo

  // Path-based sets fire path-specific mutations; the view's `ui.get('phase')`
  // etc. subscribe to those specific keys. A whole-object `ui.set({...})`
  // would fire only the '__root__' key and these path-based readers wouldn't
  // wake. (Documented in LiveSource.js's set() — footgun worth respecting.)
  ui.set('username', username)
  ui.set('connected', true)
  ui.set('saving', false)
  ui.set('phase', 'editor')
}

async function save (e) {
  e.preventDefault()
  const text = e.target.elements.text.value
  ui.set('saving', true)
  try {
    await myRepo.update(c => ({ ...(c ?? {}), text, lastEditedBy: ui.get('username') }))
  } catch {
    // recoveryStuck has fired; the view re-renders to show the
    // resolve UI. No need to do anything else here.
  } finally {
    ui.set('saving', false)
  }
}

async function chooseValue (text) {
  // The "retry now" semantic: repo.update IS the retry verb. A fresh
  // call clears recoveryStuck on entry; if it succeeds, the resolve
  // UI naturally hides; if it exhausts again, the UI re-renders.
  ui.set('saving', true)
  try {
    await myRepo.update(c => ({ ...(c ?? {}), text, lastEditedBy: ui.get('username') }))
  } catch {
    // recoveryStuck set again; user will resolve again.
  } finally {
    ui.set('saving', false)
  }
}

function loginView () {
  return h`<main class="login">
    <h1>shared note</h1>
    <p>log in with anyone you want. same creds in another tab = the canonical conflict demo.</p>
    <form onsubmit=${handle(login)}>
      <input name="username" placeholder="username" autofocus>
      <input name="password" placeholder="password" type="password">
      <button type="submit">join</button>
    </form>
  </main>`
}

function editorView () {
  const stuck = myRepo.recoveryStuck
  const value = myRepo.get() ?? {}
  const connected = ui.get('connected')
  const saving = ui.get('saving')

  if (stuck) {
    // The resolve UI. Two values side by side; user picks which to
    // keep. The "yours" value is whatever the user's last attempt
    // tried to push, decoded from pushRejected.dataAddress.
    let yourRejected = null
    const dataAddr = stuck.pushRejected?.dataAddress
    if (dataAddr != null) {
      try { yourRejected = myRepo.decode(dataAddr) } catch {}
    }
    return h`<main class="editor">
      <h1>shared note · ${ui.get('username')}</h1>
      <div class="resolve">
        <h2>your edit didn't make it through</h2>
        <p>somebody (maybe you, in another tab) saved before you. choose which to keep:</p>
        <div class="choice theirs">
          <h3>their version (current truth)</h3>
          <pre>${value.text ?? '(empty)'}</pre>
          <p class="who">last edited by ${value.lastEditedBy ?? 'someone'}</p>
          <button onclick=${handle(() => chooseValue(value.text ?? ''))}>use theirs</button>
        </div>
        <div class="choice yours">
          <h3>your unsaved edit</h3>
          <pre>${yourRejected?.text ?? '(your unsaved value isn\'t decodable — paste it back if you have it)'}</pre>
          <button onclick=${handle(() => chooseValue(yourRejected?.text ?? ''))}>use yours</button>
        </div>
      </div>
    </main>`
  }

  return h`<main class="editor">
    <h1>shared note · ${ui.get('username')}</h1>
    <form onsubmit=${handle(save)}>
      <textarea name="text" autofocus>${value.text ?? ''}</textarea>
      <p class="meta">last edited by ${value.lastEditedBy ?? '—'} · <span class="status ${connected ? '' : 'disconnected'}">${connected ? 'connected' : 'reconnecting…'}</span></p>
      <div class="row">
        <button type="submit" disabled=${saving}>${saving ? 'saving…' : 'save'}</button>
        <span class="muted">tip: open another tab as same user, both edit, both save — watch the resolve UI appear</span>
      </div>
    </form>
  </main>`
}

function view () {
  return ui.get('phase') === 'login' ? loginView() : editorView()
}

mount(view, document.body, recaller)
