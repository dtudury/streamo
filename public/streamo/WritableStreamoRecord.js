import { Streamo, changedPaths } from './Streamo.js'
import { StreamoRecord } from './StreamoRecord.js'
import { Signature } from './Signature.js'
import { arraysEqual, chainHashOf } from './utils.js'

export function hasAuthorSurface (x) {
  return x != null && typeof x.attachSigner === 'function'
}

async function fetchSnapshot (input) {
  let urlString = input
  if (!input.includes('://')) {
    urlString = (input.includes(':') ? 'http://' : 'https://') + input
  }
  const url = new URL(urlString)

  const isDefaultPort =
    (url.protocol === 'http:' && (url.port === '' || url.port === '80')) ||
    (url.protocol === 'https:' && (url.port === '' || url.port === '443'))
  const host = isDefaultPort ? url.hostname : url.host

  const keyMatch = url.pathname.match(/^\/streams\/([0-9a-f]{66})\/?$/)
  let keyHex
  if (keyMatch) {
    keyHex = keyMatch[1]
  } else {
    const infoUrl = new URL('/api/info', url)
    const info = await fetch(infoUrl).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${infoUrl}`)
      return r.json()
    })
    keyHex = info.primaryKeyHex
    if (!keyHex) throw new Error(`${infoUrl} did not return primaryKeyHex`)
  }

  const rawUrl = new URL(`/streams/${keyHex}/raw`, url)
  const buf = await fetch(rawUrl).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${rawUrl}`)
    return r.arrayBuffer()
  })

  const repo = new StreamoRecord()
  const writer = repo.makeWritableStream().getWriter()
  await writer.write(new Uint8Array(buf))

  return { repo, host, keyHex }
}

export class WritableStreamoRecord extends StreamoRecord {
  #signer = null
  #signerName = null
  #signing = false
  #signPending = false

  #locallyAuthoredOffset = Infinity

  defaultMessage = ''

  get locallyAuthoredOffset () {
    this.recaller.reportKeyAccess(this, 'locallyAuthoredOffset')
    return this.#locallyAuthoredOffset
  }

  _markAuthoredAtOffset (offset) {
    if (offset >= this.#locallyAuthoredOffset) return
    this.#locallyAuthoredOffset = offset
    this.recaller.reportKeyMutation(this, 'locallyAuthoredOffset')
  }

  attachSigner (signer, name) {
    this.#signer = signer
    this.#signerName = name
  }

  get hasSigner () { return this.#signer !== null }

  #scheduleSign () {
    if (!this.#signer) return
    if (this.isClosed) return
    if (this.#signing) { this.#signPending = true; return }
    this.#signing = true
    this.sign(this.#signer, this.#signerName)
      .then(() => {
        this.#signing = false
        if (this.#signPending) {
          this.#signPending = false
          this.#scheduleSign()
        }
      })
      .catch(() => {
        this.#signing = false
        if (this.byteLength > this.signedLength) this.#scheduleSign()
      })
  }

  set (...args) {
    if (typeof args[0] === 'number') return Streamo.prototype.set.apply(this, args)
    const prevDataAddress = this.lastCommit?.dataAddress
    const working = this.checkout()
    working.set(...args)
    const result = this.commit(working, this.defaultMessage)
    const newDataAddress = this.lastCommit?.dataAddress
    for (const changed of changedPaths(this, prevDataAddress, newDataAddress)) {
      this.recaller.reportKeyMutation(this._chunks, JSON.stringify(changed))
    }
    return result
  }

  setRefs (...args) {
    const prevDataAddress = this.lastCommit?.dataAddress
    const working = this.checkout()
    working.setRefs(...args)
    const result = this.commit(working, this.defaultMessage)
    const newDataAddress = this.lastCommit?.dataAddress
    for (const changed of changedPaths(this, prevDataAddress, newDataAddress)) {
      this.recaller.reportKeyMutation(this._chunks, JSON.stringify(changed))
    }
    return result
  }

  checkout () {
    const working = new Streamo({ name: 'checkout' })
    const commit = this.lastCommit
    if (commit) this._applyClone(working, commit.dataAddress)
    return working
  }

  commit (workingStreamo, message = '', options = {}) {
    if (workingStreamo.byteLength === 0) throw new Error('nothing to commit')
    const { remoteParent, date = new Date() } = options
    const parentAddr = super.valueAddress
    const parent = parentAddr >= 0 ? parentAddr : undefined
    const authoredFrom = this.byteLength
    const sharedThrough = this.lastCommit?.dataAddress ?? -1
    const copied = this.copyFrom(workingStreamo, workingStreamo.valueAddress, sharedThrough)
    const dataAddress = copied
    const record = { message, date, dataAddress, parent }
    if (remoteParent !== undefined) record.remoteParent = remoteParent
    const result = this.publish(this.encode(record))
    this._markAuthoredAtOffset(authoredFrom)
    this.#scheduleSign()
    return result
  }

  async merge (source, options = {}) {
    if (typeof source === 'string') {
      const { repo: fetched, host, keyHex } = await fetchSnapshot(source)
      source = fetched
      options = {
        ...options,
        remoteParent: options.remoteParent ?? { host, repo: keyHex }
      }
    }

    const normalizePath = p => p == null ? [] : Array.isArray(p) ? p : [p]
    const from = normalizePath(options.from)
    const into = normalizePath(options.into ?? options.from)
    const { policy = 'replace', remoteParent, message } = options

    if (policy !== 'replace') {
      throw new Error(`WritableStreamoRecord.merge: policy '${policy}' is reserved but not yet implemented; only 'replace' is supported in this version`)
    }
    if (!remoteParent || typeof remoteParent !== 'object' || !remoteParent.host || !remoteParent.repo) {
      throw new Error('WritableStreamoRecord.merge: options.remoteParent is required as { host, repo, dataAddress? }')
    }

    const sourceLast = source.lastCommit
    if (!sourceLast && remoteParent.dataAddress === undefined) {
      throw new Error('WritableStreamoRecord.merge: source has no commits and no explicit remoteParent.dataAddress given')
    }
    const citationAddress = remoteParent.dataAddress ?? sourceLast.dataAddress
    const citation = { host: remoteParent.host, repo: remoteParent.repo, dataAddress: citationAddress }

    let sourceValue = source.decode(citationAddress)
    for (const key of from) {
      if (sourceValue == null || typeof sourceValue !== 'object') {
        throw new Error(`WritableStreamoRecord.merge: source has no value at path [${from.join('.')}]`)
      }
      sourceValue = sourceValue[key]
    }
    if (sourceValue === undefined) {
      throw new Error(`WritableStreamoRecord.merge: source has no value at path [${from.join('.')}]`)
    }

    const working = this.checkout()
    if (into.length === 0) {
      working.set(sourceValue)
    } else if (working.get() === undefined) {
      let wrapped = sourceValue
      for (let i = into.length - 1; i >= 0; i--) {
        wrapped = { [into[i]]: wrapped }
      }
      working.set(wrapped)
    } else {
      working.set(...into, sourceValue)
    }

    const wasEmpty = !this.lastCommit
    const defaultMessage = wasEmpty
      ? `fork from ${remoteParent.host}`
      : `merge from ${remoteParent.host}`
    return this.commit(working, message ?? defaultMessage, { remoteParent: citation })
  }

  async sign (signer, streamoName) {
    const before = this.byteLength
    const newBytes = this.slice(this.signedLength, this.byteLength)
    const chainHash = await chainHashOf(this.committedChainHash, newBytes)
    const compactRawBytes = await signer.sign(streamoName, chainHash)
    if (this.byteLength !== before) throw new Error('repo was modified while signing')
    const sig = new Signature(chainHash, compactRawBytes)
    this._markAuthoredAtOffset(before)
    this.publish(this.encode(sig))
    return sig
  }

  get isAuthorable () { return true }

  _reset () {
    super._reset()
    this.#locallyAuthoredOffset = Infinity
    this.recaller.reportKeyMutation(this, 'locallyAuthoredOffset')
  }
}
