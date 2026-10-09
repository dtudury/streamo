import { Recaller } from './utils/Recaller.js'
import { CodecRegistry } from './CodecRegistry.js'

export function * changedPaths (streamo, addrA, addrB, path = []) {
  if (addrA === addrB) return
  yield path
  const refsA = addrA !== undefined ? streamo.asRefs(addrA) : undefined
  const refsB = addrB !== undefined ? streamo.asRefs(addrB) : undefined
  const isPlain = v => v != null && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  const objA = isPlain(refsA)
  const objB = isPlain(refsB)
  if (objA || objB) {
    if (Array.isArray(refsA) && Array.isArray(refsB) && refsA.length !== refsB.length) {
      yield [...path, 'length']
    }
    const keys = new Set([...Object.keys(refsA ?? {}), ...Object.keys(refsB ?? {})])
    for (const key of keys) {
      const a = objA ? refsA[key] : undefined
      const b = objB ? refsB[key] : undefined
      if (a !== b) yield * changedPaths(streamo, a, b, [...path, key])
    }
  }
}

export class Streamo extends CodecRegistry {
  #recaller
  #valueAddress = -1

  /** @param {{ recaller?: Recaller, name?: string }} [options] */
  constructor ({ recaller, name = 'Streamo' } = {}) {
    super()
    this.#recaller = recaller ?? new Recaller(name)
  }

  get recaller () { return this.#recaller }

  get byteLength () {
    this.#recaller.reportKeyAccess(this._chunks, 'length')
    return super.byteLength
  }

  append (code) {
    return this.publish(super.append(code))
  }

  publish (address) {
    this.#valueAddress = address
    this.#recaller.reportKeyMutation(this._chunks, 'length')
    return address
  }

  get (...args) {
    let address
    if (typeof args[0] === 'number') {
      address = /** @type {number} */ (args.shift())
    } else {
      address = this.valueAddress
      this.#recaller.reportKeyAccess(this._chunks, 'length')
      this.#recaller.reportKeyAccess(this._chunks, JSON.stringify(args))
    }
    if (address < 0) return undefined
    return this.decodeAt(address, ...args)
  }

  set (...args) {
    const baseAddress = typeof args[0] === 'number' ? args.shift() : this.valueAddress
    const value = args.pop()
    const path = args

    const prevAddress = super.byteLength > 0 ? this.valueAddress : undefined

    let newAddress
    if (path.length === 0 || baseAddress < 0) {
      let encodedValue = value
      if (path.length > 0) {
        let obj = value
        for (let i = path.length - 1; i >= 0; i--) obj = { [path[i]]: obj }
        encodedValue = obj
      }
      newAddress = this.encode(encodedValue)
    } else {
      const levels = []
      let addr = baseAddress
      for (let i = 0; i < path.length - 1; i++) {
        const refs = this.asRefs(addr)
        levels.push({ refs, key: path[i] })
        addr = Array.isArray(refs) ? refs[+path[i]] : refs[path[i]]
      }
      levels.push({ refs: this.asRefs(addr), key: path[path.length - 1] })

      let childAddr = this.encode(value)

      for (let i = levels.length - 1; i >= 0; i--) {
        const { refs, key } = levels[i]
        const newRefs = Array.isArray(refs) ? [...refs] : { ...refs }
        newRefs[Array.isArray(refs) ? +key : key] = childAddr
        childAddr = this.encode(newRefs, true)
      }
      newAddress = childAddr
    }

    this.#valueAddress = newAddress
    for (const changed of changedPaths(this, prevAddress, newAddress)) {
      this.#recaller.reportKeyMutation(this._chunks, JSON.stringify(changed))
    }
    return newAddress
  }

  getRefs (...path) {
    let address = this.valueAddress
    if (address < 0) return undefined
    for (const key of path) {
      const refs = this.asRefs(address)
      if (typeof refs === 'number') return undefined
      address = Array.isArray(refs) ? refs[+key] : refs[key]
      if (address === undefined) return undefined
    }
    return this.asRefs(address)
  }

  setRefs (...args) {
    let childAddr = /** @type {number} */ (args.pop())
    const path = args
    const baseAddress = this.valueAddress
    const prevAddress = super.byteLength > 0 ? this.valueAddress : undefined

    const levels = []
    let addr = baseAddress
    for (let i = 0; i < path.length - 1; i++) {
      const refs = this.asRefs(addr)
      levels.push({ refs, key: path[i] })
      addr = Array.isArray(refs) ? refs[+path[i]] : refs[path[i]]
    }
    levels.push({ refs: this.asRefs(addr), key: path[path.length - 1] })

    for (let i = levels.length - 1; i >= 0; i--) {
      const { refs, key } = levels[i]
      const newRefs = Array.isArray(refs) ? [...refs] : { ...refs }
      newRefs[Array.isArray(refs) ? +key : key] = childAddr
      childAddr = this.encode(newRefs, true)
    }

    const newAddress = childAddr
    this.#valueAddress = newAddress
    for (const changed of changedPaths(this, prevAddress, newAddress)) {
      this.#recaller.reportKeyMutation(this._chunks, JSON.stringify(changed))
    }
    return newAddress
  }

  /** @param {number} address @param {{ recaller?: Recaller, name?: string }} [options] @returns {Streamo} */
  clone (address, { recaller = this.#recaller, name } = {}) {
    const Ctor = /** @type {typeof Streamo} */ (this.constructor)
    return this._applyClone(new Ctor({ recaller, name }), address)
  }

  get valueAddress () {
    if (this.#valueAddress >= 0) return this.#valueAddress
    return super.byteLength - 1
  }

}
