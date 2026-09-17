import { Mirror } from '../Mirror.js'
import { StreamoRecord } from '../StreamoRecord.js'
import { WritableStreamoRecord } from '../WritableStreamoRecord.js'

const KEYS = Symbol('the keys this hub holds')

export class Hub {
  #mirrors = new Map()
  #drafts = new Map()
  #compat = new Map()

  constructor ({ recaller } = {}) {
    if (!recaller) throw new TypeError('Hub: recaller is required')
    this.recaller = recaller
  }

  * keys () {
    this.recaller.reportKeyAccess(this, KEYS)
    yield * this.#mirrors.keys()
  }

  hasMirror (key) {
    this.recaller.reportKeyAccess(this, key)
    return this.#mirrors.has(key)
  }

  getMirror (key) {
    this.recaller.reportKeyAccess(this, key)
    let mirror = this.#mirrors.get(key)
    if (!mirror) {
      mirror = new StreamoRecord({ recaller: this.recaller })
      this.#mirrors.set(key, mirror)
      this.recaller.reportKeyMutation(this, KEYS)
      this.recaller.reportKeyMutation(this, key)
    }
    return mirror
  }

  getDraft (key) {
    this.recaller.reportKeyAccess(this.#drafts, key)
    return this.#drafts.get(key) ?? null
  }

  getCurrent (key) {
    return this.getDraft(key) ?? this.getMirror(key)
  }

  checkout (key, signer, signerName) {
    if (!signer) throw new TypeError('Hub.checkout: a draft needs a signer — that is what makes it authorable')
    const existing = this.#drafts.get(key)
    if (existing) return existing
    const mirror = this.getMirror(key)
    const draft = new WritableStreamoRecord({ recaller: this.recaller })
    if (mirror.byteLength) mirror._applyClone(draft, mirror.byteLength - 1)
    draft.attachSigner(signer, signerName)
    this.#drafts.set(key, draft)
    this.recaller.reportKeyMutation(this.#drafts, key)
    return draft
  }

  _materialize (key) {
    const local = this.getMirror(key)
    let compat = this.#compat.get(key)
    if (!compat) {
      compat = new Mirror({ publicKeyHex: key, local, recaller: this.recaller })
      this.#compat.set(key, compat)
    }
    return compat
  }
}
