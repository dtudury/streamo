import { Mirror } from './Mirror.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'

const KEYS = Symbol('the keys this hub holds')
const UPSTREAM = Symbol('where canon comes from')

export class Hub {
  #mirrors = new Map()
  #drafts = new Map()
  #upstream = null

  constructor ({ recaller } = {}) {
    if (!recaller) throw new TypeError('Hub: recaller is required')
    this.recaller = recaller
  }

  get upstream () {
    this.recaller.reportKeyAccess(this, UPSTREAM)
    return this.#upstream
  }

  set upstream (sync) {
    if (sync && this.#upstream && sync !== this.#upstream) {
      throw new Error('Hub: canon arrives from one direction; release the current upstream first')
    }
    if (sync === this.#upstream) return
    this.#upstream = sync
    this.recaller.reportKeyMutation(this, UPSTREAM)
  }

  * keys () {
    this.recaller.reportKeyAccess(this, KEYS)
    yield * this.#mirrors.keys()
  }

  getMirror (key) {
    this.recaller.reportKeyAccess(this, key)
    return this.#mirrors.get(key)?.mirror
  }

  getDraft (key) {
    this.recaller.reportKeyAccess(this.#drafts, key)
    return this.#drafts.get(key) ?? null
  }

  getCurrent (key) {
    return this.getDraft(key) ?? this.getMirror(key)
  }

  want (key) {
    if (this.#mirrors.has(key)) return
    this.#mirrors.set(key, { mirror: new StreamoRecord({ recaller: this.recaller }), compat: null })
    this.recaller.reportKeyMutation(this, KEYS)
    this.recaller.reportKeyMutation(this, key)
  }

  checkout (key, signer, signerName) {
    if (!signer) throw new TypeError('Hub.checkout: a draft needs a signer — that is what makes it authorable')
    const existing = this.#drafts.get(key)
    if (existing) return existing
    this.want(key)
    const mirror = this.#mirrors.get(key).mirror
    const draft = new WritableStreamoRecord({ recaller: this.recaller })
    draft.copyFrom(mirror, mirror.lastCommit?.dataAddress ?? -1)
    draft.attachSigner(signer, signerName)
    this.#drafts.set(key, draft)
    this.recaller.reportKeyMutation(this.#drafts, key)
    return draft
  }

  receive (key, sync) {
    if (!sync || sync !== this.#upstream) {
      throw new Error('Hub.receive: only the upstream Sync may write canon')
    }
    this.want(key)
    if (this.#drafts.delete(key)) this.recaller.reportKeyMutation(this.#drafts, key)
    return this.#mirrors.get(key).mirror
  }

  _materialize (key) {
    this.want(key)
    const entry = this.#mirrors.get(key)
    entry.compat ??= new Mirror({ publicKeyHex: key, local: entry.mirror, recaller: this.recaller })
    return entry.compat
  }
}
