import { describe } from './utils/testing.js'
import { h } from './h.js'
import { mount } from './mount.js'
import { Streamo } from './Streamo.js'

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
})
