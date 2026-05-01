/* eslint-env browser */

const _voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const END = Symbol('end')

export class HInput {
  i = 0
  /**
   * @param {Array.<string>} strings
   * @param {Array} values
   */
  constructor (strings, values) {
    const ss = [strings[0].split('')]
    for (let i = 0; i < values.length; i++) {
      ss.push({ value: values[i], isValue: true })
      ss.push(strings[i + 1].split(''))
    }
    this.arr = [].concat.apply([], ss)
  }

  peek (offset = 0) {
    return this.arr[this.i + offset]
  }

  * generator () {
    while (this.i < this.arr.length) {
      yield this.peek()
      ++this.i
    }
  }

  /**
   * @param {RegExp} regex
   */
  assertChar (regex) {
    if (!this.peek().match(regex)) {
      throw new Error(`expected ${regex}. got ${this.peek()} at i=${this.i}`)
    }
    ++this.i
  }

  /**
   * @param {string} str
   * @returns {string}
   */
  readIf (str) {
    if (!str.length) {
      str = [str]
    }
    const out = []
    for (let i = 0; i < str.length; i++) {
      const char = this.peek(i)
      if (!char || !char.match || !char.match(str[i])) {
        return false
      }
      out.push(char)
    }
    this.i += str.length
    return out.join('')
  }

  readValue () {
    if (this.peek().isValue) {
      return this.arr[this.i++]
    }
  }

  readEscaped () {
    this.assertChar(/&/)
    if (this.readIf('amp;')) {
      return '&'
    } else if (this.readIf('apos;')) {
      return '\''
    } else if (this.readIf('gt;')) {
      return '>'
    } else if (this.readIf('lt;')) {
      return '<'
    } else if (this.readIf('quot;')) {
      return '"'
    } else if (this.readIf('nbsp;')) {
      return ' '
    } else {
      throw new Error('unhandled escape sequence')
    }
  }

  /**
   * @param {RegExp} regex
   * @returns {string}
   */
  readTo (regex) {
    const ss = []
    while (this.i < this.arr.length) {
      const c = this.peek()
      if (c.isValue || c.match(regex)) {
        return ss.join('')
      } else if (c === '&') {
        ss.push(this.readEscaped())
      } else {
        ss.push(c)
        ++this.i
      }
    }
    return ss.join('')
  }

  skipWhiteSpace () {
    this.readTo(/\S/)
  }

  /**
   * @param {RegExp} quoteType
   * @returns {Array}
   */
  readAttributeValue (quoteType) {
    const out = []
    let ss = []
    while (this.i < this.arr.length) {
      const c = this.peek()
      if (c.isValue) {
        if (ss.length) {
          out.push({ type: 'part', value: ss.join('') })
          ss = []
        }
        out.push(c.value)
        ++this.i
      } else if (c.match(quoteType)) {
        if (ss.length) {
          out.push({ type: 'part', value: ss.join('') })
        }
        return out
      } else if (c === '&') {
        ss.push(this.readEscaped())
      } else {
        ss.push(c)
        ++this.i
      }
    }
  }

  decodeAttribute () {
    this.skipWhiteSpace()
    const c = this.peek()
    if (c === '/' || c === '>') {
      return END
    }
    let name = this.readValue()
    if (name && name.isValue) {
      return name.value
    }
    name = this.readTo(/[\s=/>]/)
    if (!name) {
      throw new Error('attribute must have a name (dynamic attributes okay, dynamic names... sorry)')
    }
    this.skipWhiteSpace()
    const equalSign = this.readIf('=')
    if (equalSign) {
      this.skipWhiteSpace()
      let value = this.readValue()
      if (value) {
        value = value.value
      } else {
        const quote = this.readIf(/['"]/)
        if (quote) {
          value = this.readAttributeValue(quote)
          this.assertChar(quote)
        } else {
          value = this.readTo(/[\s=/>]/)
        }
      }
      return { type: 'attribute', name, value }
    } else {
      return { type: 'attribute', name }
    }
  }

  decodeAttributes () {
    const attributes = []
    while (true) {
      const attribute = this.decodeAttribute()
      if (attribute !== END) {
        attributes.push(attribute)
      } else {
        return attributes
      }
    }
  }

  decodeTag () {
    this.skipWhiteSpace()
    const c = this.peek()
    if (c.isValue) {
      ++this.i
      return c.value
    }
    return this.readTo(/[\s/>]/)
  }

  decodeElement (xmlns) {
    const c = this.peek()
    if (c.isValue) {
      ++this.i
      return c.value
    } else if (c === '<') {
      this.assertChar(/</)
      const isClosing = this.readIf('/')
      const tag = this.decodeTag()
      const isVoid = _voidElements.has(tag)
      const attributes = this.decodeAttributes()
      const isEmpty = this.readIf('/') || isVoid
      this.assertChar(/>/)
      const children = (isClosing || isEmpty) ? [] : this.decodeElements(tag)
      if (isVoid && isClosing) return { node: null }
      const node = document.createElementNS(attributes.xmlns || xmlns, tag, { is: attributes.is })
      return { node, isClosing }
    } else {
      return document.createTextNode(this.readTo(/</))
    }
  }

  /**
   * @param {string|null} closingTag
   * @param {string} xmlns
   * @returns {Array}
   */
  decodeElements (closingTag = null, xmlns = 'http://www.w3.org/1999/xhtml') {
    const nodes = []
    while (this.i < this.arr.length) {
      const { node, isClosing } = this.decodeElement(xmlns)
      if (node != null) {
        if (isClosing) {
          if (closingTag != null) {
            return nodes
          }
        } else {
          nodes.push(node)
        }
      }
    }
    return [].concat.apply([], nodes)
  }
}
