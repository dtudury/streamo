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
