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
 *
 * Mounts live in the Record's files map at `files['mounts.json']`, as a
 * regular file with shape `{ "mounts": { "<prefix>": { "key": "...", ... }, ... } }`.
 */
function readRepoMounts (repo) {
  const mountsFile = repo.get(FILES_KEY, 'mounts.json')
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
  if (!value || typeof value !== 'object') return {}

  const collected = {}

  if (value.files && typeof value.files === 'object' && !(value.files instanceof Uint8Array)) {
    for (const [rel, v] of Object.entries(value.files)) collected[rel] = v
  }

  // mounts live in files['mounts.json'].mounts now (a regular file in the
  // Record's files map), not value.mounts.
  const mountsFile = value.files && typeof value.files === 'object' && !(value.files instanceof Uint8Array)
    ? value.files['mounts.json']
    : undefined
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

/** Deep-equality for meta objects, via JSON serialization. */
function metaEqual (a, b) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

/**
 * Two-way sync between a folder and a StreamoRecord.
 *
 * Initial state (startup authority via timestamps):
 *   - repo has files at `value.files` AND no disk file is newer than the
 *     last commit → repo wins
 *   - repo has no files at `value.files`, OR any disk file is newer than
 *     the last commit → disk wins
 *
 * Ongoing:
 *   - StreamoRecord changes (new commit from peer/archive) → write changed files to disk
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
 * @param {import('./WritableStreamoRecord.js').WritableStreamoRecord} repo
 *   Must be Writable — fileSync commits the disk's state into the Record.
 * @param {string} [folder='.']
 * @param {string} [dataDir='.stream']
 * @param {object} [options]
 * @param {{
 *   get: (k: string) => import('./StreamoRecord.js').StreamoRecord|undefined,
 *   _materialize: (k: string) => Promise<import('./StreamoRecord.js').StreamoRecord>
 * }|null} [options.registry=null]
 *   registry whose stored StreamoRecords provide the bytes for any mounted record.
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
  const acceptsForCommit = buildOwnFilesFilter(acceptsForDisk, getMountPrefixes)

  const getRepoFiles = () => readRepoFiles(repo)
  // Value-in / value-out helper for `repo.update(c => applyFilesToValue(c, files))`.
  // On a fresh record (`current === undefined`), materialize the wrapping
  // object explicitly so the value has structural shape.
  const applyFilesToValue = (current, files) => {
    if (current === undefined) return { [FILES_KEY]: files }
    return { ...current, [FILES_KEY]: files }
  }

  // Invariant: value.files[recordFile] mirrors top-level meta.
  // Returns true iff a heal commit was made (caller may want to re-read
  // state). Code that updates meta directly (e.g., server.streamo.set
  // bypassing fileSync) breaks the invariant temporarily — this restores
  // it by committing value.files[recordFile] = current top-level meta.
  // No-op when invariant already holds.
  const healMetaInvariant = async (origin = 'heal') => {
    if (!recordFile || !repo.lastCommit) return false
    const ownFiles = getRepoFiles() ?? {}
    const topLevelMeta = readRepoRecordMeta(repo) ?? {}
    const filesEntry = ownFiles[recordFile]
    const filesEntryIsValidMeta = filesEntry && typeof filesEntry === 'object' && !Array.isArray(filesEntry) && !(filesEntry instanceof Uint8Array)
    const hasTopLevel = Object.keys(topLevelMeta).length > 0
    if (!hasTopLevel) return false
    if (filesEntryIsValidMeta && metaEqual(filesEntry, topLevelMeta)) return false
    // Warn only on REAL divergence (a non-empty file entry that doesn't
    // match) — initial population from a sealed-StreamoRecord with no entry yet
    // is expected and noiseless.
    if (filesEntryIsValidMeta && Object.keys(filesEntry).length > 0) {
      console.warn(`fileSync: ${recordFile} out of sync with top-level meta; healing`)
    }
    await repo.update(
      c => applyFilesToValue(c, { ...ownFiles, [recordFile]: topLevelMeta }),
      { message: `${origin}: sync ${recordFile}` }
    )
    return true
  }
  // applyMetaToValue composes the streamo.json edit into the Record's
  // value, per `metaStrategy`. Value-in / value-out for repo.update():
  //   - 'merge' (default): spread the file's keys into the existing
  //     value. Keys not mentioned in streamo.json survive (other
  //     writers — seed steps, code — keep their keys). A `null` value
  //     in streamo.json explicitly removes that key from the Record.
  //   - 'replace': the file is the sole truth for meta; keys absent
  //     from streamo.json are removed. `files` is always preserved
  //     (it's owned by the file tree, not the meta channel).
  const applyMetaToValue = (current, meta) => {
    if (metaStrategy === 'replace') {
      const next = { ...(meta ?? {}) }
      const currentFiles = current?.[FILES_KEY]
      if (currentFiles !== undefined) next[FILES_KEY] = currentFiles
      return next
    } else {
      const next = { ...(current ?? {}) }
      for (const [k, v] of Object.entries(meta ?? {})) {
        if (v === null) delete next[k]
        else next[k] = v
      }
      return next
    }
  }

  // Gate the disk-vs-repo authority decision on "is the upstream view
  // in?" — when an origin session is attached but initial replay hasn't
  // completed, the local archive looks empty (or incomplete) but the
  // relay has weeks of history. Authoring against the empty view here
  // produces a fresh-chain commit that the relay rejects with
  // chain-mismatch. Wait until either there's no relay (local-only mode,
  // safe to author immediately) or we've caught up to the relay's chain
  // head as of subscribe time.
  //
  // Implemented via repo.isReadyToAuthor — a reactive predicate that
  // composes hasRelay + caughtUpToRelay. Old Records without this
  // predicate (or non-StreamoRecord Streamos) fall through to immediate
  // ready, preserving prior behavior.
  //
  // OLD-RELAY FALLBACK: relays older than this version don't send the
  // `{type: 'subscribed'}` ack the gate waits on. To avoid a hard
  // deadlock against such a relay, the await is bounded: after 3 s with
  // hasRelay=true but no watermark, log a warning and proceed. The
  // legacy race (chain-mismatch on first push) re-appears in that
  // configuration — but the user sees a clear log line saying so, not
  // an unexplained hang.
  if (typeof repo.isReadyToAuthor === 'boolean' && !repo.isReadyToAuthor) {
    const controller = new AbortController()
    const ready = repo.recaller.when(
      () => repo.isReadyToAuthor,
      { signal: controller.signal, name: 'fileSync:await-ready-to-author' }
    ).catch(() => {})  // timeout aborts; swallow and proceed
    const timer = setTimeout(() => {
      if (repo.hasRelay && repo.relaySubscribedAtOffset === null) {
        console.warn(
          'fileSync: relay did not send a `subscribed` ack within 3 s — ' +
          'proceeding without the initial-replay gate. If your author push ' +
          'gets rejected with chain-mismatch, your relay is older than 10.2.3; ' +
          'update it to use the new initial-replay handshake.'
        )
      }
      controller.abort('timeout')
    }, 3000)
    await ready
    clearTimeout(timer)
  }

  const { files: diskFiles, maxMtime: diskMtime } = await readFolder(folder, acceptsForCommit)
  const diskRecordMeta = await readRecordFileMeta(folder, recordFile)
  const lastCommit = repo.lastCommit
  const commitTime = lastCommit ? lastCommit.date.getTime() : 0
  const repoFiles = getRepoFiles()
  // streamo.json is in diskFiles now (no exclusion), so its mtime is
  // already included in diskMtime — no separate recordFile mtime read.
  const maxDiskMtime = diskMtime

  if (lastCommit && repoFiles && maxDiskMtime <= commitTime) {
    // StreamoRecord wins: write committed files to disk + materialize mounts.
    // streamo.json is a regular file in value.files now — writeToFolder
    // handles it like any other file. Heal the invariant first if the
    // Record's value has top-level meta but value.files[recordFile] is
    // missing or stale (e.g., sealed StreamoRecords authored by code that didn't
    // go through fileSync).
    await healMetaInvariant('init')
    const refreshedRepoFiles = getRepoFiles() ?? {}
    const mountedFiles = await collectAllMounted(repo, pubkeyHex, registry)
    const target = { ...mountedFiles, ...refreshedRepoFiles }
    const { files: managed } = await readFolder(folder, acceptsForDisk)
    const toDelete = Object.keys(managed).filter(k => !(k in target))
    await writeToFolder(folder, target)
    await deleteFromFolder(folder, toDelete)
  } else if (Object.keys(diskFiles).length > 0 || (recordFile && diskRecordMeta)) {
    // Disk wins: commit current disk state in a single operation —
    // value.files (including streamo.json) AND top-level meta extracted
    // from streamo.json. setRecordMeta merges meta keys; setRepoFiles
    // writes the files map (which now includes streamo.json).
    //
    // Mid-edit grace: if streamo.json failed to parse, diskFiles holds
    // it as the raw string. Drop that entry so the broken JSON doesn't
    // land in value.files (and meta stays unchanged) — the next valid
    // save will commit cleanly. If after dropping it nothing remains
    // and there's no valid meta, skip the commit entirely.
    const filesToCommit = { ...diskFiles }
    if (recordFile && typeof filesToCommit[recordFile] === 'string') {
      delete filesToCommit[recordFile]
    }
    const hasFiles = Object.keys(filesToCommit).length > 0
    const hasMeta = recordFile && diskRecordMeta
    if (hasFiles || hasMeta) {
      await repo.update(c => {
        let v = c
        if (hasMeta) v = applyMetaToValue(v, diskRecordMeta)
        return applyFilesToValue(v, filesToCommit)
      }, { message: `seed ${FILES_KEY}` })
      // After the commit lands, the repo→disk watcher (below) will fire
      // and materialize any mounts.
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
      // Code that updates meta directly (e.g., server.streamo.set
      // bypassing fileSync) breaks the invariant temporarily. Heal with
      // a fix-up commit — the commit re-triggers this watcher, the
      // queue guard makes the re-entry safe, and the second flush sees
      // the invariant restored and proceeds normally.
      if (!committingFromDisk) {
        committingFromDisk = true
        try {
          if (await healMetaInvariant()) return  // heal triggered a re-flush
        } finally {
          committingFromDisk = false
        }
      }

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

    // Own-file edits — the commit path. streamo.json is one of these
    // (a first-class file in value.files); when it changes, we also
    // extract its parsed content as the top-level meta update, so the
    // file content and meta land in one commit.
    const relevant = events.filter(e => acceptsForCommit(relative(folder, e.path)))
    if (!relevant.length) return
    if (committingFromDisk) return
    committingFromDisk = true
    ;(async () => {
      try {
        const { files: newFiles } = await readFolder(folder, acceptsForCommit)
        const current = getRepoFiles() ?? {}

        // Extract meta from streamo.json if it's present and parsable.
        // The file's content is JSON.parse'd by decodeFile in readFolder;
        // a string here means parse failed (transient mid-edit) — drop
        // it from newFiles so the broken JSON doesn't land in value.files
        // and meta stays unchanged. Other file edits in the same event
        // batch still commit. A `files` key inside the JSON is stripped
        // + warned (it'd shadow the real files key otherwise).
        let newMeta = null
        if (recordFile && recordFile in newFiles) {
          const parsed = newFiles[recordFile]
          if (typeof parsed === 'string') {
            console.warn(`fileSync: ${recordFile} parse error, leaving meta + this file unchanged`)
            delete newFiles[recordFile]
          } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if ('files' in parsed) {
              console.warn(`fileSync: ${recordFile} contains a 'files' key — ignoring it (files come from the file tree)`)
              const { files: _ignored, ...meta } = parsed
              newMeta = meta
              newFiles[recordFile] = meta  // strip from the file too, so invariant is maintainable
            } else {
              newMeta = parsed
            }
          }
        }

        if (filesEqual(current, newFiles)) return
        await repo.update(c => {
          let v = c
          if (newMeta !== null) v = applyMetaToValue(v, newMeta)
          return applyFilesToValue(v, newFiles)
        }, { message: 'file change' })
      } finally {
        committingFromDisk = false
      }
    })()
  })

  return subscription
}
