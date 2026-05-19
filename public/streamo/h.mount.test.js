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

  test('keyed vnode that does not match by key fresh-mounts (no tag-pool steal)', async ({ assert }) => {
    // Regression: pass-3 used to tag-match any vnode to any element,
    // ignoring data-key identity. A keyed vnode whose key didn't match
    // could steal an old element that previously had a *different* key
    // — bringing along any DOM state (input value, focus, etc.) the new
    // vnode didn't reset. The visible symptom David caught: typing your
    // username into the login form, then logging in, and seeing the
    // username text persist into the new-todo input field. Fix: pass-3
    // only matches *unkeyed* vnodes to *unkeyed* elements; keyed
    // vnodes that miss in pass 1 fresh-mount instead of falling through.
    const stream = new Streamo()
    stream.set({ which: 'a' })
    const container = document.createElement('div')
    mount(h`${() => stream.get('which') === 'a'
      ? h`<input data-key="a" name="a">`
      : h`<input data-key="b" name="b">`}`, container, stream.recaller)

    const inputA = container.childNodes[0]
    assert.equal(inputA.getAttribute('data-key'), 'a', 'initial input has data-key=a')
    assert.equal(inputA.getAttribute('name'), 'a')
    // Simulate user state on the element that should NOT carry over
    inputA.userTypedValue = 'leaked-state'

    stream.set('which', 'b')
    await new Promise(r => setTimeout(r, 20))

    const inputB = container.childNodes[0]
    assert.equal(inputB.getAttribute('data-key'), 'b', 'now data-key=b')
    assert.equal(inputB.getAttribute('name'), 'b')
    assert.notEqual(inputB, inputA, 'fresh DOM instance — not the recycled inputA')
    assert.equal(inputB.userTypedValue, undefined, 'user state from inputA did NOT leak into inputB')
  })

  test('autofocus on a freshly-mounted element triggers focus()', async ({ assert }) => {
    // Regression: browsers respect `autofocus` on initial page load but
    // quietly skip it on dynamic inserts when anything else has focus.
    // mount restores the declarative intent by calling .focus() on
    // freshly-mounted elements with the autofocus attribute. The focus
    // call is deferred to a microtask so the element is attached before
    // it fires.
    const stream = new Streamo()
    stream.set({ show: false })
    // Synthetic parent so container.isConnected resolves correctly through
    // the mock's parent-chain check (and so .focus() inside the microtask
    // sees the input as attached to the document tree).
    const root = document.createElement('div')
    const container = document.createElement('div')
    root.appendChild(container)
    mount(
      h`${() => stream.get('show') ? h`<input autofocus name="x">` : null}`,
      container, stream.recaller
    )
    assert.equal(container.childNodes.length, 0, 'not shown yet')

    stream.set('show', true)
    await new Promise(r => setTimeout(r, 20))

    const input = container.childNodes[0]
    assert.ok(input, 'input mounted')
    assert.equal(input.parentNode, container, 'input is attached')
    assert.ok((input.focused ?? 0) > 0, 'focus() was called on the autofocus input')
  })

  test('text nodes are recycled positionally across re-render (nodeValue updates in place)', async ({ assert }) => {
    // Regression: text nodes used to be re-created on every reactive re-
    // render (fresh document.createTextNode + old one cleaned up). That
    // breaks user text selection that spans the node — browser selection
    // anchors at a Node, not at a document offset. After pass-4, text
    // vnodes match positionally to the still-unclaimed text nodes in the
    // parent, and the build pass updates nodeValue in place. The text-node
    // INSTANCE survives the re-render; its value updates.
    const stream = new Streamo()
    stream.set({ msg: 'hello' })
    const container = document.createElement('div')
    mount(h`<p>${() => stream.get('msg')}</p>`, container, stream.recaller)

    const p = container.childNodes[0]
    const originalTextNode = p.childNodes[0]
    assert.equal(originalTextNode.nodeType, 3, 'is a text node')
    assert.equal(originalTextNode.nodeValue, 'hello', 'initial text')

    stream.set('msg', 'world')
    await new Promise(r => setTimeout(r, 20))

    assert.equal(p.childNodes[0], originalTextNode, 'same text node instance — recycled, not replaced')
    assert.equal(p.childNodes[0].nodeValue, 'world', 'nodeValue updated in place')
  })

  test('attribute setting is a no-op when the value did not change', async ({ assert }) => {
    // Regression: terraform used to clear-all-then-reapply, so every re-render
    // mutated the DOM for every attribute even when nothing changed.
    // After the noop-when-same optimization, setAttribute should fire only
    // for attributes whose value actually differs from what's already there.
    const stream = new Streamo()
    stream.set({ a: 'one', b: 'two' })
    const container = document.createElement('div')
    mount(
      h`<div data-a=${() => stream.get('a')} data-b=${() => stream.get('b')}></div>`,
      container, stream.recaller
    )
    const div = container.childNodes[0]
    assert.equal(div.getAttribute('data-a'), 'one', 'initial data-a')
    assert.equal(div.getAttribute('data-b'), 'two', 'initial data-b')

    // Instrument setAttribute on this element to count post-mount calls
    let setCount = 0
    const origSet = div.setAttribute.bind(div)
    div.setAttribute = (...args) => { setCount++; return origSet(...args) }

    // Mutate `a` but not `b`. Both function-attrs are evaluated during the
    // re-render (single root watcher), so this catches the case: setAttribute
    // fires for the one that changed, NOT for the one whose value is the same.
    stream.set('a', 'three')
    await new Promise(r => setTimeout(r, 20))

    assert.equal(div.getAttribute('data-a'), 'three', 'data-a updated')
    assert.equal(div.getAttribute('data-b'), 'two', 'data-b unchanged')
    assert.equal(setCount, 1, 'setAttribute fired exactly once — for the changed attr only')
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

  test('component-level isolation: a sibling whose dep did not change does not re-render', async ({ assert }) => {
    // The fine-grained-watcher-boundary contract: each function-component
    // invocation is its own watch point. Reads inside ItemA register on
    // ItemA's watcher, reads inside ItemB register on ItemB's watcher.
    // Mutating cellA should re-fire ONLY ItemA — ItemB's body must not
    // be invoked again, and the root reconcile must not walk the tree.
    //
    // Today's mount uses a single root watcher, so any reactive change
    // re-evaluates everything (including ItemB). This test will fail
    // until function-components get their own watch boundaries.
    const recaller = new Recaller('isolation')
    const cellA = liveValue('A', { recaller, name: 'cellA' })
    const cellB = liveValue('B', { recaller, name: 'cellB' })

    let renderA = 0
    let renderB = 0

    function ItemA () {
      renderA++
      return h`<li data-key="a">${cellA.get()}</li>`
    }
    function ItemB () {
      renderB++
      return h`<li data-key="b">${cellB.get()}</li>`
    }

    const container = document.createElement('div')
    mount(h`<ul><${ItemA} data-key="a"/><${ItemB} data-key="b"/></ul>`, container, recaller)

    const ul = container.childNodes[0]
    const lis = () => ul.childNodes.filter(n => n.nodeType === 1)
    assert.equal(lis().length, 2, 'two items rendered initially')
    assert.equal(lis()[0].textContent, 'A', 'A initial text')
    assert.equal(lis()[1].textContent, 'B', 'B initial text')
    assert.equal(renderA, 1, 'A body ran once initially')
    assert.equal(renderB, 1, 'B body ran once initially')

    cellA.set('A2')
    await new Promise(r => setTimeout(r, 20))

    assert.equal(lis()[0].textContent, 'A2', 'A text updated after its cell changed')
    assert.equal(lis()[1].textContent, 'B', 'B text unchanged')
    assert.equal(renderA, 2, 'A body re-ran (its dep changed)')
    assert.equal(renderB, 1, 'B body did NOT re-run — its dep did not change')

    cellB.set('B2')
    await new Promise(r => setTimeout(r, 20))

    assert.equal(lis()[0].textContent, 'A2', 'A text unchanged on cellB mutation')
    assert.equal(lis()[1].textContent, 'B2', 'B text updated after its cell changed')
    assert.equal(renderA, 2, 'A body did NOT re-run on cellB mutation')
    assert.equal(renderB, 2, 'B body re-ran (its dep changed)')
  })

  test('nested isolation: inner component dep change does NOT re-fire its ancestors', async ({ assert }) => {
    // Stronger test of the fine-grained boundary: Outer wraps Middle wraps
    // Inner. A reactive cell is read only inside Inner. Mutating it should
    // re-fire ONLY Inner's body — Middle and Outer's bodies must not re-run.
    // This proves the watcher stack works the way we need: nested
    // recaller.watch calls isolate reads to the innermost scope, so the
    // ancestors never registered the dep in the first place.
    const recaller = new Recaller('nested')
    const cell = liveValue('inner-1', { recaller, name: 'cell' })

    let outerRuns = 0
    let middleRuns = 0
    let innerRuns = 0

    function Inner () {
      innerRuns++
      return h`<span>${cell.get()}</span>`
    }
    function Middle () {
      middleRuns++
      return h`<em><${Inner} data-key="i"/></em>`
    }
    function Outer () {
      outerRuns++
      return h`<div><${Middle} data-key="m"/></div>`
    }

    const container = document.createElement('div')
    mount(h`<${Outer} data-key="o"/>`, container, recaller)

    const outerDiv = container.childNodes[0]
    const em = outerDiv.childNodes[0]
    const span = em.childNodes[0]
    assert.equal(span.textContent, 'inner-1', 'initial: deepest text rendered')
    assert.equal(outerRuns, 1)
    assert.equal(middleRuns, 1)
    assert.equal(innerRuns, 1)

    cell.set('inner-2')
    await new Promise(r => setTimeout(r, 20))

    assert.equal(span.textContent, 'inner-2', 'inner text updated')
    assert.equal(outerRuns, 1, 'outer did NOT re-run')
    assert.equal(middleRuns, 1, 'middle did NOT re-run')
    assert.equal(innerRuns, 2, 'inner re-ran (its dep changed)')
  })

  test('component teardown: dropping a function-component unwatches its watcher', async ({ assert }) => {
    // When a function-component invocation disappears from the parent's
    // resolved set, its watcher must be unregistered from the recaller —
    // otherwise mutating its (now-disconnected) deps would still fire a
    // ghost render against a detached element. The visible symptom would
    // be a leak; the immediate-fail symptom is the watcher still running
    // and doing something visible.
    const recaller = new Recaller('teardown')
    const show = liveValue(true, { recaller, name: 'show' })
    const inner = liveValue('a', { recaller, name: 'inner' })

    let innerRuns = 0
    function Item () {
      innerRuns++
      return h`<li>${inner.get()}</li>`
    }

    const container = document.createElement('div')
    mount(h`<ul>${() => show.get() ? h`<${Item} data-key="i"/>` : null}</ul>`, container, recaller)

    const ul = container.childNodes[0]
    assert.equal(ul.childNodes.length, 1, 'item rendered initially')
    assert.equal(innerRuns, 1)

    // Drop the item — show=false means the slot resolves to null
    show.set(false)
    await new Promise(r => setTimeout(r, 20))
    assert.equal(ul.childNodes.length, 0, 'item removed')
    const runsAfterDrop = innerRuns

    // Mutate inner's dep — if teardown worked, Item's watcher is gone and
    // innerRuns must NOT increment. If it leaks, the watcher fires and
    // tries to terraform a detached element.
    inner.set('b')
    await new Promise(r => setTimeout(r, 20))
    assert.equal(innerRuns, runsAfterDrop, 'dropped Item watcher did NOT fire on inner.set')

    // Bring it back: a fresh instance should appear and render the current value
    show.set(true)
    await new Promise(r => setTimeout(r, 20))
    assert.equal(ul.childNodes.length, 1, 'item re-rendered')
    assert.equal(ul.childNodes[0].textContent, 'b', 'shows current inner value')
  })
})
