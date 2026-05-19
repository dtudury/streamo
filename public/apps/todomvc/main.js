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

// URL hash drives the filter (#/, #/active, #/completed) — matches the
// canonical TodoMVC routing convention. liveLocation gives us reactive
// reads of window.location without a separate hashchange listener.
const loc = liveLocation({ recaller, name: 'location' })
const filterFromHash = () => {
  switch (loc.get('hash')) {
    case '#/active':    return 'active'
    case '#/completed': return 'completed'
    default:            return 'all'
  }
}

// Set after successful login. Plain lets — the slots that read them are
// only constructed after loggedIn flips true, so closure capture is fine.
let myRepo, myKey

// ── handlers ─────────────────────────────────────────────────────────

async function login (e) {
  e.preventDefault()
  const f = e.target
  const username = f.elements.username.value.trim()
  const password = f.elements.password.value.trim()
  if (!username || !password) { loginStatus.set('enter username and password'); return }

  f.elements.username.disabled = f.elements.password.disabled = true
  loginStatus.set('connecting…')

  try {
    const signer = new Signer(username, password, 1)
    const { publicKey } = await signer.keysFor('todomvc')
    myKey = bytesToHex(publicKey)
    const registry = new RepoRegistry(undefined, { recaller, name: 'todomvc' })
    const session = await registrySync(registry, location.hostname, +location.port || (location.protocol === 'https:' ? 443 : 80))
    myRepo = await registry.open(myKey)
    myRepo.attachSigner(signer, 'todomvc')
    myRepo.defaultMessage = `signed in as ${username}`
    // Explicitly subscribe to our own key so the server replays any
    // archived bytes for this repo — that's how previous-session todos
    // come back. registry.open creates the local Repo; this asks the
    // relay to stream the historical chunks into it.
    await session.subscribe(myKey)
    loggedIn.set(true)
  } catch (err) {
    loginStatus.set(`error: ${err.message}`)
    f.elements.username.disabled = f.elements.password.disabled = false
  }
}

const getTodos = () => myRepo.get('todos') ?? []
const setTodos = (todos, msg) => { myRepo.defaultMessage = msg; myRepo.set({ todos }) }

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

function TodoItem ({ todo }) {
  const editing = editingId.get() === todo.id
  const classes = [todo.done && 'completed', editing && 'editing'].filter(Boolean).join(' ')
  return h`
    <li class=${classes} data-key=${todo.id}>
      <div class="view">
        <input class="toggle" type="checkbox" checked=${todo.done}
               onclick=${handle(() => toggleTodo(todo.id))}>
        <label ondblclick=${handle(() => startEdit(todo.id))}>${todo.text}</label>
        <button class="destroy" onclick=${handle(() => deleteTodo(todo.id))}></button>
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
      ${() => loggedIn.get() ? h`
        <form data-key="new-todo-form" onsubmit=${handle(addTodo)}>
          <input data-key="new-todo" class="new-todo" name="text" placeholder="What needs to be done?" autofocus autocomplete="off">
        </form>
      ` : h`
        <form data-key="login-form" class="login" onsubmit=${handle(login)}>
          <input data-key="username" name="username" placeholder="username" autocomplete="username" autofocus>
          <input data-key="password" name="password" type="password" placeholder="password" autocomplete="current-password">
          <button>sign in</button>
          <div class="login-status">${() => loginStatus.get()}</div>
        </form>
      `}
    </header>

    ${() => !loggedIn.get() || getTodos().length === 0 ? null : h`
      <section class="main">
        <input id="toggle-all" class="toggle-all" type="checkbox"
               checked=${getTodos().every(t => t.done)}
               onclick=${handle(toggleAll)}>
        <label for="toggle-all">Mark all as complete</label>
        <ul class="todo-list">${() => {
          const filter = filterFromHash()
          const filtered = getTodos().filter(t =>
            filter === 'all' || (filter === 'active' ? !t.done : t.done)
          )
          // data-key on the function-component invocation enrolls each
          // TodoItem in mount's recycling pool — without it, every parent
          // re-render fresh-mounts all <li>s, destroying any in-progress
          // edit (focus, partial text). With the key, the existing <li>
          // is recycled and its inner DOM survives.
          return filtered.map(t => h`<${TodoItem} todo=${t} data-key=${t.id}/>`)
        }}</ul>
      </section>
    `}

    ${() => !loggedIn.get() || getTodos().length === 0 ? null : h`
      <footer class="footer">
        <span class="todo-count">${() => {
          const remaining = getTodos().filter(t => !t.done).length
          return h`<strong>${remaining}</strong> ${remaining === 1 ? 'item' : 'items'} left`
        }}</span>
        <ul class="filters">${() => {
          const f = filterFromHash()
          return h`
            <li><a class=${f === 'all'       ? 'selected' : null} href="#/">All</a></li>
            <li><a class=${f === 'active'    ? 'selected' : null} href="#/active">Active</a></li>
            <li><a class=${f === 'completed' ? 'selected' : null} href="#/completed">Completed</a></li>
          `
        }}</ul>
        ${() => getTodos().some(t => t.done)
          ? h`<button class="clear-completed" onclick=${handle(clearCompleted)}>Clear completed</button>`
          : null}
      </footer>
    `}
  </section>

  ${() => loggedIn.get() ? h`
    <footer class="info">
      <p>Double-click to edit a todo</p>
      <p>Signed, append-only, served at <code>/streams/${myKey}/</code></p>
      <p>Powered by <a href="/">streamo</a></p>
    </footer>
  ` : null}
`, document.body, recaller)
