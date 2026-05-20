/**
 * @file Repo — Streamo + signed commits + the verified writer.
 *
 * **Repo extends Streamo** with two layers of "smarts" Streamo intentionally
 * doesn't have:
 *
 * 1. **Commit semantics.** Every `set()` becomes a signed commit — a
 *    record `{ message, date, dataAddress, parent, remoteParent? }`. The
 *    commit log is what flows over the wire during sync. `attachSigner`
 *    makes commits sign automatically, with concurrent commits batched
 *    into one signature.
 *
 * 2. **The verified writer** (`makeVerifiedWritableStream`) and its
 *    reactive flags (`conflictDetected`, `verificationFailed`). Streamo
 *    can't tell whether incoming bytes "fit" — that's identity-aware
 *    work (it requires a pubkey and chain-alignment state). Repo gates
 *    incoming wire chunks: a SIG must crypto-verify under the expected
 *    pubkey, its chainHash must extend our current chain, AND the
 *    staged chunks must land at addresses where their internal refs
 *    will resolve correctly. Any failure throws AND raises the
 *    appropriate reactive flag for UI to surface.
 *
 * **`remoteParent`** cites another author's value at a specific content
 * address — `{ host, repo, dataAddress }`. It's informational (a soft
 * cryptographic footnote), not a sync dependency. Two natural shapes:
 *   - *Fork commit*  (no local parent, remoteParent set) — start of a
 *     new Repo from someone else's value
 *   - *Merge commit* (both parent and remoteParent set) — combine values
 *     from this Repo and somewhere else; the new commit doesn't depend
 *     on the source from then on
 *
 * **Conflicts** are not states the Repo carries by design — they're
 * runtime "these bytes can't be appended" failures detected at the
 * verified writer. The `conflictDetected` flag is the reactive surfacing
 * of that failure for UI; the chain itself stays clean (rejected batches
 * never land).
 *
 * See design.md §8.
 */
import { Streamo, changedPaths, foldChunk, arraysEqual } from './Streamo.js'
import { verifySignature } from './Signer.js'

/**
 * Fetch a Repo snapshot from an HTTP source URL or host shorthand.
 * Returns `{ repo, host, keyHex }` — the loaded Repo plus enough context
 * to construct a `remoteParent` citation automatically.
 *
 * Accepted inputs:
 *   - `http://host:port/streams/<keyHex>` — full URL with explicit key
 *   - `https://host/streams/<keyHex>`     — TLS, default port
 *   - `https://host`                       — TLS, no path; falls through
 *                                            to /api/info for primaryKeyHex
 *   - `host:port`                          — shorthand; assumes http
 *   - `host`                               — shorthand; assumes https
 *
 * `host` in the returned object drops the port when it's the default for
 * the protocol (so `remoteParent.host` is canonically e.g. `streamo.dev`
 * rather than `streamo.dev:443`).
 */
async function fetchSnapshot (input) {
  // Normalize bare host shorthand to a full URL.  The heuristic: if a
  // port is given, assume non-TLS (local dev convention); otherwise
  // assume TLS (production convention).  Callers can always pass a
  // full URL to override.
  let urlString = input
  if (!input.includes('://')) {
    urlString = (input.includes(':') ? 'http://' : 'https://') + input
  }
  const url = new URL(urlString)

  const isDefaultPort =
    (url.protocol === 'http:' && (url.port === '' || url.port === '80')) ||
    (url.protocol === 'https:' && (url.port === '' || url.port === '443'))
  const host = isDefaultPort ? url.hostname : url.host

  // If the URL path matches /streams/<66-hex>, use that; else
  // fetch /api/info for primaryKeyHex.
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

  const repo = new Repo()
  const writer = repo.makeWritableStream().getWriter()
  await writer.write(new Uint8Array(buf))

  return { repo, host, keyHex }
}

/**
 * A Streamo whose values are commit records.
 *
 * Every write goes through a commit: checkout() → set() → commit(). This makes
 * every connected device an equal author — writes are content-addressed,
 * signed, and append-only. The server is just another peer; the keypair is the
 * identity and the commit log is the source of truth.
 *
 * get() and set() are overridden to be transparent: callers use the same API
 * as Streamo. get() reads from the last commit's dataAddress; set() creates a
 * new commit automatically.
 *
 * The raw streamo (commit log) is what gets synced over WebSocket, S3, and
 * archives. checkout() returns a working Streamo at any commit's dataAddress
 * for read-only inspection or direct use with the explicit commit() API.
 */
export class Repo extends Streamo {
  #signer      = null
  #signerName  = null
  #signing     = false
  #signPending = false
  // Reactive error flags raised by makeVerifiedWritableStream. The verifier
  // *also* throws, so default-uncaught code crashes its connection — these
  // flags exist for code that wants to be smarter (UI banner, recovery flow,
  // dropping the offending peer). Never auto-cleared: a conflict is a fact
  // about the local store until something deliberate resolves it.
  #conflictDetected   = false
  #verificationFailed = false

  /**
   * Default commit message attached to every commit made via set() / setRefs().
   * Empty by default — clients opt in to set this for attribution. The chat web
   * client sets 'web' so commits are visibly distinguishable from a CLI
   * client's. Not enforced; explicit commit(working, msg) wins.
   */
  defaultMessage = ''

  /**
   * Attach a signer so every commit is automatically signed.
   * Concurrent commits are batched: if a sign is in flight when another
   * commit lands, one more sign runs after the current one finishes,
   * covering all accumulated commits in a single signature.
   *
   * @param {import('./Signer.js').Signer} signer
   * @param {string} name  stream name passed to signer.keysFor()
   */
  attachSigner (signer, name) {
    this.#signer     = signer
    this.#signerName = name
  }

  #scheduleSign () {
    if (!this.#signer) return
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
  /**
   * The latest commit record, or null if nothing has been committed yet.
   * Registers a reactive dependency on the commit log length.
   * @returns {{ message: string, date: Date, dataAddress: number, parent: number|undefined, remoteParent?: { host: string, repo: string, dataAddress: number } }|null}
   */
  get lastCommit () {
    this.recaller.reportKeyAccess(this, 'length')
    // Use super.valueAddress (Streamo impl) to bypass our get() override and
    // avoid a circular dependency: our get() calls lastCommit, lastCommit
    // must not call our get().
    const address = super.valueAddress
    if (address < 0) return null
    const value = this.decode(address)
    if (!value || typeof value.message !== 'string' || !(value.date instanceof Date)) return null
    return value
  }

  /**
   * Decode the value at a path, reading from the last commit's dataAddress.
   * Falls back to Streamo.get() if no commits exist yet.
   *
   * Registers reactive dependencies so watchers re-run when new commits land.
   *
   * @param {...(number|string)} args
   * @returns {any}
   */
  get (...args) {
    if (typeof args[0] === 'number') return super.get(...args)
    const commit = this.lastCommit  // registers 'length' dependency
    if (!commit) return super.get(...args)
    this.recaller.reportKeyAccess(this, JSON.stringify(args))
    if (args.length === 0) return this.decode(commit.dataAddress)
    let value = this.decode(commit.dataAddress)
    for (const key of args) {
      if (value == null) return undefined
      value = value[key]
    }
    return value
  }

  /**
   * Write a value by creating a new commit: checkout → set → commit.
   *
   * Signature: set([address,] ...path, value)  — same as Streamo.set().
   * Path-level reactive mutations are fired after commit so watchers only
   * watching specific paths get precise notifications.
   *
   * @param {...(number|string|any)} args
   * @returns {number} address of the new commit record
   */
  set (...args) {
    if (typeof args[0] === 'number') return super.set(...args)
    const prevDataAddress = this.lastCommit?.dataAddress
    const working = this.checkout()
    working.set(...args)
    const result = this.commit(working, this.defaultMessage)
    const newDataAddress = this.lastCommit?.dataAddress
    for (const changed of changedPaths(this, prevDataAddress, newDataAddress)) {
      this.recaller.reportKeyMutation(this, JSON.stringify(changed))
    }
    return result
  }

  /**
   * Like Streamo.getRefs() but reads from the last commit's dataAddress.
   *
   * @param {...string} path
   * @returns {Object|number|undefined}
   */
  getRefs (...path) {
    const commit = this.lastCommit
    if (!commit) return super.getRefs(...path)
    let address = commit.dataAddress
    for (const key of path) {
      const refs = this.asRefs(address)
      if (typeof refs === 'number') return undefined
      address = Array.isArray(refs) ? refs[+key] : refs[key]
      if (address === undefined) return undefined
    }
    return this.asRefs(address)
  }

  /**
   * Like Streamo.setRefs() but auto-commits via checkout → setRefs → commit.
   *
   * @param {...(string|number)} args  ...path, address
   * @returns {number} address of the new commit record
   */
  setRefs (...args) {
    const prevDataAddress = this.lastCommit?.dataAddress
    const working = this.checkout()
    working.setRefs(...args)
    const result = this.commit(working, this.defaultMessage)
    const newDataAddress = this.lastCommit?.dataAddress
    for (const changed of changedPaths(this, prevDataAddress, newDataAddress)) {
      this.recaller.reportKeyMutation(this, JSON.stringify(changed))
    }
    return result
  }

  /**
   * Clone the repository at the last commit's data address.
   * The returned Streamo's get() immediately returns the last committed value.
   * Returns an empty Streamo if nothing has been committed yet.
   * @returns {Streamo}
   */
  checkout () {
    const commit = this.lastCommit
    if (!commit) return new Streamo()
    return this.clone(commit.dataAddress, { name: 'checkout' })
  }

  /**
   * The committed data from the last commit, decoded.
   * Returns undefined if nothing has been committed yet.
   * @returns {any}
   */
  get files () {
    const commit = this.lastCommit
    if (!commit) return undefined
    return this.decode(commit.dataAddress)
  }

  /**
   * Iterate commits from newest to oldest.
   * @yields {{ message: string, date: Date, dataAddress: number, parent: number|undefined }}
   */
  * history () {
    let commit = this.lastCommit
    while (commit) {
      yield commit
      commit = commit.parent !== undefined ? this.decode(commit.parent) : null
    }
  }

  /**
   * Copy the current value of workingStreamo into the repository and append a
   * commit record referencing it by address.
   *
   * Uses super.valueAddress (skipping any trailing signatures) to find the
   * correct parent commit address rather than byteLength - 1, which could
   * point to a signature chunk when sign-in auto-signs after each commit.
   *
   * When `options.remoteParent` is set, the commit cites another author's
   * value: `{ host, repo, dataAddress }`. The local commit is still signed
   * by us and append-only on our chain — `remoteParent` is a footnote, not
   * a merge. Anyone holding the cited stream can verify the citation by
   * decoding the value at `remoteParent.dataAddress` in that stream.
   *
   * `options.date` overrides the default "now" — useful when replaying
   * pre-existing history (e.g. seeding a streamo from git log).
   *
   * @param {Streamo} workingStreamo
   * @param {string} [message='']
   * @param {{ remoteParent?: { host: string, repo: string, dataAddress: number }, date?: Date }} [options]
   * @returns {number} address of the new commit record
   */
  commit (workingStreamo, message = '', options = {}) {
    if (workingStreamo.byteLength === 0) throw new Error('nothing to commit')
    const { remoteParent, date = new Date() } = options
    const parentAddr = super.valueAddress
    const parent = parentAddr >= 0 ? parentAddr : undefined
    // Use valueAddress (the explicit top-value pointer), not byteLength-1.
    // When working.set encodes a value whose outermost subcode already exists
    // in working's content map (dedup — e.g. toggling back to a state the
    // repo has seen before), byteLength does NOT grow but valueAddress
    // correctly points at the existing address of the just-set value.
    // byteLength-1 would land on an unchanged tail, citing the wrong data.
    const dataAddress = this.copyFrom(workingStreamo, workingStreamo.valueAddress)
    const record = { message, date, dataAddress, parent }
    if (remoteParent !== undefined) record.remoteParent = remoteParent
    const code = this.encode(record)
    const result = this.append(code)
    this.#scheduleSign()
    return result
  }

  /**
   * Incorporate a slice of `source`'s value into this repo as a single
   * signed commit, with `remoteParent` set to cite the source.
   *
   * **Mode**: this version supports only `policy: 'replace'` — source's
   * value at `from` REPLACES our value at `into`.  Sibling keys at `into`'s
   * parent are preserved (because `commit` works on a path-set into the
   * working stream, not a whole-value overwrite).  The descending
   * attribute-walk policies (`'theirs'`, `'ours'`, `'throw'`) are reserved
   * in the API but not yet implemented — they need real workloads to
   * settle their defaults (absent-vs-deleted, Uint8Array semantics, etc).
   *
   * **Two shapes fall out naturally:**
   *   - *Fork*  — merge into an empty repo → no local parent + remoteParent
   *   - *Pull-overwrite* — merge into an existing chain → both set
   *
   * @param {Repo|string} source — the repo to read from.  When a string,
   *   resolves as an HTTP URL (`http(s)://host[:port]/streams/<keyHex>`)
   *   or a host shorthand (`host[:port]`, with `/api/info` discovering
   *   the primary key).  URL form auto-fills `remoteParent.host` and
   *   `remoteParent.repo` from the resolved URL when the caller leaves
   *   them blank.
   * @param {object} options
   * @param {string|Array<string|number>} [options.from=[]] — path on source
   *   to read; `[]` or omitted means the whole value. String shorthand
   *   `'files'` is normalized to `['files']`.
   * @param {string|Array<string|number>} [options.into=options.from] — path
   *   on this repo to write at
   * @param {'replace'} [options.policy='replace'] — only `'replace'` is
   *   implemented in this version
   * @param {{ host: string, repo: string, dataAddress?: number }}
   *   options.remoteParent — REQUIRED.  `host` and `repo` describe the
   *   source's location and identity (the Repo class doesn't store either
   *   itself, so callers provide them).  `dataAddress` defaults to
   *   `source.lastCommit.dataAddress` (the citation points at source's
   *   most recent value).
   * @param {string} [options.message] — commit message; defaults to either
   *   `"fork from <host>"` (empty target) or `"merge from <host>"` (existing)
   * @returns {number} address of the new commit record
   */
  async merge (source, options = {}) {
    // URL-source: resolve to an in-memory Repo, and auto-fill the
    // remoteParent context from the URL itself.  The URL form encodes
    // enough about the source (host + keyHex) that requiring the caller
    // to also pass remoteParent would be redundant — but they can
    // override if they want (e.g. to record a different canonical host).
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
      throw new Error(`Repo.merge: policy '${policy}' is reserved but not yet implemented; only 'replace' is supported in this version`)
    }
    if (!remoteParent || typeof remoteParent !== 'object' || !remoteParent.host || !remoteParent.repo) {
      throw new Error('Repo.merge: options.remoteParent is required as { host, repo, dataAddress? }')
    }

    // Citation: the address on source's stream we're incorporating from.
    // Defaults to source's latest commit's data address; callers can cite
    // a specific historical address via remoteParent.dataAddress.
    const sourceLast = source.lastCommit
    if (!sourceLast && remoteParent.dataAddress === undefined) {
      throw new Error('Repo.merge: source has no commits and no explicit remoteParent.dataAddress given')
    }
    const citationAddress = remoteParent.dataAddress ?? sourceLast.dataAddress
    const citation = { host: remoteParent.host, repo: remoteParent.repo, dataAddress: citationAddress }

    // Read source's value at the citation, walk into `from`.
    let sourceValue = source.decode(citationAddress)
    for (const key of from) {
      if (sourceValue == null || typeof sourceValue !== 'object') {
        throw new Error(`Repo.merge: source has no value at path [${from.join('.')}]`)
      }
      sourceValue = sourceValue[key]
    }
    if (sourceValue === undefined) {
      throw new Error(`Repo.merge: source has no value at path [${from.join('.')}]`)
    }

    // Apply 'replace': set our value at `into` to source's slice.  Empty
    // target needs the wrapping object materialized (same pattern as
    // fileSync's setRepoFiles for an empty repo).
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

  // ── The verifier (identity-aware; lives on Repo, not Streamo) ──────────
  // Streamo has a stateless `verify(sig, publicKey)` helper for one-shot
  // crypto checks. The stateful, identity-bound verified writer below —
  // including the conflictDetected / verificationFailed reactive flags —
  // belongs at the Repo layer: it consumes a wire stream, holds session
  // state (pendingAcc, staged, wireByteLength), and surfaces failures to
  // application UI.

  /**
   * Reactive: true once makeVerifiedWritableStream has rejected a SIG whose
   * chainHash didn't match the locally-folded chain, OR whose staged
   * chunks would land at addresses where their references resolve wrong.
   *
   * This is a *conflict*, not a fork in streamo's vocabulary — a fork is
   * a deliberate new Repo with a lineage note; a conflict is the runtime
   * "these bytes can't be appended" failure when two devices using the same
   * signing key have produced incompatible chains.
   */
  get conflictDetected () {
    this.recaller.reportKeyAccess(this, 'conflictDetected')
    return this.#conflictDetected
  }

  /**
   * Reactive: true once makeVerifiedWritableStream has rejected a SIG whose
   * crypto signature didn't verify under the expected pubkey. Indicates an
   * attack or corruption — the appropriate response is to drop the peer,
   * not to merge.
   */
  get verificationFailed () {
    this.recaller.reportKeyAccess(this, 'verificationFailed')
    return this.#verificationFailed
  }

  /**
   * Like Streamo.makeWritableStream(), but gates every chunk against the
   * author's chain before it can corrupt the store.
   *
   * Non-signature chunks are *staged* (folded into a tentative chainHash
   * but not appended). When a SIGNATURE arrives, three checks fire:
   *   1. chain        — sig.chainHash must equal the tentative chainHash
   *   2. crypto       — sig.compactRawBytes must verify under `publicKey`
   *   3. alignment    — local byteLength must match the wire's pre-staged
   *                     position so staged chunks land where their internal
   *                     references expect (otherwise decodes corrupt)
   * If all pass, the staged chunks and the SIG are appended in order. If
   * any fails, the stream errors and the staged batch is discarded — the
   * store is never polluted with chunks that no SIG covers.
   *
   * @param {Uint8Array} publicKey
   * @param {number} [maxFrameSize]
   * @returns {WritableStream}
   */
  makeVerifiedWritableStream (publicKey, maxFrameSize = 64 * 1024 * 1024) {
    const self = this
    let buf = new Uint8Array(0)
    // Start from the 32-zero seed because the wire today replays from byte 0
    // — the sender's makeReadableStream emits from offset 0, so we have to
    // fold matching chunks from the same point. A future cleanup could
    // change the wire to send "anchored batches" (sender skips bytes the
    // receiver already has, verifier starts from committedChainHash), but
    // that's a wire-protocol change not yet done.
    let pendingChainHash = new Uint8Array(32)
    let staged = [] // new (not-already-present) non-sig chunks awaiting a covering SIG
    // Cumulative bytes consumed from the wire. Used by the alignment check
    // at sig commit so staged chunks land at addresses matching the wire's
    // expected positions.
    let wireByteLength = 0
    return new WritableStream({
      async write (incoming) {
        const next = new Uint8Array(buf.length + incoming.length)
        next.set(buf); next.set(incoming, buf.length)
        buf = next
        while (buf.length >= 4) {
          const len = new Uint32Array(buf.slice(0, 4).buffer)[0]
          if (len === 0) throw new Error('malformed frame: zero-length chunk')
          if (len > maxFrameSize) throw new Error(`malformed frame: length ${len} exceeds ${maxFrameSize}`)
          if (buf.length < 4 + len) break
          const code = buf.slice(4, 4 + len)
          buf = buf.slice(4 + len)

          const alreadyHave = self.addressOf(code) !== undefined
          const codec = self.footerToCodec[code.at(-1)]

          if (codec?.type === 'SIGNATURE') {
            const sig = self.decode(code)
            if (!arraysEqual(sig.chainHash, pendingChainHash)) {
              // Chain conflict: honest signer, conflicting history. The
              // signer's other device signed over a chunk sequence we don't
              // share. Raise the reactive flag *before* throwing so watchers
              // see it even when the throw kills the connection.
              self.#conflictDetected = true
              self.recaller.reportKeyMutation(self, 'conflictDetected')
              throw new Error('signature chainHash does not match the local chain')
            }
            const valid = await verifySignature(publicKey, sig.chainHash, sig.compactRawBytes)
            if (!valid) {
              // Crypto failure: signature doesn't verify under expected
              // pubkey. Different threat from a conflict — separate flag
              // so UX can respond differently (drop the peer, not merge).
              self.#verificationFailed = true
              self.recaller.reportKeyMutation(self, 'verificationFailed')
              throw new Error('signature verification failed')
            }
            // Alignment check: staged chunks were encoded with internal
            // references (e.g. COMMIT.dataAddress) pointing to byte
            // positions in the SENDER's chain. We can only safely append
            // them if our local byteLength equals the wire's position right
            // before them — otherwise the staged chunks land at addresses
            // where their references resolve to the wrong bytes, corrupting
            // decodes. Catches the "local has signed content past the last
            // shared sig" case (multi-tab offline writes).
            if (staged.length > 0) {
              const stagedTotal = staged.reduce((sum, c) => sum + c.length, 0)
              const expectedLocalByteLength = wireByteLength - stagedTotal
              if (self.byteLength !== expectedLocalByteLength) {
                self.#conflictDetected = true
                self.recaller.reportKeyMutation(self, 'conflictDetected')
                throw new Error(
                  `local store diverged from wire: wire expects byteLength ${expectedLocalByteLength} ` +
                  `for staged chunks but local is at ${self.byteLength}`
                )
              }
            }
            // Commit batch: append staged chunks (all new), then the SIG itself.
            for (const c of staged) self.append(c)
            staged = []
            if (!alreadyHave) self.append(code)
            // pendingChainHash stays at sig.chainHash; next non-sig chunks fold from here.
          } else {
            pendingChainHash = await foldChunk(pendingChainHash, code)
            if (!alreadyHave) staged.push(code)
          }
          wireByteLength += code.length
        }
      }
    })
  }
}
