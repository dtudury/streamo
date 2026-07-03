import { subscribe } from '@parcel/watcher'
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { compile } from '@gerhobbelt/gitignore-parser'

const ALWAYS_IGNORE = '.env\n.DS_Store\n.git\nnode_modules'

/**
 * Build a filter function from the folder's .gitignore plus hard-coded ignores.
 * @param {string} folder
 * @param {string|false} dataDir  the archive dir, always excluded; pass false
 *   in ephemeral mode (no archive on disk → nothing to exclude)
 * @returns {(rel: string) => boolean}
 */
function buildFilter (folder, dataDir) {
  let content = ALWAYS_IGNORE
  try { content = readFileSync(join(folder, '.gitignore'), 'utf8') + '\n' + content } catch {}
  const gitignore = compile(content)
  // Ephemeral mode (no archive dir): filter against gitignore only.
  if (!dataDir) return rel => gitignore.accepts(rel)
  const dataDirRel = relative(folder, dataDir)
  return rel => !rel.startsWith(dataDirRel + '/') && rel !== dataDirRel && gitignore.accepts(rel)
}

/**
 * Decode file bytes: UTF-8 text → string, binary → Uint8Array.
 * @param {Buffer} bytes
 * @returns {string|Uint8Array}
 */
function decodeBytes (bytes) {
  if (bytes.includes(0)) return new Uint8Array(bytes)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return new Uint8Array(bytes) }
}

/**
 * Decode a file's value for storage: JSON files become parsed objects (or
 * strings if the JSON is invalid), everything else stays as-is.
 * @param {string} rel  relative path
 * @param {string|Uint8Array} value
 * @returns {object|string|Uint8Array}
 */
function decodeFile (rel, value) {
  if (rel.endsWith('.json') && typeof value === 'string') {
    try { return JSON.parse(value) } catch {}
  }
  return value
}

/**
 * Encode a file value for writing to disk. Strict shape contract:
 *   - `.json` files: value must be a plain object or array → JSON-encoded
 *   - other files:   value must be a string or Uint8Array → written as bytes
 * Any other combination throws. The earlier null-return + silent-skip
 * behavior hid contract violations; throwing surfaces them at the write
 * site where they can be debugged.
 *
 * @param {string} rel
 * @param {any} value
 * @returns {string|Uint8Array}
 */
function encodeFile (rel, value) {
  const isJsonPath = rel.endsWith('.json')
  const typeDesc = value === null ? 'null'
    : value === undefined ? 'undefined'
    : value instanceof Uint8Array ? 'Uint8Array'
    : typeof value === 'object' ? (Array.isArray(value) ? 'array' : 'object')
    : typeof value
  if (isJsonPath) {
    if (value == null || typeof value !== 'object' || value instanceof Uint8Array) {
      throw new Error(`fileSync.encodeFile: ${rel} is a .json path but value is ${typeDesc}; .json slots require an object or array`)
    }
    return JSON.stringify(value, null, 2) + '\n'
  }
  if (typeof value === 'string' || value instanceof Uint8Array) return value
  throw new Error(`fileSync.encodeFile: ${rel} requires a string or Uint8Array value; got ${typeDesc}`)
}

/**
 * Recursively read all accepted files in folder.
 * @param {string} folder
 * @param {(rel: string) => boolean} accepts
 * @returns {Promise<{ files: Object, maxMtime: number }>}
 */
async function readFolder (folder, accepts) {
  const files = {}
  let maxMtime = 0
  const walk = async dir => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = relative(folder, abs)
      if (!accepts(rel)) continue
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) {
        const [bytes, info] = await Promise.all([readFile(abs), stat(abs)])
        files[rel] = decodeFile(rel, decodeBytes(bytes))
        if (info.mtimeMs > maxMtime) maxMtime = info.mtimeMs
      }
    }
  }
  await walk(folder)
  return { files, maxMtime }
}

/**
 * Write a files object to folder, creating directories as needed.
 * @param {string} folder
 * @param {Object} files
 */
async function writeToFolder (folder, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(folder, rel)
    await mkdir(dirname(abs), { recursive: true })
    const encoded = encodeFile(rel, content)  // throws on shape mismatch
    const bytes = typeof encoded === 'string' ? new TextEncoder().encode(encoded) : encoded
    await writeFile(abs, bytes)
  }
}

/**
 * Delete files from folder.
 * @param {string} folder
 * @param {string[]} rels
 */
async function deleteFromFolder (folder, rels) {
  for (const rel of rels) {
    try { await unlink(join(folder, rel)) } catch {}
  }
}

/**
 * Rough equality check for a files object (handles Uint8Array values).
 * @param {Object} a
 * @param {Object} b
 * @returns {boolean}
 */
function filesEqual (a, b) {
  if (!a || !b) return a === b
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) return false
  for (const k of aKeys) {
    const av = a[k]
    const bv = b[k]
    if (av instanceof Uint8Array && bv instanceof Uint8Array) {
      if (av.length !== bv.length) return false
      if (!av.every((byte, i) => byte === bv[i])) return false
    } else if (av !== bv) {
      if (av == null || bv == null) return false
      if (typeof av === 'object' && typeof bv === 'object') {
        if (JSON.stringify(av) !== JSON.stringify(bv)) return false
      } else {
        return false
      }
    }
  }
  return true
}

// Flat-shape convention (2026-06-04): value IS the files map. Filenames
// at top-level (`value['index.html']`, `value['mounts.json']`,
// `value['streamo.json']`). No more `value.files` nesting, no more
// redundancy invariant between top-level meta and a streamo.json mirror.
// See [[the-flatten-arc-2026-06-04]] in memory/notes/.
//
// Records still in the 9.0.0 nested shape are still valid StreamoRecords
// (chain interpretation lens) — they just aren't valid FolderRecords any
// more. fileSync writes flat; pointing it at a nested-shape Record will
// produce a new flat-shape commit on top of the nested history.

/**
 * Read this repo's files map — in flat shape, the value IS the map.
 */
function readRepoFiles (repo) {
  if (!repo.lastCommit) return null
  const v = repo.get()
  if (!v || typeof v !== 'object' || v instanceof Uint8Array) return null
  return v
}

/**
 * Read this repo's mounts table — `value['mounts.json'].mounts`. Each
 * entry maps a path-prefix to another record's pubkey (optionally pinned
 * to a `dataAddress`). Returns an empty object when there are no mounts.
 */
function readRepoMounts (repo) {
  const mountsFile = repo.get('mounts.json')
  if (!mountsFile || typeof mountsFile !== 'object' || mountsFile instanceof Uint8Array) return {}
  const m = mountsFile.mounts
  if (!m || typeof m !== 'object' || m instanceof Uint8Array) return {}
  return m
}

/**
 * Recursively collect the files a single mounted record contributes —
 * its own `files` plus its own nested mounts (with their files prefixed
 * by each nested mount's path).
 *
 * Cycle detection by pubkey set: each record can appear at most once on
 * the walk from the *initial* outer repo. The caller passes a `visited`
 * set already containing the outer repo's pubkey; nested recursion
 * extends a copy of that set. *Diamonds* (the same record reached by two
 * top-level mounts) are not cycles — handled by the caller starting a
 * fresh `visited` set per top-level mount.
 *
 * Pin-aware: when `atDataAddress` is set, reads the mounted record's
 * value at that specific commit instead of HEAD.
 *
 * @param {{
 *   get: (k: string) => import('./StreamoRecord.js').StreamoRecord|undefined,
 *   _materialize: (k: string) => Promise<import('./StreamoRecord.js').StreamoRecord>
 * }} registry
 *   Structural subset of StreamoRecordRegistry — anything with these
 *   two methods works. (full registry passes trivially.)
 * @param {string} targetKey
 * @param {number|undefined} atDataAddress
 * @param {Set<string>} visited
 * @returns {Promise<Object>} flat map of rel-path → value
 */
async function collectMountedFiles (registry, targetKey, atDataAddress, visited) {
  if (visited.has(targetKey)) return {}
  const inner = new Set(visited)
  inner.add(targetKey)

  // `registry._materialize` (not `.get`) so archived mount targets load
  // lazily — the archiveSync-backed factory's await reads on-disk bytes
  // before the StreamoRecord is returned. Same shape as repoFileServer's resolver
  // (Phase C). `get` here was a footgun: cold-cache call sites would
  // silently return `undefined` and the mount would no-op without trace.
  const targetRepo = await registry._materialize(targetKey)
  if (!targetRepo) return {}

  let value
  if (atDataAddress != null) {
    try { value = targetRepo.decode(atDataAddress) } catch { return {} }
  } else {
    if (!targetRepo.lastCommit) return {}
    value = targetRepo.get()
  }
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return {}

  // Flat shape: value IS the files map. Every top-level key is a file.
  const collected = { ...value }

  // Nested mounts: walk into mounts targets and inherit their files
  // under each mount prefix.
  const mountsFile = value['mounts.json']
  const nestedMounts = (mountsFile && typeof mountsFile === 'object' && !(mountsFile instanceof Uint8Array))
    ? mountsFile.mounts
    : undefined
  if (nestedMounts && typeof nestedMounts === 'object' && !(nestedMounts instanceof Uint8Array)) {
    for (const [prefix, mount] of Object.entries(nestedMounts)) {
      if (!mount || typeof mount !== 'object' || typeof mount.key !== 'string') continue
      if (!/^[0-9a-f]{66}$/.test(mount.key)) continue
      const nested = await collectMountedFiles(
        registry,
        mount.key,
        typeof mount.dataAddress === 'number' ? mount.dataAddress : undefined,
        inner
      )
      for (const [rel, v] of Object.entries(nested)) collected[prefix + rel] = v
    }
  }

  return collected
}

/**
 * Walk this repo's top-level mounts, producing a flat map of
 * mount-prefixed paths to their materialized file values. Returns an
 * empty object when mounts are disabled (no registry / no pubkeyHex)
 * or when this repo has no mounts.
 *
 * Each top-level mount gets its OWN `visited` set seeded with the outer
 * repo's pubkey — so cycles back to the outer repo are detected, but
 * the same record appearing at two different top-level mount paths
 * (the diamond case) is correctly materialized at both locations.
 *
 * @param {import('./StreamoRecord.js').StreamoRecord} repo
 * @param {string|null} ownKey
 * @param {{
 *   get: (k: string) => import('./StreamoRecord.js').StreamoRecord|undefined,
 *   _materialize: (k: string) => Promise<import('./StreamoRecord.js').StreamoRecord>
 * }|null} registry
 */
async function collectAllMounted (repo, ownKey, registry) {
  if (!registry || !ownKey) return {}
  const mounts = readRepoMounts(repo)
  const out = {}
  for (const [prefix, mount] of Object.entries(mounts)) {
    if (!mount || typeof mount !== 'object' || typeof mount.key !== 'string') continue
    if (!/^[0-9a-f]{66}$/.test(mount.key)) continue
    const files = await collectMountedFiles(
      registry,
      mount.key,
      typeof mount.dataAddress === 'number' ? mount.dataAddress : undefined,
      new Set([ownKey])
    )
    for (const [rel, v] of Object.entries(files)) out[prefix + rel] = v
  }
  return out
}

/**
 * Wrap an accepts filter so it ALSO rejects paths under any current
 * mount prefix. Used for "what counts as own-files" decisions —
 * commits, watcher events, and the disk-reads-for-commit pass.
 *
 * The `recordFile` (streamo.json) is a first-class file in
 * `value.files` — it's NOT excluded here. Its content mirrors the
 * top-level meta (the redundancy invariant fileSync maintains).
 *
 * Reads mount prefixes fresh on every call so the filter tracks the
 * repo's current mounts table without needing to be rebuilt.
 */
function buildOwnFilesFilter (acceptsForDisk, getMountPrefixes) {
  return rel => {
    if (!acceptsForDisk(rel)) return false
    for (const prefix of getMountPrefixes()) {
      const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      if (rel === bare || rel.startsWith(prefix)) return false
    }
    return true
  }
}

// `mountsOnly` variant: the outermost Record only holds a mounts.json —
// nothing else lands in its value. Shards are authored separately (each
// via its own fileSync / seed script), and this Record just points at
// them. Realizes the lightweight-outermost identity-as-namespace shape
// where password protects who-you-are without carrying content velocity.
function buildMountsOnlyFilter (acceptsForDisk) {
  return rel => rel === 'mounts.json' && acceptsForDisk(rel)
}

const DEFAULT_RECORD_FILENAME = 'streamo.json'

/**
 * Resolve the `recordFile` option to a filename or null.
 *   - `true`    → default name (`streamo.json`)
 *   - `string`  → that filename
 *   - falsy     → null (feature disabled)
 */
function resolveRecordFileName (opt) {
  if (opt === true) return DEFAULT_RECORD_FILENAME
  if (typeof opt === 'string' && opt.length > 0) return opt
  return null
}

/**
 * Two-way sync between a folder and a StreamoRecord (flat shape).
 *
 * The Record's value IS the files map — every top-level key is a file.
 * `value['index.html']`, `value['mounts.json']`, `value['streamo.json']`.
 *
 * Initial state (startup authority via timestamps):
 *   - repo has a committed value AND no disk file is newer than the last
 *     commit → repo wins (write committed files to disk)
 *   - repo has no commits OR any disk file is newer → disk wins (commit
 *     the disk state as the new value)
 *
 * Ongoing:
 *   - StreamoRecord changes (peer/archive) → write changed files to disk
 *   - Disk changes → re-read folder, commit the flat map
 *
 * **Mounts (when both `registry` and `pubkeyHex` are provided).** This
 * repo's `mounts.json` declares composition references to other Records
 * by pubkey. Mount files are materialized one-way (read-only) onto disk
 * at the declared prefix paths; writes to those paths are filtered out
 * of the disk→repo commit and re-materialized from the mount target.
 *
 * Cycle detection during materialization stops at loops; diamonds (same
 * Record at two top-level mount paths) materialize at both locations.
 *
 * @param {import('./WritableStreamoRecord.js').WritableStreamoRecord} repo
 *   Must be Writable — fileSync commits the disk's state into the Record.
 * @param {string} [folder='.']
 * @param {string} [dataDir='.stream']
 * @param {object} [options]
 * @param {{
 *   get: (k: string) => import('./StreamoRecord.js').StreamoRecord|undefined,
 *   _materialize: (k: string) => Promise<import('./StreamoRecord.js').StreamoRecord>
 * }|null} [options.registry=null]
 *   registry providing the bytes for mount targets. Unset → files-only.
 * @param {string|null} [options.pubkeyHex=null]  the pubkey of `repo`,
 *   used as the cycle-detection seed for mount materialization.
 * @param {boolean|string} [options.recordFile=false]  reserved for the
 *   mid-edit grace check — when set, this filename's parse failure during
 *   a watcher batch causes that one file to be dropped from the commit
 *   (so a transient broken JSON doesn't overwrite the previous valid
 *   object). Default `streamo.json`. Pass `false` to disable.
 * @returns {Promise<import('@parcel/watcher').AsyncSubscription>}
 */
export async function fileSync (repo, folder = '.', dataDir = '.stream', options = {}) {
  const { registry = null, pubkeyHex = null, recordFile: recordFileOpt = false, signer = null, signerName = null, mountsOnly = false } = options
  const recordFile = resolveRecordFileName(recordFileOpt)
  // Auto-sharding: when (signer, signerName, registry) are all present,
  // route writes through FolderRecord.writeMany. Files under ours:true
  // mounts go to derived child Records (signer.keysFor(signerName +'/'+
  // mountPrefix)); home files stay on this Record. Without signer/
  // signerName, fall back to the single-Record write path (legacy
  // callers + tests).
  let folderLens = null
  if (signer && signerName && registry) {
    const { FolderRecord } = await import('./FolderRecord.js')
    folderLens = new FolderRecord(repo, registry, { signer, signerName })
  }
  // Resolve symlinks in the folder path up front so the watcher's
  // event paths (which come back resolved on some OSes — notably
  // macOS, where `/tmp` → `/private/tmp`) line up with our own
  // relative() calls. Without this, `relative(folder, e.path)`
  // produces a `../../private/...` path that the accepts filter
  // can't match against gitignore entries.
  try { folder = await realpath(folder) } catch { /* path may not exist yet */ }
  const acceptsForDisk = buildFilter(folder, dataDir)

  // Two filters, two jobs:
  //   - acceptsForDisk:    gitignore + always-ignore. Used for "is this
  //                        path one fileSync materializes here, or is
  //                        it the user's own thing on the side?"
  //                        Mount paths PASS (we wrote them; we manage
  //                        their deletion).
  //   - acceptsForCommit:  acceptsForDisk MINUS paths under any current
  //                        mount prefix. The set we'd actually commit to
  //                        this repo's chain. Mount paths FAIL — they
  //                        belong to other records' chains, not ours.
  // The mount-prefix list is read fresh from the repo's value on every
  // call, so the filter tracks the current mounts table dynamically.
  const getMountPrefixes = () => {
    if (!registry || !pubkeyHex) return []
    return Object.keys(readRepoMounts(repo))
  }
  const acceptsForCommit = mountsOnly
    ? buildMountsOnlyFilter(acceptsForDisk)
    : buildOwnFilesFilter(acceptsForDisk, getMountPrefixes)

  const getRepoFiles = () => readRepoFiles(repo)
  // Flat shape: the file map IS the value. A fresh Record gets the files
  // map as its initial value, no wrapping object.
  const applyFilesToValue = (_current, files) => files

  // Gate the disk-vs-repo authority decision on "is the upstream view
  // in?" — authoring against an empty-looking local archive when the
  // relay has weeks of history produces a fresh-chain commit the relay
  // rejects with chain-mismatch. Wait for repo.isReadyToAuthor (a
  // reactive predicate composing hasRelay + caughtUpToRelay). Records
  // without this predicate (non-StreamoRecord Streamos) fall through
  // immediately.
  //
  // If the relay never acks subscribed, this hangs — that's honest.
  // The OLD-RELAY 3-second timeout fallback was removed in the flatten
  // arc: relays older than the initial-replay handshake (10.2.3+) need
  // updating, not working around.
  if (typeof repo.isReadyToAuthor === 'boolean' && !repo.isReadyToAuthor) {
    await repo.recaller.when(() => repo.isReadyToAuthor, { name: 'fileSync:await-ready-to-author' })
  }

  const { files: diskFiles, maxMtime: diskMtime } = await readFolder(folder, acceptsForCommit)
  const lastCommit = repo.lastCommit
  const commitTime = lastCommit ? lastCommit.date.getTime() : 0
  const repoFiles = getRepoFiles()

  if (lastCommit && repoFiles && diskMtime <= commitTime) {
    // StreamoRecord wins: write committed files to disk + materialize mounts.
    const mountedFiles = await collectAllMounted(repo, pubkeyHex, registry)
    const target = { ...mountedFiles, ...repoFiles }
    const { files: managed } = await readFolder(folder, acceptsForDisk)
    const toDelete = Object.keys(managed).filter(k => !(k in target))
    await writeToFolder(folder, target)
    await deleteFromFolder(folder, toDelete)
  } else if (Object.keys(diskFiles).length > 0) {
    // Disk wins: commit current disk state. streamo.json is just another
    // file — its parsed object lands at value['streamo.json'] alongside
    // every other top-level key.
    //
    // Mid-edit grace: if `recordFile` (default streamo.json) failed to
    // parse, decodeFile leaves it as the raw string. Drop that entry so
    // a broken-mid-edit JSON doesn't overwrite the previous valid object.
    // The next clean save commits.
    const filesToCommit = { ...diskFiles }
    if (recordFile && typeof filesToCommit[recordFile] === 'string') {
      delete filesToCommit[recordFile]
    }
    if (Object.keys(filesToCommit).length > 0) {
      if (folderLens) {
        // Auto-sharding path: files route to derived child Records based
        // on mounts.json + the ours:true marker.
        await folderLens.writeMany(filesToCommit, { replace: true, message: 'seed files' })
      } else {
        await repo.update(c => applyFilesToValue(c, filesToCommit), { message: 'seed files' })
      }
    }
  }

  // StreamoRecord → disk: retries if a write is in progress so no commit is ever dropped
  let writingToDisk = false
  let pendingDiskFlush = false

  async function flushToDisk () {
    if (writingToDisk) { pendingDiskFlush = true; return }
    writingToDisk = true
    pendingDiskFlush = false
    try {
      const ownFiles = getRepoFiles() ?? {}
      const mountedFiles = await collectAllMounted(repo, pubkeyHex, registry)
      const target = { ...mountedFiles, ...ownFiles }
      // Read EVERYTHING we manage on disk (both own + mounted) so the
      // toDelete set covers removed mounts too — when a mount entry is
      // dropped from the table, its materialized files vanish from disk.
      const { files: managed } = await readFolder(folder, acceptsForDisk)
      if (!filesEqual(managed, target)) {
        const toDelete = Object.keys(managed).filter(k => !(k in target))
        await writeToFolder(folder, target)
        await deleteFromFolder(folder, toDelete)
      }
    } finally {
      writingToDisk = false
      if (pendingDiskFlush) flushToDisk()
    }
  }

  // Disk → repo: single-flight; filesystem events that arrive mid-commit are
  // naturally re-triggered by the repo watch that follows the commit
  let committingFromDisk = false

  // StreamoRecord → disk: fires when a new commit lands (from peer, archive, or local commit)
  repo.recaller.watch('fileSync:repo→disk', () => {
    if (committingFromDisk) return
    const commit = repo.lastCommit
    if (!commit) return
    flushToDisk()
  })

  // Disk → repo: fires when the filesystem changes. Uses
  // acceptsForCommit so events under mount prefixes never trigger
  // commits — mounted files are read-only at this layer.
  //
  // Read-only enforcement on mount paths: any event that
  // acceptsForDisk admits but acceptsForCommit rejects (i.e., we'd
  // manage this path but it falls under a mount prefix) is treated as
  // a write-to-read-only-territory. We log a loud banner naming the
  // paths and immediately re-materialize from the upstream mounted
  // record — the user's edit visibly reverts, making the read-only
  // contract impossible to miss.
  /**
   * Compare on-disk bytes for a mount-path event against the bytes the
   * mounted record would materialize there. Returns true iff the disk
   * content DIFFERS — i.e., this is a *real* user edit, not just our
   * own re-materialization writes coming back through the watcher.
   *
   * Without this content check, the banner would fire twice on every
   * user edit: once for the edit itself, once for the re-materialization
   * write the banner triggers. Comparing content cuts the false-positive
   * cleanly — only one banner per actual divergence.
   */
  async function isRealMountEdit (rel, mounted) {
    const expected = mounted[rel]
    if (expected === undefined) return false  // mount entry was removed
    let onDisk
    try { onDisk = await readFile(join(folder, rel)) } catch { return false }
    const encoded = encodeFile(rel, expected)  // throws on shape mismatch
    const expectedBytes = typeof encoded === 'string' ? new TextEncoder().encode(encoded) : encoded
    if (onDisk.length !== expectedBytes.byteLength) return true
    for (let i = 0; i < onDisk.length; i++) {
      if (onDisk[i] !== expectedBytes[i]) return true
    }
    return false
  }

  const subscription = await subscribe(folder, (err, events) => {
    if (err) { console.error('fileSync watcher error:', err); return }

    // Events on mount paths — read-only territory candidates. We still
    // have to content-check before banner'ing (see isRealMountEdit).
    const candidates = events.filter(e => {
      const rel = relative(folder, e.path)
      return acceptsForDisk(rel) && !acceptsForCommit(rel)
    })
    if (candidates.length > 0) {
      ;(async () => {
        const mounted = await collectAllMounted(repo, pubkeyHex, registry)
        const realEdits = []
        for (const event of candidates) {
          const rel = relative(folder, event.path)
          if (await isRealMountEdit(rel, mounted)) realEdits.push(rel)
        }
        if (realEdits.length === 0) return  // our own writes echoing back; ignore
        console.error('\n' + '━'.repeat(72))
        console.error('⚠️  WRITE TO MOUNTED PATH IGNORED')
        console.error('━'.repeat(72))
        console.error('You edited a path that is materialized from a mounted record.')
        console.error('That record has its own signed chain; this fileSync does not')
        console.error('own those bytes. Your edit will be reverted on the next sync.')
        console.error('')
        console.error('Affected path(s):')
        for (const p of realEdits) console.error('  • ' + p)
        console.error('')
        console.error('To edit those files, fork the mounted record into one you own')
        console.error('and update this record\'s mounts table to reference your fork.')
        console.error('━'.repeat(72) + '\n')
        // Re-materialize so the edit visibly reverts. Cheap (the bytes
        // already match the mounted record's content); ensures disk is
        // consistent past the banner.
        flushToDisk()
      })()
    }

    // Own-file edits — the commit path. streamo.json (recordFile) is
    // just one of these; mid-edit grace drops it from the commit if its
    // JSON failed to parse, so a transient broken object doesn't
    // overwrite the previous valid value['streamo.json'].
    const relevant = events.filter(e => acceptsForCommit(relative(folder, e.path)))
    if (!relevant.length) return
    if (committingFromDisk) return
    committingFromDisk = true
    ;(async () => {
      try {
        const { files: newFiles } = await readFolder(folder, acceptsForCommit)
        const current = getRepoFiles() ?? {}

        if (recordFile && typeof newFiles[recordFile] === 'string') {
          console.warn(`fileSync: ${recordFile} parse error, leaving value[${recordFile}] unchanged`)
          delete newFiles[recordFile]
        }

        if (filesEqual(current, newFiles)) return
        if (folderLens) {
          await folderLens.writeMany(newFiles, { replace: true, message: 'file change' })
        } else {
          await repo.update(c => applyFilesToValue(c, newFiles), { message: 'file change' })
        }
      } finally {
        committingFromDisk = false
      }
    })()
  })

  return subscription
}
