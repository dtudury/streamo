import { subscribe } from '@parcel/watcher'
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { compile } from '@gerhobbelt/gitignore-parser'

const ALWAYS_IGNORE = '.env\n.DS_Store\n.git\nnode_modules'

/**
 * Build a filter function from the folder's .gitignore plus hard-coded ignores.
 * @param {string} folder
 * @param {string} dataDir  the archive dir, always excluded
 * @returns {(rel: string) => boolean}
 */
function buildFilter (folder, dataDir) {
  let content = ALWAYS_IGNORE
  try { content = readFileSync(join(folder, '.gitignore'), 'utf8') + '\n' + content } catch {}
  const gitignore = compile(content)
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
 * Encode a file value for writing to disk: objects stored under a .json path
 * are serialized back to pretty-printed JSON.
 * @param {string} rel
 * @param {any} value
 * @returns {string|Uint8Array|null}  null means skip
 */
function encodeFile (rel, value) {
  if (rel.endsWith('.json') && value != null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return JSON.stringify(value, null, 2) + '\n'
  }
  if (typeof value === 'string' || value instanceof Uint8Array) return value
  return null
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
    const encoded = encodeFile(rel, content)
    if (encoded === null) continue
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

// The structured-record shape: files live under `value.files`, leaving
// room for sibling keys (`mounts`, `title`, `members`, ...). Hardcoded
// since 9.0.0 — the legacy "value IS files" mode is gone.
const FILES_KEY = 'files'

/**
 * Read the files-map this fileSync owns — `repo.value.files`.
 * Returns a plain map (possibly empty), or null if the repo has no files
 * at the key (lastCommit may still exist for other sibling state).
 */
function readRepoFiles (repo) {
  const v = repo.get(FILES_KEY)
  if (!v || typeof v !== 'object' || v instanceof Uint8Array) return null
  return v
}

/**
 * Read this repo's `mounts` table — declarative composition: each entry
 * maps a path-prefix to another record's pubkey (optionally pinned to a
 * specific `dataAddress`). Returns an empty object when there are no
 * mounts.
 */
function readRepoMounts (repo) {
  const m = repo.get('mounts')
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
 * @param {{ get: (k: string) => import('./Repo.js').Repo|undefined }} registry
 * @param {string} targetKey
 * @param {number|undefined} atDataAddress
 * @param {Set<string>} visited
 * @returns {Promise<Object>} flat map of rel-path → value
 */
async function collectMountedFiles (registry, targetKey, atDataAddress, visited) {
  if (visited.has(targetKey)) return {}
  const inner = new Set(visited)
  inner.add(targetKey)

  const targetRepo = registry.get(targetKey)
  if (!targetRepo) return {}

  let value
  if (atDataAddress != null) {
    try { value = targetRepo.decode(atDataAddress) } catch { return {} }
  } else {
    if (!targetRepo.lastCommit) return {}
    value = targetRepo.get()
  }
  if (!value || typeof value !== 'object') return {}

  const collected = {}

  if (value.files && typeof value.files === 'object' && !(value.files instanceof Uint8Array)) {
    for (const [rel, v] of Object.entries(value.files)) collected[rel] = v
  }

  if (value.mounts && typeof value.mounts === 'object') {
    for (const [prefix, mount] of Object.entries(value.mounts)) {
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
 * @param {import('./Repo.js').Repo} repo
 * @param {string|null} ownKey
 * @param {{ get: (k: string) => import('./Repo.js').Repo|undefined }|null} registry
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
 * mount prefix, AND the dedicated `recordFile` path at the root.
 * Used for "what counts as own-files" decisions — commits, watcher
 * events, and the disk-reads-for-commit pass.
 *
 * Reads mount prefixes fresh on every call so the filter tracks the
 * repo's current mounts table without needing to be rebuilt.
 */
function buildOwnFilesFilter (acceptsForDisk, getMountPrefixes, recordFileName) {
  return rel => {
    if (!acceptsForDisk(rel)) return false
    if (recordFileName && rel === recordFileName) return false
    for (const prefix of getMountPrefixes()) {
      const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      if (rel === bare || rel.startsWith(prefix)) return false
    }
    return true
  }
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
 * Read the record's "meta" from disk — the JSON at folder/<recordFile>,
 * parsed and validated. If a `files` key is present it's stripped with
 * a warning (files come from the file tree, not from here). Returns
 * an object on success, or null on absent/malformed input.
 *
 * Mid-edit JSON-invalid is a transient state, not a footgun — we warn
 * but don't crash; the next valid save will commit cleanly.
 */
async function readRecordFileMeta (folder, recordFile) {
  if (!recordFile) return null
  let raw
  try { raw = await readFile(join(folder, recordFile), 'utf8') }
  catch (e) {
    if (e.code === 'ENOENT') return null
    return null
  }
  let parsed
  try { parsed = JSON.parse(raw) }
  catch (e) {
    console.warn(`fileSync: ${recordFile} parse error, skipping commit: ${e.message}`)
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if ('files' in parsed) {
    console.warn(`fileSync: ${recordFile} contains a 'files' key — ignoring it (files come from the file tree)`)
    const { files: _ignored, ...meta } = parsed
    return meta
  }
  return parsed
}

/**
 * Read the record's meta from the repo's in-memory value — everything
 * except the `files` key. Returns null when the repo has no commit yet
 * or the value isn't an object.
 */
function readRepoRecordMeta (repo) {
  if (!repo.lastCommit) return null
  const value = repo.get()
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return null
  const meta = { ...value }
  delete meta[FILES_KEY]
  return meta
}

/**
 * stat()-based mtime read for the record file. Returns 0 if absent;
 * used by the initial-sync timestamp comparison to decide whether disk
 * or repo wins.
 */
async function getRecordFileMtime (folder, recordFile) {
  if (!recordFile) return 0
  try { return (await stat(join(folder, recordFile))).mtimeMs }
  catch { return 0 }
}

/**
 * Write the record's meta to disk as pretty-printed JSON. Always
 * writes a trailing newline so the file is editor-friendly.
 */
async function writeRecordFile (folder, recordFile, meta) {
  if (!recordFile) return
  const content = JSON.stringify(meta ?? {}, null, 2) + '\n'
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, recordFile), content)
}

/** Deep-equality for meta objects, via JSON serialization. */
function metaEqual (a, b) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

/**
 * Two-way sync between a folder and a Repo.
 *
 * Initial state (startup authority via timestamps):
 *   - repo has files at `value.files` AND no disk file is newer than the
 *     last commit → repo wins
 *   - repo has no files at `value.files`, OR any disk file is newer than
 *     the last commit → disk wins
 *
 * Ongoing:
 *   - Repo changes (new commit from peer/archive) → write changed files to disk
 *   - Disk changes → checkout, update files, commit to repo
 *
 * The sync is mounted at `repo.value.files` — other top-level keys on the
 * value (the chat home's `members`, `journalists`, `entries`, etc.) are
 * preserved across writes.
 *
 * **Mounts (when both `registry` and `pubkeyHex` are provided).** This
 * repo's `mounts` table — declarative composition referring to other
 * records by pubkey — is materialized one-way (read-only) onto disk.
 * Mount files appear at the prefix paths the table declares, so the
 * editor sees the composed tree (e.g. `./streamo/h.js` from a mounted
 * library record), but writes to those paths are silently filtered out
 * of the disk→repo commit path. Your record's chain only signs your
 * own files; the mounted records' chains stay independent.
 *
 * Cycle detection during materialization stops at loops (own key
 * marked visited; mounts back to it short-circuit). Diamonds (same
 * record at two top-level paths) materialize at both locations.
 *
 * @param {import('./Repo.js').Repo} repo
 * @param {string} [folder='.']
 * @param {string} [dataDir='.stream']
 * @param {object} [options]
 * @param {{ get: (k: string) => import('./Repo.js').Repo|undefined }|null} [options.registry=null]
 *   registry whose stored Repos provide the bytes for any mounted record.
 *   When unset, mount materialization is disabled (files-only behavior).
 * @param {string|null} [options.pubkeyHex=null]  the pubkey of `repo`,
 *   used as the cycle-detection seed for mount materialization.
 *   Required alongside `registry` for mounts to take effect.
 * @param {boolean|string} [options.recordFile=false]  when truthy,
 *   syncs a JSON file on disk (`streamo.json` by default; pass a
 *   string to override the name) to the record's value MINUS the
 *   `files` key. Lets you edit `mounts` and other top-level keys
 *   (`title`, `description`, `members`, etc.) in your editor as plain
 *   JSON, with the file tree continuing to own the `files` key.
 * @param {'merge'|'replace'} [options.meta='merge']  how a streamo.json
 *   edit composes into the Record's value. `'merge'` (default) spreads
 *   the file's keys into the existing value — keys not mentioned in
 *   streamo.json are preserved (e.g., journalists set by code, files
 *   set by the tree). Use `key: null` in streamo.json to explicitly
 *   remove a key. `'replace'` mirrors the file literally: any key not
 *   in streamo.json is removed from the Record's meta. Pick `replace`
 *   when streamo.json is the sole authority for meta (no other writers
 *   contribute keys); `merge` otherwise.
 * @returns {Promise<import('@parcel/watcher').AsyncSubscription>}
 */
export async function fileSync (repo, folder = '.', dataDir = '.stream', options = {}) {
  const { registry = null, pubkeyHex = null, recordFile: recordFileOpt = false, meta: metaStrategy = 'merge' } = options
  if (metaStrategy !== 'merge' && metaStrategy !== 'replace') {
    throw new Error(`fileSync: meta option must be 'merge' or 'replace', got: ${metaStrategy}`)
  }
  const recordFile = resolveRecordFileName(recordFileOpt)
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
  const acceptsForCommit = buildOwnFilesFilter(acceptsForDisk, getMountPrefixes, recordFile)

  const getRepoFiles = () => readRepoFiles(repo)
  const setRepoFiles = (working, files) => {
    // On a fresh checkout (no prior commits), there's no parent object for
    // path-set to navigate into.  Materialize the wrapping object explicitly.
    if (working.get() === undefined) return working.set({ [FILES_KEY]: files })
    return working.set(FILES_KEY, files)
  }
  // setRecordMeta composes the streamo.json edit into the Record's
  // value, per `metaStrategy`:
  //   - 'merge' (default): spread the file's keys into the existing
  //     value. Keys not mentioned in streamo.json survive (other
  //     writers — seed steps, code — keep their keys). A `null` value
  //     in streamo.json explicitly removes that key from the Record.
  //   - 'replace': the file is the sole truth for meta; keys absent
  //     from streamo.json are removed. `files` is always preserved
  //     (it's owned by the file tree, not the meta channel).
  const setRecordMeta = (working, meta) => {
    if (metaStrategy === 'replace') {
      const currentFiles = working.get(FILES_KEY)
      const next = { ...(meta ?? {}) }
      if (currentFiles !== undefined) next[FILES_KEY] = currentFiles
      working.set(next)
    } else {
      const current = working.get() ?? {}
      const next = { ...current }
      for (const [k, v] of Object.entries(meta ?? {})) {
        if (v === null) delete next[k]
        else next[k] = v
      }
      working.set(next)
    }
  }

  const { files: diskFiles, maxMtime: diskMtime } = await readFolder(folder, acceptsForCommit)
  const recordFileMtime = await getRecordFileMtime(folder, recordFile)
  const diskRecordMeta = await readRecordFileMeta(folder, recordFile)
  const lastCommit = repo.lastCommit
  const commitTime = lastCommit ? lastCommit.date.getTime() : 0
  const repoFiles = getRepoFiles()
  const repoRecordMeta = readRepoRecordMeta(repo)
  // Disk-wins iff ANY part of disk (file tree OR recordFile) is newer
  // than the last commit. recordFile and tree share one decision so we
  // never get into the "commit half the disk, overwrite the other half"
  // shape — startup commits ALL of disk's authority or NONE of it.
  const maxDiskMtime = Math.max(diskMtime, recordFileMtime)

  if (lastCommit && repoFiles && maxDiskMtime <= commitTime) {
    // Repo wins: write committed files to disk + materialize mounts +
    // write the recordFile if enabled.
    const mountedFiles = await collectAllMounted(repo, pubkeyHex, registry)
    const target = { ...mountedFiles, ...repoFiles }  // own files override mounted on collision
    const { files: managed } = await readFolder(folder, acceptsForDisk)
    // Exclude recordFile from toDelete — it's managed by writeRecordFile,
    // not by the files-tree writer. Same reason it's excluded from
    // acceptsForCommit (it's metadata, not one of value.files).
    const toDelete = Object.keys(managed).filter(k => !(k in target) && k !== recordFile)
    await writeToFolder(folder, target)
    await deleteFromFolder(folder, toDelete)
    if (recordFile && repoRecordMeta) {
      await writeRecordFile(folder, recordFile, repoRecordMeta)
    }
  } else if (Object.keys(diskFiles).length > 0 || (recordFile && diskRecordMeta)) {
    // Disk wins: commit current disk state. setRepoFiles writes to the
    // `files` subkey — siblings on the value survive. diskFiles is
    // already filtered to own files (mount paths and the recordFile
    // path both excluded by acceptsForCommit), so they don't bleed
    // into this repo's chain.
    const working = repo.checkout()
    if (recordFile && diskRecordMeta) setRecordMeta(working, diskRecordMeta)
    setRepoFiles(working, diskFiles)
    repo.commit(working, `seed ${FILES_KEY}`)
    // After the commit lands, the repo→disk watcher (below) will fire
    // and materialize any mounts.
  }

  // Repo → disk: retries if a write is in progress so no commit is ever dropped
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
      // Same recordFile exclusion as the initial-sync repo-wins branch —
      // we don't manage streamo.json via the files-tree writer.
      const managedForTree = recordFile
        ? Object.fromEntries(Object.entries(managed).filter(([k]) => k !== recordFile))
        : managed
      if (!filesEqual(managedForTree, target)) {
        const toDelete = Object.keys(managedForTree).filter(k => !(k in target))
        await writeToFolder(folder, target)
        await deleteFromFolder(folder, toDelete)
      }
      // recordFile (streamo.json) flush — write the latest meta whenever
      // it differs from what's on disk. Idempotent (matches → no write),
      // so the cost when nothing changed is one read + one JSON compare.
      if (recordFile) {
        const meta = readRepoRecordMeta(repo)
        if (meta) {
          const onDisk = await readRecordFileMeta(folder, recordFile)
          if (!metaEqual(onDisk, meta)) {
            await writeRecordFile(folder, recordFile, meta)
          }
        }
      }
    } finally {
      writingToDisk = false
      if (pendingDiskFlush) flushToDisk()
    }
  }

  /**
   * Compare on-disk recordFile bytes against the meta the repo would
   * write. Returns true iff the disk content DIFFERS — i.e., this is a
   * *real* user edit, not just our own write echoing back through the
   * watcher. Same semantic as isRealMountEdit, applied to streamo.json.
   */
  async function isRealRecordFileEdit () {
    if (!recordFile) return false
    const diskMeta = await readRecordFileMeta(folder, recordFile)
    const repoMeta = readRepoRecordMeta(repo) ?? {}
    return !metaEqual(diskMeta, repoMeta)
  }

  // Disk → repo: single-flight; filesystem events that arrive mid-commit are
  // naturally re-triggered by the repo watch that follows the commit
  let committingFromDisk = false

  // Repo → disk: fires when a new commit lands (from peer, archive, or local commit)
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
    const encoded = encodeFile(rel, expected)
    if (encoded === null) return false
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

    // recordFile (streamo.json) edits — the meta-commit path. Same
    // content-check shape as mount edits so we don't fire commits for
    // our own writes echoing back through the watcher.
    if (recordFile) {
      const recordEvents = events.filter(e => relative(folder, e.path) === recordFile)
      if (recordEvents.length > 0 && !committingFromDisk) {
        ;(async () => {
          if (!(await isRealRecordFileEdit())) return  // our own write; ignore
          committingFromDisk = true
          try {
            const newMeta = await readRecordFileMeta(folder, recordFile)
            if (newMeta === null) return  // parse error or absent; skip
            const working = repo.checkout()
            setRecordMeta(working, newMeta)
            repo.commit(working, `update ${recordFile}`)
          } finally {
            committingFromDisk = false
          }
        })()
      }
    }

    // Own-file edits — the commit path.
    const relevant = events.filter(e => acceptsForCommit(relative(folder, e.path)))
    if (!relevant.length) return
    if (committingFromDisk) return
    committingFromDisk = true
    ;(async () => {
      try {
        const { files: newFiles } = await readFolder(folder, acceptsForCommit)
        const current = getRepoFiles() ?? {}
        if (filesEqual(current, newFiles)) return
        const working = repo.checkout()
        setRepoFiles(working, newFiles)
        repo.commit(working, 'file change')
      } finally {
        committingFromDisk = false
      }
    })()
  })

  return subscription
}
