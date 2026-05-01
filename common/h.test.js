import { describe } from '../public/streamo/utils/testing.js'
import { h } from './h.js'

describe(import.meta.url, ({ test }) => {
  test('parses a simple element', () => {
    const nodes = h`<div>asdf</div>`
    console.log(nodes)
  })
})
