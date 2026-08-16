import { mkdir, readFile, readdir, realpath, stat } from 'fs/promises'
import { isAbsolute, join, relative } from 'path'

import { compile } from '@gerhobbelt/gitignore-parser'
import { subscribe } from '@parcel/watcher'

const GITIGNORE = '.gitignore'

const OVERRIDABLE_DEFAULTS = ['*.env', '.DS_Store', '.git', 'node_modules']

const stamp = () => new Date().toISOString().slice(11, 23)
const log = (channel, message) => console.error(`[fs2 ${stamp()}] ${channel.padEnd(6)} ${message}`)

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

export async function fileSync2 (repo, folderPath = '.', dataDir = '.streamo', options = {}) {
  const folder = await resolvedFolder(folderPath)
  const streamoOwned = await streamoOwnedPaths(folder, dataDir)

  let accepts = null
  let snapshot = null

  const reloadIgnoresThenReadEverything = async reason => {
    const gitignoreRules = await readGitignoreRules(folder)
    accepts = buildAccepts(gitignoreRules, streamoOwned)
    snapshot = await readEveryAcceptedFile(folder, accepts)
    log('read', `${reason} — ${Object.keys(snapshot).length} files, ${gitignoreRules ? `${GITIGNORE} has ${gitignoreRules.length} lines` : `no ${GITIGNORE}`}, streamo owns [${streamoOwned}]`)
  }

  await reloadIgnoresThenReadEverything('initial')

  const onCommitArrived = () => {
    const commit = repo.lastCommit
    if (!commit) return
    const id = String(commit.chainHash ?? commit.date?.getTime?.() ?? '?').slice(0, 12)
    log('mirror', `commit ${id} ${JSON.stringify(commit.message ?? '')}`)
  }
  repo.recaller.watch('fileSync2:commit-arrived', onCommitArrived)

  const subscription = await subscribe(folder, (err, events) => {
    if (err) { log('disk', `watcher error: ${err.message}`); return }
    const changed = events.map(event => relative(folder, event.path))
    if (changed.includes(GITIGNORE)) {
      reloadIgnoresThenReadEverything(`${GITIGNORE} changed`)
      return
    }
    for (const rel of changed) {
      if (accepts(rel)) log('disk', rel)
    }
  })

  log('setup', `watching ${folder} — logging only, nothing is written`)

  return {
    async unsubscribe () {
      repo.recaller.unwatch(onCommitArrived)
      await subscription.unsubscribe()
      log('setup', 'stopped')
    }
  }
}
