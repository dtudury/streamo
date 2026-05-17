import { describe } from './utils/testing.js'
import { h } from './h.js'
import { mount } from './mount.js'
import { Streamo } from './Streamo.js'
import { Recaller } from './utils/Recaller.js'
import { liveValue } from './LiveSource.js'

const IS_NODE = typeof process !== 'undefined' && process.versions?.node != null

if (IS_NODE) {
  const { mockDocument, MockNode } = await import('./utils/mockDOM.js')
  globalThis.document = mockDocument
  globalThis.Node = MockNode
}

describe(import.meta.url, ({ test }) => {
  test('mounts a static element with text', ({ assert }) => {
    const container = document.createElement('div')
    mount(h`<span>hello</span>`, container)
    const span = container.childNodes[0]
    assert.equal(span.textContent, 'hello')
  })

  test('reactive text slot updates after stream.set', async ({ assert }) => {
    const stream = new Streamo()
    stream.set({ greeting: 'hello' })
    const container = document.createElement('div')
    mount(h`<span>${() => stream.get('greeting')}</span>`, container, stream.recaller)

    const span = container.childNodes[0]
    assert.equal(span.textContent, 'hello', 'initial render')

    stream.set('greeting', 'world')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(span.textContent, 'world', 'updated after set')
  })

  test('reactive attribute updates after stream.set', async ({ assert }) => {
    const stream = new Streamo()
    stream.set({ cls: 'active' })
    const container = document.createElement('div')
    mount(h`<div class=${() => stream.get('cls')}></div>`, container, stream.recaller)

    const div = container.childNodes[0]
    assert.equal(div.getAttribute('class'), 'active', 'initial attribute')

    stream.set('cls', 'inactive')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(div.getAttribute('class'), 'inactive', 'updated attribute')
  })

  test('unrelated stream.set does not re-render slot', async ({ assert }) => {
    const stream = new Streamo()
    stream.set({ a: 'unchanged', b: 'watched' })
    let renderCount = 0
    const container = document.createElement('div')
    mount(h`<span>${() => { renderCount++; return stream.get('b') }}</span>`, container, stream.recaller)

    assert.equal(renderCount, 1, 'initial render')

    stream.set('a', 'changed')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(renderCount, 1, 'no re-render when unrelated key changes')

    stream.set('b', 'also changed')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(renderCount, 2, 're-renders when watched key changes')
  })

  test('function component reads inside reconcile register deps on the slot watcher', async ({ assert }) => {
    // Regression: when a function component is invoked from a slot's
    // re-render via the function-component-recycling path (data-key
    // match in reconcileElement, not initial mountNode), the reads it
    // performs MUST still register on the slot's watcher so subsequent
    // changes to those reactive sources re-fire the slot. Without that,
    // editingId-style state read only from inside a function component
    // becomes invisible to the slot's re-render trigger after the first
    // mount.
    const stream = new Streamo()
    stream.set({ items: [{ id: 1 }, { id: 2 }], editing: 0 })

    function Item ({ item }) {
      const editing = stream.get('editing') === item.id
      return h`<li data-key=${item.id}>${editing ? 'EDIT' : 'view'}</li>`
    }

    const container = document.createElement('div')
    mount(h`<ul>${() => stream.get('items').map(item =>
      h`<${Item} item=${item} data-key=${item.id}/>`
    )}</ul>`, container, stream.recaller)

    const ul = container.childNodes[0]
    const lis = () => ul.childNodes.filter(n => n.nodeType === 1)
    assert.equal(lis().length, 2, 'two items')
    assert.equal(lis()[0].textContent, 'view')
    assert.equal(lis()[1].textContent, 'view')

    stream.set('editing', 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(lis()[0].textContent, 'EDIT', 'editing=1 → item 1 shows EDIT')
    assert.equal(lis()[1].textContent, 'view', 'item 2 unchanged')

    stream.set('editing', 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(lis()[0].textContent, 'view', 'item 1 returns to view')
    assert.equal(lis()[1].textContent, 'EDIT', 'item 2 now shows EDIT')
  })

  test('todomvc-shape: conditional form inside li renders inside the li after editing flip', async ({ assert }) => {
    // Mimics todomvc's TodoItem shape: outer <li> with a static <div.view>
    // child and a conditional <form> child. When the editing flag flips, the
    // form should appear INSIDE the <li> (between div and end), not get
    // mounted outside the <li>.
    const recaller = new Recaller('todomvc-shape')
    const editingId = liveValue(null, { recaller, name: 'editingId' })
    const items = [{ id: 1, text: 'a' }]

    function Item ({ item }) {
      const editing = editingId.get() === item.id
      return h`
        <li class=${editing ? 'editing' : ''} data-key=${item.id}>
          <div class="view"><label>${item.text}</label></div>
          ${editing ? h`<form><input class="edit"></form>` : null}
        </li>
      `
    }

    const container = document.createElement('div')
    mount(h`<ul>${() => items.map(item =>
      h`<${Item} item=${item} data-key=${item.id}/>`
    )}</ul>`, container, recaller)

    const ul = container.childNodes[0]
    const lis = () => ul.childNodes.filter(n => n.nodeType === 1)
    assert.equal(lis().length, 1, 'one li initially')
    const li = lis()[0]
    assert.equal(li.childNodes.filter(n => n.nodeType === 1).length, 1, 'just the div.view inside the li')

    // Flip editing on
    editingId.set(1)
    await new Promise(r => setTimeout(r, 20))
    assert.equal(lis().length, 1, 'still one li after editing flip')
    assert.equal(lis()[0].getAttribute('class'), 'editing', 'li has editing class')
    const liChildren = lis()[0].childNodes.filter(n => n.nodeType === 1)
    assert.equal(liChildren.length, 2, 'li now has div AND form as children')
    assert.equal(liChildren[0].tagName?.toLowerCase(), 'div', 'first child is div')
    assert.equal(liChildren[1].tagName?.toLowerCase(), 'form', 'second child is form (INSIDE the li, not after it)')
  })

  test('function component returning a single-element array is recycled, not duplicated', async ({ assert }) => {
    // h() always returns an array (`return parseChildren(sc, null)`), so a
    // function component using h with a single root produces `[liVnode]`,
    // not `liVnode`. AND if there's whitespace around the root (which any
    // multiline template-literal has), the array is `[HText, liVnode, HText]`.
    // reconcileElement must unwrap the HElement out of these arrays.
    // Pre-fix: the fallback path disposed of `el` AND fresh-mounted inner AND
    // the outer caller re-attached `el`, producing two elements where there
    // should be one.
    const stream = new Streamo()
    stream.set({ items: [{ id: 1, text: 'a' }] })

    function Item ({ item }) {
      // Multiline template — leading/trailing whitespace produces HText
      // siblings of the root. This is the natural shape of any real
      // component, not a degenerate edge case.
      return h`
        <li data-key=${item.id}>${item.text}</li>
      `
    }

    const container = document.createElement('div')
    mount(h`<ul>${() => stream.get('items').map(item =>
      h`<${Item} item=${item} data-key=${item.id}/>`
    )}</ul>`, container, stream.recaller)

    const ul = container.childNodes[0]
    const lis = () => ul.childNodes.filter(n => n.nodeType === 1)
    assert.equal(lis().length, 1, 'one item rendered')
    assert.equal(lis()[0].textContent, 'a')

    // Re-render with same items: count must stay at 1 (no duplicates from
    // the array-unwrap fallback). This is the regression: pre-fix, the
    // recycled <li> was disposed AND the fresh mount happened AND the
    // outer end.before() re-attached the original, producing 2.
    stream.set({ items: [{ id: 1, text: 'b' }] })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(lis().length, 1, 'still one item after re-render')
    assert.equal(lis()[0].textContent, 'b', 'text updated')
  })

  test('liveValue change inside a function component triggers slot re-render', async ({ assert }) => {
    // Mirrors todomvc's exact shape: a SHARED recaller; one source for
    // the list (driven by a Streamo); a separate liveValue for the
    // per-item editing state that's read only inside the function
    // component. The bug being captured: if liveValue.set on the
    // editing source does NOT fire the slot's watcher (because the
    // liveValue's read inside Item didn't register on the watcher),
    // dblclick-to-edit looks like it does nothing until some OTHER
    // mutation incidentally fires the slot.
    const recaller = new Recaller('todomvc-test')
    const todos = new Streamo(undefined, { recaller })
    todos.set({ items: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }] })
    const editingId = liveValue(null, { recaller, name: 'editingId' })

    function Item ({ todo }) {
      const editing = editingId.get() === todo.id
      return h`<li data-key=${todo.id}>${editing ? 'EDIT' : todo.text}</li>`
    }

    const container = document.createElement('div')
    mount(h`<ul>${() => todos.get('items').map(t =>
      h`<${Item} todo=${t} data-key=${t.id}/>`
    )}</ul>`, container, recaller)

    const ul = container.childNodes[0]
    const lis = () => ul.childNodes.filter(n => n.nodeType === 1)
    assert.equal(lis()[0].textContent, 'a', 'initial: item 1 shows text')
    assert.equal(lis()[1].textContent, 'b', 'initial: item 2 shows text')

    // The critical assertion: setting editingId via the LIVE-VALUE
    // (not the streamo) should fire the slot's watcher.
    editingId.set(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(lis()[0].textContent, 'EDIT', 'after editingId.set(1): item 1 shows EDIT')
    assert.equal(lis()[1].textContent, 'b', 'item 2 unchanged')

    editingId.set(null)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(lis()[0].textContent, 'a', 'after editingId.set(null): item 1 returns to text')
  })
})
