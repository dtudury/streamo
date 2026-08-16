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

function mountTable (value) {
  const mounts = value?.[MOUNTS]?.mounts
  return mounts && typeof mounts === 'object' ? mounts : {}
}

function filesUnderPrefix (prefix, value) {
  const files = {}
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return files
  for (const [name, contents] of Object.entries(value)) files[prefix + name] = contents
  return files
}

function desiredDiskContents (repo, registry) {
  if (!repo.lastCommit) return { known: false, files: {}, notYetLoaded: [] }

  const own = repo.get()
  if (!own || typeof own !== 'object') return { known: false, files: {}, notYetLoaded: [] }

  const files = { ...own }
  const notYetLoaded = []

  for (const [prefix, mount] of Object.entries(mountTable(own))) {
    if (typeof mount?.key !== 'string') { notYetLoaded.push(prefix); continue }
    const mounted = registry?.get(mount.key)
    if (!mounted) { notYetLoaded.push(prefix); continue }
    Object.assign(files, filesUnderPrefix(prefix, mounted.get()))
  }

  return { known: true, files, notYetLoaded }
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
  const reconcileDiskToRecord = () => {
    reconciliations++
    const { known, files, notYetLoaded } = desiredDiskContents(repo, registry)
    if (!known) { log('reconcile', `#${reconciliations} nothing committed yet`); return }
    const names = Object.keys(files).sort()
    log('reconcile', `#${reconciliations} disk should hold ${names.length} [${names}]${notYetLoaded.length ? ` — not yet loaded: [${notYetLoaded}]` : ''}`)
  }
  repo.recaller.watch('fileSync2:disk-matches-record', reconcileDiskToRecord)

  const subscription = await subscribe(folder, (err, events) => {
    if (err) { log('disk', `watcher error: ${err.message}`); return }
    const changed = events.map(event => relative(folder, event.path))
    if (changed.includes(GITIGNORE)) {
      reloadIgnoresThenReadEverything(`${GITIGNORE} changed`)
      return
    }
    for (const rel of changed) if (accepts(rel)) log('disk', rel)
  })

  log('setup', `watching ${folder} — logging only, nothing is written`)

  return {
    async unsubscribe () {
      repo.recaller.unwatch(reconcileDiskToRecord)
      await subscription.unsubscribe()
      log('setup', 'stopped')
    }
  }
}
