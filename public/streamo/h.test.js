import { describe } from './utils/testing.js'
import { h, HElement, HText } from './h.js'

describe(import.meta.url, ({ test }) => {
  test('plain element', ({ assert }) => {
    const [div] = h`<div></div>`
    assert.ok(div instanceof HElement)
    assert.equal(div.tag, 'div')
    assert.deepEqual(div.attrs, [])
    assert.deepEqual(div.children, [])
  })

  test('void element produces no children', ({ assert }) => {
    const [br] = h`<br>`
    assert.ok(br instanceof HElement)
    assert.equal(br.tag, 'br')
    assert.deepEqual(br.children, [])
  })

  test('static attributes', ({ assert }) => {
    const [el] = h`<input type="text" placeholder='name'>`
    assert.equal(el.attrs[0].name, 'type')
    assert.equal(el.attrs[0].value, 'text')
    assert.equal(el.attrs[1].name, 'placeholder')
    assert.equal(el.attrs[1].value, 'name')
  })

  test('boolean attribute (no value)', ({ assert }) => {
    const [el] = h`<button disabled></button>`
    assert.equal(el.attrs[0].name, 'disabled')
    assert.equal(el.attrs[0].value, undefined)
  })

  test('dynamic attribute value', ({ assert }) => {
    const cls = 'active'
    const [el] = h`<div class=${cls}></div>`
    assert.equal(el.attrs[0].name, 'class')
    assert.equal(el.attrs[0].value, 'active')
  })

  test('function slot as attribute value', ({ assert }) => {
    const fn = () => 'red'
    const [el] = h`<div style=${'color:' + fn()}></div>`
    assert.equal(el.attrs[0].value, 'color:red')
  })

  test('text node child', ({ assert }) => {
    const [el] = h`<p>hello world</p>`
    assert.equal(el.children.length, 1)
    assert.ok(el.children[0] instanceof HText)
    assert.equal(el.children[0].value, 'hello world')
  })

  test('dynamic child slot', ({ assert }) => {
    const val = 42
    const [el] = h`<span>${val}</span>`
    assert.equal(el.children[0], 42)
  })

  test('function child slot preserved as function', ({ assert }) => {
    const fn = () => 'dynamic'
    const [el] = h`<span>${fn}</span>`
    assert.equal(typeof el.children[0], 'function')
    assert.equal(el.children[0](), 'dynamic')
  })

  test('nested elements', ({ assert }) => {
    const [ul] = h`<ul><li>a</li><li>b</li></ul>`
    assert.equal(ul.tag, 'ul')
    assert.equal(ul.children.length, 2)
    assert.equal(ul.children[0].tag, 'li')
    assert.equal(ul.children[1].tag, 'li')
  })

  test('mixed text and element children', ({ assert }) => {
    const [p] = h`<p>hello <strong>world</strong></p>`
    assert.ok(p.children[0] instanceof HText)
    assert.equal(p.children[0].value, 'hello ')
    assert.equal(p.children[1].tag, 'strong')
  })

  test('HTML entity decoding', ({ assert }) => {
    const [el] = h`<p>a &amp; b &lt; c &gt; d</p>`
    assert.equal(el.children[0].value, 'a & b < c > d')
  })

  test('multiple root nodes', ({ assert }) => {
    const nodes = h`<li>a</li><li>b</li>`
    assert.equal(nodes.length, 2)
    assert.equal(nodes[0].tag, 'li')
    assert.equal(nodes[1].tag, 'li')
  })

  test('self-closing syntax', ({ assert }) => {
    const [el] = h`<MyComponent />`
    assert.ok(el instanceof HElement)
    assert.equal(el.tag, 'MyComponent')
    assert.deepEqual(el.children, [])
  })

  test('mixed static/dynamic attribute value parts', ({ assert }) => {
    // A plain string slot gets joined into the surrounding text
    const color = 'red'
    const [el1] = h`<div style="color: ${color}; font-size: 12px"></div>`
    assert.equal(el1.attrs[0].value, 'color: red; font-size: 12px')

    // A function slot stays as an array so mount() can wire up reactivity
    const colorFn = () => 'blue'
    const [el2] = h`<div style="color: ${colorFn}; font-size: 12px"></div>`
    assert.ok(Array.isArray(el2.attrs[0].value))
    assert.equal(el2.attrs[0].value[0], 'color: ')
    assert.equal(typeof el2.attrs[0].value[1], 'function')
    assert.equal(el2.attrs[0].value[2], '; font-size: 12px')
  })

  test('spread attribute object', ({ assert }) => {
    const extra = { id: 'foo', 'data-x': '1' }
    const [el] = h`<div ${extra}></div>`
    assert.deepEqual(el.attrs[0], extra)
  })
})
