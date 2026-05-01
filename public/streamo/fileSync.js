import { subscribe } from '@parcel/watcher'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'fs/promises'
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

/**
 * Two-way sync between a folder and a Repo.
 *
 * Initial state (startup authority via timestamps):
 *   - repo has commits and no disk file is newer than the last commit → repo wins
 *   - repo is empty or any disk file is newer than the last commit → disk wins
 *
 * Ongoing:
 *   - Repo changes (new commit from peer/archive) → write changed files to disk
 *   - Disk changes → checkout, update files, commit to repo
 *
 * @param {import('./Repo.js').Repo} repo
 * @param {string} [folder='.']
 * @param {string} [dataDir='.stream']
 * @returns {Promise<import('@parcel/watcher').AsyncSubscription>}
 */
export async function fileSync (repo, folder = '.', dataDir = '.stream') {
  const accepts = buildFilter(folder, dataDir)

  const { files: diskFiles, maxMtime: diskMtime } = await readFolder(folder, accepts)
  const lastCommit = repo.lastCommit
  const commitTime = lastCommit ? lastCommit.date.getTime() : 0

  if (lastCommit && diskMtime <= commitTime) {
    // Repo wins: write committed files to disk
    const repoFiles = repo.files
    const toDelete = Object.keys(diskFiles).filter(k => !(k in repoFiles))
    await writeToFolder(folder, repoFiles)
    await deleteFromFolder(folder, toDelete)
  } else if (Object.keys(diskFiles).length > 0) {
    // Disk wins: commit current disk state as the initial commit
    const working = repo.checkout()
    working.set(diskFiles)
    repo.commit(working, 'initial')
  }

  // Repo → disk: retries if a write is in progress so no commit is ever dropped
  let writingToDisk = false
  let pendingDiskFlush = false

  async function flushToDisk () {
    if (writingToDisk) { pendingDiskFlush = true; return }
    writingToDisk = true
    pendingDiskFlush = false
    try {
      const files = repo.files
      if (!files) return
      const { files: current } = await readFolder(folder, accepts)
      if (filesEqual(current, files)) return
      const toDelete = Object.keys(current).filter(k => !(k in files))
      await writeToFolder(folder, files)
      await deleteFromFolder(folder, toDelete)
    } finally {
      writingToDisk = false
      if (pendingDiskFlush) flushToDisk()
    }
  }

  // Disk → repo: single-flight; filesystem events that arrive mid-commit are
  // naturally re-triggered by the repo watch that follows the commit
  let committingFromDisk = false

  // Repo → disk: fires when a new commit lands (from peer, archive, or local commit)
  repo.watch('fileSync:repo→disk', () => {
    if (committingFromDisk) return
    const commit = repo.lastCommit
    if (!commit) return
    flushToDisk()
  })

  // Disk → repo: fires when the filesystem changes
  const subscription = await subscribe(folder, (err, events) => {
    if (err) { console.error('fileSync watcher error:', err); return }
    const relevant = events.filter(e => accepts(relative(folder, e.path)))
    if (!relevant.length) return
    if (committingFromDisk) return
    committingFromDisk = true
    ;(async () => {
      try {
        const { files: newFiles } = await readFolder(folder, accepts)
        const current = repo.files ?? {}
        if (filesEqual(current, newFiles)) return
        const working = repo.checkout()
        working.set(newFiles)
        repo.commit(working, 'file change')
      } finally {
        committingFromDisk = false
      }
    })()
  })

  return subscription
}
