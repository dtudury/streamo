import { Mirror } from './Mirror.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'

const KEYS = Symbol('the keys this hub holds')

export class Hub {
  #mirrors = new Map()
  #drafts = new Map()

  constructor ({ recaller, upstream = null } = {}) {
    if (!recaller) throw new TypeError('Hub: recaller is required')
    this.recaller = recaller
    this.upstream = upstream
  }

  * keys () {
    this.recaller.reportKeyAccess(this, KEYS)
    yield * this.#mirrors.keys()
  }

  get (key) {
    this.recaller.reportKeyAccess(this, key)
    return this.#mirrors.get(key)?.mirror
  }

  draftFor (key) {
    this.recaller.reportKeyAccess(this.#drafts, key)
    return this.#drafts.get(key) ?? null
  }

  current (key) {
    return this.draftFor(key) ?? this.get(key)
  }

  want (key) {
    let entry = this.#mirrors.get(key)
    if (!entry) {
      entry = { mirror: new StreamoRecord({ recaller: this.recaller }), compat: null }
      this.#mirrors.set(key, entry)
      this.recaller.reportKeyMutation(this, KEYS)
      this.recaller.reportKeyMutation(this, key)
    }
    return entry.mirror
  }

  checkout (key, signer, signerName) {
    if (!signer) throw new TypeError('Hub.checkout: a draft needs a signer — that is what makes it authorable')
    const existing = this.#drafts.get(key)
    if (existing) return existing
    const mirror = this.want(key)
    const draft = new WritableStreamoRecord({ recaller: this.recaller })
    draft.copyFrom(mirror, mirror.lastCommit?.dataAddress ?? -1)
    draft.attachSigner(signer, signerName)
    this.#drafts.set(key, draft)
    this.recaller.reportKeyMutation(this.#drafts, key)
    return draft
  }

  discard (key) {
    if (!this.#drafts.delete(key)) return false
    this.recaller.reportKeyMutation(this.#drafts, key)
    return true
  }

  _materialize (key) {
    this.want(key)
    const entry = this.#mirrors.get(key)
    entry.compat ??= new Mirror({ publicKeyHex: key, local: entry.mirror, recaller: this.recaller })
    return entry.compat
  }
}
