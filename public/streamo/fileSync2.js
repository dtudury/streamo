import { mkdir, readFile, readdir, realpath, stat } from 'fs/promises'
import { isAbsolute, join, relative } from 'path'

import { compile } from '@gerhobbelt/gitignore-parser'
import { subscribe } from '@parcel/watcher'

const GITIGNORE = '.gitignore'
const MOUNTS = 'mounts.json'

const OVERRIDABLE_DEFAULTS = ['*.env', '.DS_Store', '.git', 'node_modules']

const stamp = () => new Date().toISOString().slice(11, 23)
const log = (channel, message) => console.error(`[fs2 ${stamp()}] ${channel.padEnd(7)} ${message}`)

async function resolvedFolder (folder) {
  await mkdir(folder, { recursive: true })
  return realpath(folder)
}

async function sameResolutionAs (folder, path) {
  const absolute = isAbsolute(path) ? path : join(folder, path)
  try { return await realpath(absolute) } catch { return absolute }
}

async function streamoOwnedPaths (folder, dataDir) {
  if (!dataDir) return []
  const rel = relative(folder, await sameResolutionAs(folder, dataDir))
  return rel && !rel.startsWith('..') ? [rel] : []
}

async function readGitignoreRules (folder) {
  try {
    return (await readFile(join(folder, GITIGNORE), 'utf8')).split('\n')
  } catch {
    return null
  }
}

function isUnder (rel, prefix) {
  return rel === prefix || rel.startsWith(prefix + '/')
}

function buildAccepts (gitignoreRules, streamoOwned) {
  const gitignore = compile([...OVERRIDABLE_DEFAULTS, ...(gitignoreRules ?? [])].join('\n'))
  return rel => {
    if (rel === '') return false
    if (streamoOwned.some(owned => isUnder(rel, owned))) return false
    return gitignore.accepts(rel)
  }
}

async function readEveryAcceptedFile (folder, accepts) {
  const files = {}
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relative(folder, abs)
      if (!accepts(rel)) continue
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) files[rel] = (await stat(abs)).size
    }
  }
  await walk(folder)
  return files
}

function mountsIn (value) {
  const mounts = value?.[MOUNTS]?.mounts
  return mounts && typeof mounts === 'object' ? Object.entries(mounts) : []
}

function isFileMap (value) {
  return value && typeof value === 'object' && !(value instanceof Uint8Array)
}

export async function fileSync2 (repo, folderPath = '.', dataDir = '.streamo', options = {}) {
  const { registry = null } = options
  const folder = await resolvedFolder(folderPath)
  const streamoOwned = await streamoOwnedPaths(folder, dataDir)

  let accepts = null
  let onDisk = null

  const reloadIgnoresThenReadEverything = async reason => {
    const gitignoreRules = await readGitignoreRules(folder)
    accepts = buildAccepts(gitignoreRules, streamoOwned)
    onDisk = await readEveryAcceptedFile(folder, accepts)
    log('disk', `${reason} — ${Object.keys(onDisk).length} files, ${gitignoreRules ? `${GITIGNORE}: ${gitignoreRules.length} lines` : `no ${GITIGNORE}`}, streamo owns [${streamoOwned}]`)
  }

  await reloadIgnoresThenReadEverything('read everything')

  let reconciliations = 0
  repo.recaller.watch('fileSync2:disk-matches-record', () => {
    reconciliations++

    if (!repo.lastCommit) {
      log('reconcile', `#${reconciliations} nothing committed yet`)
      return
    }

    const committed = repo.get()
    if (!isFileMap(committed)) {
      log('reconcile', `#${reconciliations} committed value is not a file map`)
      return
    }

    const shouldBeOnDisk = { ...committed }
    const notYetLoaded = []

    for (const [prefix, mount] of mountsIn(committed)) {
      const mounted = typeof mount?.key === 'string' && registry?.get(mount.key)
      const mountedFiles = mounted && mounted.get()
      if (!isFileMap(mountedFiles)) {
        notYetLoaded.push(prefix)
        continue
      }
      for (const [name, contents] of Object.entries(mountedFiles)) {
        shouldBeOnDisk[prefix + name] = contents
      }
    }

    const names = Object.keys(shouldBeOnDisk).sort()
    log('reconcile', `#${reconciliations} disk should hold ${names.length} [${names}]${notYetLoaded.length ? ` — not yet loaded: [${notYetLoaded}]` : ''}`)
  })

  await subscribe(folder, (err, events) => {
    if (err) { log('disk', `watcher error: ${err.message}`); return }
    const changed = events.map(event => relative(folder, event.path))
    if (changed.includes(GITIGNORE)) {
      reloadIgnoresThenReadEverything(`${GITIGNORE} changed`)
      return
    }
    for (const rel of changed) if (accepts(rel)) log('disk', rel)
  })

  log('setup', `watching ${folder} — logging only, nothing is written`)
}
