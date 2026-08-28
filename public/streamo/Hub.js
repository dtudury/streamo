import { Mirror } from './Mirror.js'
import { StreamoRecord } from './StreamoRecord.js'
import { WritableStreamoRecord } from './WritableStreamoRecord.js'

const KEYS = Symbol('the keys this hub holds')

export class Hub {
  #keys = new Map()

  constructor ({ recaller, upstream = null } = {}) {
    if (!recaller) throw new TypeError('Hub: recaller is required')
    this.recaller = recaller
    this.upstream = upstream
  }

  #entry (key) {
    let entry = this.#keys.get(key)
    if (!entry) {
      entry = { mirror: new StreamoRecord({ recaller: this.recaller }), draft: null, compat: null }
      this.#keys.set(key, entry)
      this.recaller.reportKeyMutation(this, KEYS)
      this.recaller.reportKeyMutation(this, key)
    }
    return entry
  }

  * keys () {
    this.recaller.reportKeyAccess(this, KEYS)
    yield * this.#keys.keys()
  }

  get (key) {
    this.recaller.reportKeyAccess(this, key)
    return this.#keys.get(key)?.mirror
  }

  current (key) {
    this.recaller.reportKeyAccess(this, key)
    const entry = this.#keys.get(key)
    return entry?.draft ?? entry?.mirror
  }

  draftFor (key) {
    this.recaller.reportKeyAccess(this, key)
    return this.#keys.get(key)?.draft ?? null
  }

  checkout (key, signer, signerName) {
    if (!signer) throw new TypeError('Hub.checkout: a draft needs a signer — that is what makes it authorable')
    const entry = this.#entry(key)
    if (entry.draft) return entry.draft
    const draft = new WritableStreamoRecord({ recaller: this.recaller })
    draft.copyFrom(entry.mirror, entry.mirror.lastCommit?.dataAddress ?? -1)
    draft.attachSigner(signer, signerName)
    entry.draft = draft
    this.recaller.reportKeyMutation(this, key)
    return draft
  }

  discard (key) {
    const entry = this.#keys.get(key)
    if (!entry?.draft) return false
    entry.draft = null
    this.recaller.reportKeyMutation(this, key)
    return true
  }

  forget (key) {
    if (!this.#keys.delete(key)) return false
    this.recaller.reportKeyMutation(this, KEYS)
    this.recaller.reportKeyMutation(this, key)
    return true
  }

  receive (key, sync) {
    if (!this.upstream || sync !== this.upstream) {
      throw new Error('Hub.receive: only the upstream Sync may write canon')
    }
    return this.#entry(key).mirror
  }

  _materialize (key) {
    const entry = this.#entry(key)
    entry.compat ??= new Mirror({ publicKeyHex: key, local: entry.mirror, recaller: this.recaller })
    return entry.compat
  }

  async want (key) {
    const mirror = this.#entry(key).mirror
    if (this.upstream) await this.upstream.want(key)
    return mirror
  }
}
