import { StreamoRecord } from '../StreamoRecord.js'
import { WritableStreamoRecord } from '../WritableStreamoRecord.js'

const KEYS = Symbol('the keys this hub holds')

export class Hub {
  #mirrors = new Map()
  #drafts = new Map()
  #draftViews = new Map()
  #draftSigners = new Map()

  constructor ({ recaller }) {
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
    const draft = this.#drafts.get(key)
    if (!draft) return null
    let view = this.#draftViews.get(key)
    if (!view) {
      view = draft._applyView(new StreamoRecord({ recaller: this.recaller }))
      this.#draftViews.set(key, view)
    }
    return view
  }

  getCurrent (key) {
    return this.getDraft(key) ?? this.getMirror(key)
  }

  checkout (key, signer, signerName) {
    if (!signer) throw new TypeError('Hub.checkout: a draft needs a signer — that is what makes it authorable')
    const existing = this.#drafts.get(key)
    if (existing) {
      const owner = this.#draftSigners.get(key)
      if (owner !== signerName) {
        throw new Error('Hub.checkout: ' + key.slice(0, 8) + '… is checked out by ' +
          (owner ?? 'another signer') + '; getDraft() reads it without the pen')
      }
      return existing
    }
    const mirror = this.getMirror(key)
    const draft = new WritableStreamoRecord({ recaller: this.recaller })
    if (mirror.byteLength) mirror._applyClone(draft, mirror.byteLength - 1)
    draft.attachSigner(signer, signerName)
    this.#drafts.set(key, draft)
    this.#draftSigners.set(key, signerName)
    this.recaller.reportKeyMutation(this.#drafts, key)
    return draft
  }
}
