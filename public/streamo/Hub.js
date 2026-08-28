import { Mirror } from './Mirror.js'
import { StreamoRecord } from './StreamoRecord.js'

const KEYS = Symbol('the keys this hub holds')

export class Hub {
  #keys = new Map()

  constructor ({ recaller, upstream = null } = {}) {
    if (!recaller) throw new TypeError('Hub: recaller is required')
    this.recaller = recaller
    this.upstream = upstream
  }

  * keys () {
    this.recaller.reportKeyAccess(this, KEYS)
    yield * this.#keys.keys()
  }

  get (key) {
    this.recaller.reportKeyAccess(this, key)
    return this.#keys.get(key)?.mirror
  }

  want (key) {
    let entry = this.#keys.get(key)
    if (!entry) {
      entry = { mirror: new StreamoRecord({ recaller: this.recaller }), compat: null }
      this.#keys.set(key, entry)
      this.recaller.reportKeyMutation(this, KEYS)
      this.recaller.reportKeyMutation(this, key)
    }
    return entry.mirror
  }

  _materialize (key) {
    this.want(key)
    const entry = this.#keys.get(key)
    entry.compat ??= new Mirror({ publicKeyHex: key, local: entry.mirror, recaller: this.recaller })
    return entry.compat
  }
}
