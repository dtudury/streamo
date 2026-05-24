// streamo todomvc — the canonical add/edit/complete/filter shape on top
// of a Repo. Same identity model as chat: username + password derives a
// keypair; your todos are stored under your own pubkey, at name='todomvc'.
// Open in two tabs as the same user → live sync. Different users get
// different lists. Append-only history, every edit signed.

import { h, handle }    from '../../streamo/h.js'
import { mount }        from '../../streamo/mount.js'
import { Signer }       from '../../streamo/Signer.js'
import { Recaller }     from '../../streamo/utils/Recaller.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { liveValue }    from '../../streamo/LiveSource.js'
import { liveLocation } from '../../streamo/liveLocation.js'
import { bytesToHex }   from '../../streamo/utils.js'

const { primaryKeyHex: rootKey } = await fetch('/api/info').then(r => r.json())

// ── state ────────────────────────────────────────────────────────────

const recaller = new Recaller('todomvc')

// Pre-login: a boolean and a status line, same shape as chat.
const loggedIn    = liveValue(false, { recaller, name: 'loggedIn' })
const loginStatus = liveValue('',    { recaller, name: 'loginStatus' })

// While editing a single todo inline (double-click on label → input
// replaces label), this holds that todo's id. null = nobody editing.
// Lives outside the Repo because it's per-tab UI state, not persisted.
const editingId = liveValue(null, { recaller, name: 'editingId' })

// URL hash drives both *which list* and *which filter* —
//   #/                          → no key → login screen
//   #/<keyHex>                  → that key's todos, "all" filter
//   #/<keyHex>/active           → that key's todos, "active" filter
//   #/<keyHex>/completed        → that key's todos, "completed" filter
//
// The key in the URL is the *list being viewed*, not necessarily the
// signed-in user. If you visit someone else's URL, you'll see their
// list read-only — writes only fire when the URL's key matches your
// signed-in key (the canWrite() check below).
//
// liveLocation gives us reactive reads of window.location without a
// separate hashchange listener; per-segment reads via `hashParts`
// mean only the slots that care about the changed segment re-render.
const loc = liveLocation({ recaller, name: 'location' })
const urlKey = () => {
  const k = loc.get('hashParts', 1)
  return (k && /^[0-9a-f]{66}$/.test(k)) ? k : null
}
const filterFromHash = () => {
  switch (loc.get('hashParts', 2)) {
    case 'active':    return 'active'
    case 'completed': return 'completed'
    default:          return 'all'
  }
}

// registry and session are created at module-load, not at login —
// reading other people's lists is signer-agnostic at this layer.
// myRepo/myKey/signer (only set after login) drive the *write* path;
// the *read* path goes through the URL key and viewedRepo().
const registry = new RepoRegistry(undefined, { recaller, name: 'todomvc' })
const session = await registrySync(registry, location.hostname, +location.port || (location.protocol === 'https:' ? 443 : 80))

// Auto-subscribe to whatever key shows up in the URL. Reads `urlKey()`
// (URL hashParts) and `registry.get(key)` (registry keys), so it
// refires on both nav and arrival and self-quiets once the bytes land.
// Same shape as today's explorer cold-link fix — and the reason a
// fresh visitor can paste a friend's URL and see the list immediately,
// without any login dance.
recaller.watch('todomvc-url-subscribe', () => {
  const k = urlKey()
  if (!k) return
  if (registry.get(k)) return
  session.subscribe(k)
})

let myRepo, myKey  // set after login; drive the write path
const canWrite = () => loggedIn.get() && urlKey() === myKey
const viewedRepo = () => {
  const k = urlKey()
  return k ? (registry.get(k) || null) : null
}

// ── handlers ─────────────────────────────────────────────────────────

async function login (e) {
  e.preventDefault()
  const f = e.target
  const username = f.elements.username.value.trim()
  const password = f.elements.password.value.trim()
  if (!username || !password) { loginStatus.set('enter username and password'); return }

  f.elements.username.disabled = f.elements.password.disabled = true
  loginStatus.set('signing in…')

  try {
    const signer = new Signer(username, password, 1)
    const { publicKey } = await signer.keysFor('todomvc')
    myKey = bytesToHex(publicKey)
    myRepo = await registry.open(myKey)
    myRepo.attachSigner(signer, 'todomvc')
    myRepo.defaultMessage = `signed in as ${username}`
    // Explicitly subscribe to our own key so the server replays any
    // archived bytes for this repo. The URL-watcher already handles
    // the visited list (which might be ours, or might be someone
    // else's) — this guarantees myKey is subscribed *regardless* of
    // what's in the URL, so writes can flow up and history can come
    // back from prior sessions.
    await session.subscribe(myKey)
    // If the URL doesn't already point at a valid key (fresh visit,
    // or user pasted a malformed URL), navigate to our own list. If
    // the URL DOES carry a key, leave it alone — the user is here to
    // view that specific list, even if it's not theirs.
    if (!urlKey()) loc.set('hash', `#/${myKey}`)
    loggedIn.set(true)
  } catch (err) {
    loginStatus.set(`error: ${err.message}`)
    f.elements.username.disabled = f.elements.password.disabled = false
  }
}

// Reads target the URL's Repo (viewedRepo), so visiting someone else's
// list shows their todos. Writes target *your own* Repo (myRepo) — and
// only fire when canWrite() (URL's key matches your signed-in key);
// the UI already hides write affordances in that case, but the guard
// here is the truth-of-the-matter safety net.
const getTodos = () => viewedRepo()?.get('todos') ?? []
const setTodos = (todos, msg) => {
  if (!canWrite()) return
  myRepo.defaultMessage = msg
  myRepo.set({ todos })
}

function addTodo (e) {
  e.preventDefault()
  const input = e.target.elements.text
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  setTodos([...getTodos(), { id: Date.now(), text, done: false }], `add "${text}"`)
}

const toggleTodo = id => setTodos(
  getTodos().map(t => t.id === id ? { ...t, done: !t.done } : t),
  `toggle todo ${id}`
)

const deleteTodo = id => setTodos(
  getTodos().filter(t => t.id !== id),
  `delete todo ${id}`
)

const clearCompleted = () => setTodos(
  getTodos().filter(t => !t.done),
  'clear completed'
)

const toggleAll = () => {
  const todos = getTodos()
  const allDone = todos.every(t => t.done)
  setTodos(todos.map(t => ({ ...t, done: !allDone })), allDone ? 'unmark all' : 'mark all done')
}

function saveEdit (e, id) {
  e.preventDefault()
  const text = e.target.elements.text.value.trim()
  if (!text) { deleteTodo(id); return }
  setTodos(getTodos().map(t => t.id === id ? { ...t, text } : t), `edit "${text}"`)
  editingId.set(null)
}

// Set editingId, then move the cursor to the end of existing text on the
// next frame. Focus itself is handled by mount honoring the `autofocus`
// attribute on the freshly-mounted .edit input — but autofocus brings the
// cursor to position 0, which is jarring for non-empty text. Standard
// TodoMVC behavior places the cursor at the end so the user can append
// immediately. Only one todo can be editing at a time, so the selector
// unambiguously finds it.
function startEdit (id) {
  editingId.set(id)
  requestAnimationFrame(() => {
    const input = document.querySelector('.edit')
    if (input) input.setSelectionRange(input.value.length, input.value.length)
  })
}

// Cancel on blur — clicking away (or tabbing out) discards the edit.
// Enter saves via the form's onsubmit; Escape cancels via the input's
// onkeydown. No global keydown listener needed.
const cancelEdit = () => editingId.set(null)

// ── view ─────────────────────────────────────────────────────────────

function TodoItem ({ todo, editable }) {
  const editing = editable && editingId.get() === todo.id
  const classes = [todo.done && 'completed', editing && 'editing'].filter(Boolean).join(' ')
  return h`
    <li class=${classes} data-key=${todo.id}>
      <div class="view">
        <input class="toggle" type="checkbox" checked=${todo.done} disabled=${!editable}
               onclick=${handle(() => toggleTodo(todo.id))}>
        <label ondblclick=${editable ? handle(() => startEdit(todo.id)) : null}>${todo.text}</label>
        ${editable ? h`<button class="destroy" onclick=${handle(() => deleteTodo(todo.id))}></button>` : null}
      </div>
      ${editing ? h`
        <form onsubmit=${handle(e => saveEdit(e, todo.id))}>
          <input class="edit" name="text" value=${todo.text}
                 onblur=${handle(cancelEdit)}
                 onkeydown=${handle(e => { if (e.key === 'Escape') cancelEdit() })}
                 autofocus>
        </form>
      ` : null}
    </li>
  `
}

// One persistent <section class="todoapp">. Inside it, the header's form
// swaps between login and new-todo via a single reactive slot; the
// main+footer below appears after login. Keeping the outer section
// stable means mount's recycler doesn't tear it down on the loggedIn
// flip — no flash, no focus loss, no inconsistent recycle behavior.
mount(h`
  <section class="todoapp">
    <header class="header">
      <h1>todos</h1>
      ${() => {
        if (!loggedIn.get()) {
          // Deep-link viewing: a URL key is in play and the visitor
          // hasn't signed in. The login form would be noisy here — they
          // came here to view data, not to sign in. Hide the login form
          // entirely; the "× close to login" affordance below offers
          // the exit path back to credential entry.
          if (urlKey()) return null
          return h`
            <form data-key="login-form" class="login" onsubmit=${handle(login)}>
              <input data-key="username" name="username" placeholder="username" autocomplete="username" autofocus>
              <input data-key="password" name="password" type="password" placeholder="password" autocomplete="current-password">
              <button>sign in</button>
              <div class="login-status">${() => loginStatus.get()}</div>
            </form>
          `
        }
        if (canWrite()) return h`
          <form data-key="new-todo-form" onsubmit=${handle(addTodo)}>
            <input data-key="new-todo" class="new-todo" name="text" placeholder="What needs to be done?" autofocus autocomplete="off">
          </form>
        `
        // Logged in, but viewing someone else's list (URL key !== myKey).
        // Surface what's being viewed and offer a one-click way back home.
        return h`
          <div data-key="viewing-other" class="viewing-other">
            viewing <code>${urlKey()?.slice(0, 10)}…</code> · read-only
            <a href=${`#/${myKey}`}>← back to your list</a>
          </div>
        `
      }}
    </header>

    ${() => !urlKey() || getTodos().length === 0 ? null : h`
      <section class="main">
        ${!loggedIn.get() ? h`
          <a class="close-to-login" data-key="close-to-login" href="#">
            <span>viewing <code>${urlKey()?.slice(0, 10)}…</code> · read-only</span>
            <span class="x">×</span>
          </a>
        ` : h`
          <input data-key="toggle-all" id="toggle-all" class="toggle-all" type="checkbox"
                 checked=${getTodos().every(t => t.done)} disabled=${!canWrite()}
                 onclick=${handle(toggleAll)}>
          <label data-key="toggle-all-label" for="toggle-all">Mark all as complete</label>
        `}
        <ul class="todo-list">${() => {
          const filter = filterFromHash()
          const editable = canWrite()
          const filtered = getTodos().filter(t =>
            filter === 'all' || (filter === 'active' ? !t.done : t.done)
          )
          // data-key on the function-component invocation enrolls each
          // TodoItem in mount's recycling pool — without it, every parent
          // re-render fresh-mounts all <li>s, destroying any in-progress
          // edit (focus, partial text). With the key, the existing <li>
          // is recycled and its inner DOM survives.
          return filtered.map(t => h`<${TodoItem} todo=${t} editable=${editable} data-key=${t.id}/>`)
        }}</ul>
      </section>
    `}

    ${() => !urlKey() || getTodos().length === 0 ? null : h`
      <footer class="footer">
        <span class="todo-count">${() => {
          const remaining = getTodos().filter(t => !t.done).length
          return h`<strong>${remaining}</strong> ${remaining === 1 ? 'item' : 'items'} left`
        }}</span>
        <ul class="filters">${() => {
          const f = filterFromHash()
          const k = urlKey()
          // Filter links carry the current key — switching filters
          // keeps you viewing the same list. Per-segment hashParts
          // reactivity means swapping filter doesn't redraw the
          // key-driven parts of the app.
          return h`
            <li><a class=${f === 'all'       ? 'selected' : null} href=${`#/${k}`}>All</a></li>
            <li><a class=${f === 'active'    ? 'selected' : null} href=${`#/${k}/active`}>Active</a></li>
            <li><a class=${f === 'completed' ? 'selected' : null} href=${`#/${k}/completed`}>Completed</a></li>
          `
        }}</ul>
        ${() => canWrite() && getTodos().some(t => t.done)
          ? h`<button class="clear-completed" onclick=${handle(clearCompleted)}>Clear completed</button>`
          : null}
      </footer>
    `}
  </section>

  ${() => urlKey() ? h`
    <footer class="info">
      ${canWrite() ? h`<p>Double-click to edit a todo</p>` : null}
      <p>Signed, append-only — <a class="explorer-link" href=${`../explorer/#/repo/${urlKey()}`}>${canWrite() ? 'explore your data' : 'explore this data'} →</a></p>
      <p>Powered by <a href="/">streamo</a></p>
    </footer>
  ` : null}
`, document.body, recaller)
