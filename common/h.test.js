import { globalTestRunner, urlToName } from '../lib/utils/TestRunner.js'
import { h } from './h.js'

globalTestRunner.describe(urlToName(import.meta.url), suite => {
  const asdf = h`<div>asdf</div>`
  console.log(asdf)
})
