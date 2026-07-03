/**
 * @file FolderRecord — the files-and-mounts lens over a StreamoRecord.
 *
 * The type tower so far:
 *
 *   Streamo               — bytes ↔ values; identity-blind codec
 *   StreamoRecord         — Streamo + chain-of-commits interpretation
 *   WritableStreamoRecord — StreamoRecord + author surface
 *
 * Beyond that tower, the codebase has long carried unwritten conventions:
 * `value.files['<path>']` is a files map; `value.files['mounts.json']`
 * declares mount routing to other Records. Web routing in
 * `repoFileServer` knows these conventions as magic strings. Without a
 * name, every consumer re-implements the same walk.
 *
 * FolderRecord names the lens. It's composition (not subclass) over a
 * StreamoRecord — same way StreamoRecord wraps Streamo with the chain
 * lens. You choose to view a Record as a folder; the bytes don't change.
 *
 * Surface:
 *   - files()    — the files map at value.files (or {} if absent)
 *   - mounts()   — parsed mounts table from files['mounts.json'].mounts
 *   - resolvePath(path) — walk files first, then mounts (longest-prefix,
 *                         cycle-safe, pin-aware), returning the leaf
 *                         value or null
 *
 * Mounts and the wire: `resolvePath` follows mounts via
 * `registry._materialize`. For local-only use (relay already has the
 * bytes), that's sufficient. For over-the-wire use (a thin client
 * pulling from a remote relay), pass `session` — FolderRecord will
 * `session.subscribe(pubkey)` for each mount target it traverses and
 * wait for materialization before recursing.
 *
 * Conventions ported verbatim from repoFileServer's resolveInRecord
 * (see public/streamo/repoFileServer.js). Future refactor: have
 * repoFileServer call this; conventions then live in one place. For
 * now they live in two, kept in sync by the same author having both
 * files in front of them.
 */

const PUBKEY_HEX_RE = /^[0-9a-f]{66}$/

// Flat-shape convention (2026-06-04): value IS the files map. Filenames
// are top-level keys; `value['mounts.json'].mounts` is the routing table;
// `value['streamo.json']` is the meta. Records still in the 9.0.0 nested
// shape (value.files['<path>']) or 8.x legacy (value.mounts at top level)
// are not read by this reader — they need re-publishing in flat shape to
// be visible. See [[the-flatten-arc-2026-06-04]] in memory/notes/.

export class FolderRecord {
  /**
   * @param {import('./StreamoRecord.js').StreamoRecord} record
   * @param {import('./StreamoRecordRegistry.js').StreamoRecordRegistry} [registry]
   * @param {object} [options]
   * @param {{ subscribe(pubkeyHex: string): Promise<unknown> }} [options.session]
   *   if present, subscribed to before following mounts (over-the-wire case)
   * @param {number} [options.materializeTimeoutMs=30000]
   *   how long to wait for a mounted record to materialize after subscribe
   */
  constructor (record, registry, options = {}) {
    this.record = record
    this.registry = registry
    this.session = options.session ?? null
    this.materializeTimeoutMs = options.materializeTimeoutMs ?? 30000
    // The (signer, signerName) tuple drives cross-Record writes through
    // ours:true mounts. signerName is what was passed to attachSigner —
    // the keysFor input. Child shards' signer-names derive deterministically
    // as `signerName + '/' + mountPrefix`. See [[keysFor-as-sharding-namespace]].
    this.signer = options.signer ?? null
    this.signerName = options.signerName ?? null
  }

  files () {
    if (!this.record.lastCommit) return {}
    const v = this.record.get()
    if (v != null && typeof v === 'object' && !(v instanceof Uint8Array)) return v
    return {}
  }

  mounts () {
    if (!this.record.lastCommit) return {}
    const mountsFile = this.record.get('mounts.json')
    if (!mountsFile || typeof mountsFile !== 'object' || mountsFile instanceof Uint8Array) return {}
    const m = mountsFile.mounts
    return (m != null && typeof m === 'object' && !(m instanceof Uint8Array)) ? m : {}
  }

  /**
   * Walk this Record's files first; on miss, walk mounts (longest-prefix
   * match) and recurse into the mounted Record. Cycle-safe per
   * resolution (visited tracked via pubkeyHex).
   *
   * @param {string} path  e.g. 'index.html' or 'lib/foo/bar.js'
   * @param {Set<string>} [visited]  internal: pubkeys traversed this walk
   * @returns {Promise<string | Uint8Array | object | null>}
   */
  async resolvePath (path, visited = new Set()) {
    // Files-first on this Record.
    if (this.record.lastCommit) {
      const direct = this.record.get(path)
      if (direct !== undefined) return direct
    }

    // Cycle detection.
    const myKey = this.record.publicKeyHex
    if (myKey && visited.has(myKey)) return null
    if (myKey) visited.add(myKey)

    // Longest-prefix mount match.
    const mounts = this.mounts()
    let bestPrefix = null
    for (const prefix of Object.keys(mounts)) {
      const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      if (path === bare || path.startsWith(prefix)) {
        if (!bestPrefix || prefix.length > bestPrefix.length) bestPrefix = prefix
      }
    }
    if (!bestPrefix) return null

    const mount = mounts[bestPrefix]
    if (!mount || typeof mount.key !== 'string') return null
    if (!PUBKEY_HEX_RE.test(mount.key)) return null
    if (!this.registry) return null

    // Subscribe-on-follow (over-the-wire case) — request bytes for this
    // mount target from the relay before recursing.
    if (this.session) {
      await this.session.subscribe(mount.key)
    }

    const mountedRepo = await this.registry._materialize(mount.key)

    // Wait for the mounted record's commit to be visible. With a session,
    // bytes are still flowing in from the relay; without one, the record
    // is already at whatever state the registry has.
    if (this.session) {
      await this.#waitForCommit(mountedRepo)
    }

    const innerPath = path.startsWith(bestPrefix) ? path.slice(bestPrefix.length) : ''
    const child = new FolderRecord(mountedRepo, this.registry, {
      session: this.session,
      materializeTimeoutMs: this.materializeTimeoutMs
    })
    return child.resolvePath(innerPath || 'index.html', visited)
  }

  /**
   * Write `value` to this Record at top-level key `path`. Uses
   * `repo.update` (the await-the-relay-ack primitive) so the returned
   * Promise resolves only after streamo.dev has acknowledged the bytes.
   *
   * Bounded shape (2026-06-04): only commits to THIS Record. If `path`
   * falls under a mount prefix, throws — cross-Record writes through
   * mounts are a queued primitive that needs signer-routing across
   * mount targets (the `ours: true` marker enables it but we haven't
   * built the lookup machinery yet). For cross-Record writes today,
   * construct a FolderRecord around the mounted Record and write to it
   * directly with that Record's signer.
   *
   * @param {string} path  top-level key (e.g. 'mounts.json' or 'entries.json')
   * @param {any} value    the file's value — strings, Uint8Arrays, plain
   *                       objects/arrays (.json-shape files), etc.
   * @param {object} [options]  forwarded to repo.update (e.g. `{message}`)
   */
  async write (path, value, options = {}) {
    const mountPrefix = this.#mountPrefixFor(path)
    if (mountPrefix) {
      const mount = this.mounts()[mountPrefix]
      const ours = mount && mount.ours === true
      if (!ours) {
        throw new Error(`FolderRecord.write: '${path}' is under mount '${mountPrefix}' (read-only mount — we don't own it)`)
      }
      if (!this.signer || !this.signerName) {
        throw new Error(`FolderRecord.write: '${path}' is under ours:true mount '${mountPrefix}' — pass {signer, signerName} to FolderRecord's constructor to enable cross-Record writes (we derive the child signer via signer.keysFor(parentName + '/' + mountPrefix))`)
      }
      if (!this.registry) {
        throw new Error(`FolderRecord.write: '${path}' is under ours:true mount '${mountPrefix}' but FolderRecord has no registry to materialize the mounted Record`)
      }
      // Derive the child shard's keysFor name + verify it matches the mount target.
      // Convention: parent's keysFor name + '/' + mount prefix. Same root signer
      // applied to a different keysFor name = different deterministic keypair.
      const childName = this.signerName + '/' + mountPrefix
      const { publicKey } = await this.signer.keysFor(childName)
      const { bytesToHex } = await import('./utils.js')
      const derivedHex = bytesToHex(publicKey)
      if (derivedHex !== mount.key) {
        throw new Error(`FolderRecord.write: derived child pubkey ${derivedHex.slice(0, 16)}... doesn't match mount target ${mount.key.slice(0, 16)}... — mount '${mountPrefix}' was set up with a different naming convention than parent+slash+prefix; either fix mounts.json to match the derived pubkey or use a different child-name convention`)
      }
      // Materialize the mounted Record + attach the derived signer-name.
      const mountedRepo = await this.registry._materialize(mount.key)
      if (typeof mountedRepo.attachSigner !== 'function') {
        throw new Error(`FolderRecord.write: mounted Record for '${mountPrefix}' is not Writable; registry factory must return WritableStreamoRecord for ours:true mount targets`)
      }
      mountedRepo.attachSigner(this.signer, childName)
      // Recurse into a child FolderRecord scoped to the mounted Record.
      const child = new FolderRecord(mountedRepo, this.registry, {
        session: this.session,
        materializeTimeoutMs: this.materializeTimeoutMs,
        signer: this.signer,
        signerName: childName
      })
      const innerPath = path.startsWith(mountPrefix) ? path.slice(mountPrefix.length) : ''
      return child.write(innerPath, value, options)
    }
    if (typeof this.record.update !== 'function') {
      throw new Error('FolderRecord.write: this Record is not Writable (slim StreamoRecord has no author surface — use WritableStreamoRecord)')
    }
    return this.record.update(
      v => ({ ...(v ?? {}), [path]: value }),
      options
    )
  }

  /**
   * Route a whole files map through the mount tree in one call. Groups
   * files by destination Record (home vs each ours:true mount), then
   * commits one update per destination — so a single fileSync run that
   * touches files in 5 shards produces 5 commits (one per Record), not
   * one-per-file.
   *
   * Read-only mounts (no ours:true) silently swallow their files —
   * those shards belong to someone else; we don't author there. The
   * substrate is honest about it (reading the shard still works), the
   * write-side just no-ops.
   *
   * @param {Object} filesMap  { 'path/to/file': value, ... }
   * @param {object} [options]
   * @param {boolean} [options.replace=false]  if true, each destination
   *   Record's value is REPLACED with the routed files map (fileSync's
   *   mirror-disk-to-Record semantics). Default merges into existing
   *   value (preserving sibling files at the destination).
   * @param {string} [options.message]  forwarded to repo.update
   */
  async writeMany (filesMap, options = {}) {
    const { replace = false, message, date, remoteParent, mountsOnly = false } = options
    const updateOpts = {}
    if (message !== undefined) updateOpts.message = message
    if (date !== undefined) updateOpts.date = date
    if (remoteParent !== undefined) updateOpts.remoteParent = remoteParent

    const mounts = this.mounts()
    const homeFiles = {}
    const shardFiles = {}  // { mountPrefix: { innerPath: value } }

    for (const [path, value] of Object.entries(filesMap)) {
      // Find longest-prefix mount match.
      let bestPrefix = null
      for (const prefix of Object.keys(mounts)) {
        const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
        if (path === bare || path.startsWith(prefix)) {
          if (!bestPrefix || prefix.length > bestPrefix.length) bestPrefix = prefix
        }
      }
      if (!bestPrefix) {
        // mountsOnly: drop anything not routed and not the mount table itself.
        if (mountsOnly && path !== 'mounts.json') continue
        homeFiles[path] = value
        continue
      }
      const mount = mounts[bestPrefix]
      if (mount && mount.ours === true) {
        const innerPath = path.startsWith(bestPrefix) ? path.slice(bestPrefix.length) : ''
        if (!innerPath) continue  // path === mount prefix bare; skip
        if (!shardFiles[bestPrefix]) shardFiles[bestPrefix] = {}
        shardFiles[bestPrefix][innerPath] = value
      }
      // Non-ours mount: silently skip — read-only territory.
    }

    // Commit home Record's files.
    if (Object.keys(homeFiles).length > 0) {
      if (typeof this.record.update !== 'function') {
        throw new Error('FolderRecord.writeMany: home Record is not Writable')
      }
      await this.record.update(
        v => replace ? homeFiles : { ...(v ?? {}), ...homeFiles },
        updateOpts
      )
    }

    // Commit each shard. Recurse via writeMany so nested sharding works.
    for (const [mountPrefix, files] of Object.entries(shardFiles)) {
      if (!this.signer || !this.signerName) {
        throw new Error(`FolderRecord.writeMany: cross-Record writes for '${mountPrefix}' need {signer, signerName} on FolderRecord — ${Object.keys(files).length} files unroutable`)
      }
      if (!this.registry) {
        throw new Error(`FolderRecord.writeMany: cross-Record writes for '${mountPrefix}' need a registry — ${Object.keys(files).length} files unroutable`)
      }
      const mount = mounts[mountPrefix]
      const childName = this.signerName + '/' + mountPrefix
      const { publicKey } = await this.signer.keysFor(childName)
      const { bytesToHex } = await import('./utils.js')
      const derivedHex = bytesToHex(publicKey)
      if (derivedHex !== mount.key) {
        throw new Error(`FolderRecord.writeMany: derived child pubkey ${derivedHex.slice(0, 16)}... doesn't match mount target ${mount.key.slice(0, 16)}... for '${mountPrefix}' — fix mounts.json to use the derived pubkey`)
      }
      const mountedRepo = await this.registry._materialize(mount.key)
      if (typeof mountedRepo.attachSigner !== 'function') {
        throw new Error(`FolderRecord.writeMany: mounted Record for '${mountPrefix}' is not Writable; registry factory must return WritableStreamoRecord for ours:true mounts`)
      }
      mountedRepo.attachSigner(this.signer, childName)
      const child = new FolderRecord(mountedRepo, this.registry, {
        session: this.session,
        materializeTimeoutMs: this.materializeTimeoutMs,
        signer: this.signer,
        signerName: childName
      })
      // mountsOnly is per-layer, not cascading — the child gets its files normally.
      await child.writeMany(files, { ...options, mountsOnly: false })
    }
  }

  /**
   * Longest-prefix mount match for a path. Returns the prefix key
   * (e.g. 'apps/chat/') or null if no mount covers the path. Mirrors
   * resolvePath's matching rules: trailing-slash optional, bare-prefix
   * match (path === 'apps/chat' as well as path.startsWith('apps/chat/')).
   */
  #mountPrefixFor (path) {
    const mounts = this.mounts()
    let best = null
    for (const prefix of Object.keys(mounts)) {
      const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      if (path === bare || path.startsWith(prefix)) {
        if (!best || prefix.length > best.length) best = prefix
      }
    }
    return best
  }

  /**
   * Reactive counterpart to `resolvePath`. Synchronous, returns the value
   * if known, `undefined` if pending (bytes not yet here). Called inside a
   * `recaller.watch(...)`, the watcher auto-re-fires when:
   *   - this Record's value at `path` arrives
   *   - mount targets get materialized into the registry
   *   - mount targets' chains advance
   * because record.get + registry.get + the mounted Record's get are all
   * reactive on the shared Recaller.
   *
   * Fire-and-forget side effects for pending mounts:
   *   - session.subscribe(mountKey) — tells the relay to start pushing bytes
   *   - registry._materialize(mountKey) — kicks off local materialization
   * Both are best-effort, errors swallowed. The watcher will re-fire when
   * their async work lands; the next call to resolveReactive returns the
   * value.
   *
   * David's evening insight (2026-06-04): reactivity is free when the
   * Recaller is shared. The substrate-articulate shape is "stop fighting
   * the substrate with imperative awaits" — exactly what this method
   * embodies.
   *
   * @param {string} path
   * @param {Set<string>} [visited]  cycle-detection set (fresh per call by default)
   * @returns {string | Uint8Array | object | undefined}
   */
  resolveReactive (path, visited = new Set()) {
    // Files-first on this Record (reactive — record.get registers the dep).
    if (this.record.lastCommit) {
      const direct = this.record.get(path)
      if (direct !== undefined) return direct
    }

    // Cycle detection.
    const myKey = this.record.publicKeyHex
    if (myKey && visited.has(myKey)) return undefined
    if (myKey) visited.add(myKey)

    // Longest-prefix mount match.
    const mounts = this.mounts()
    let bestPrefix = null
    for (const prefix of Object.keys(mounts)) {
      const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      if (path === bare || path.startsWith(prefix)) {
        if (!bestPrefix || prefix.length > bestPrefix.length) bestPrefix = prefix
      }
    }
    if (!bestPrefix) return undefined

    const mount = mounts[bestPrefix]
    if (!mount || typeof mount.key !== 'string') return undefined
    if (!PUBKEY_HEX_RE.test(mount.key)) return undefined
    if (!this.registry) return undefined

    // Try to get the mounted Record reactively — registry.get is reactive
    // on (registry, 'keys'), so this watcher will re-fire when the mount
    // target lands via _materialize.
    const mountedRepo = this.registry.get(mount.key)
    if (!mountedRepo) {
      // Fire-and-forget: kick off subscribe + materialize. The watcher
      // re-fires when either lands.
      if (this.session) this.session.subscribe(mount.key).catch(() => {})
      this.registry._materialize(mount.key).catch(() => {})
      return undefined
    }

    // Recurse into a child FolderRecord (signer/session propagate).
    const innerPath = path.startsWith(bestPrefix) ? path.slice(bestPrefix.length) : ''
    const child = new FolderRecord(mountedRepo, this.registry, {
      session: this.session,
      materializeTimeoutMs: this.materializeTimeoutMs,
      signer: this.signer,
      signerName: this.signerName
    })
    return child.resolveReactive(innerPath || 'index.html', visited)
  }

  #waitForCommit (repo) {
    if (repo.lastCommit) return Promise.resolve()
    const recaller = this.registry.recaller
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for record ${repo.publicKeyHex?.slice(0, 16)}… to materialize`)),
        this.materializeTimeoutMs
      )
      recaller.watch('folder-wait', () => {
        if (repo.lastCommit) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
  }
}
