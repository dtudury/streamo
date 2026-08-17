import { mkdir, readFile, readdir, realpath, stat } from 'fs/promises'
import { join, relative } from 'path'

import { compile } from '@gerhobbelt/gitignore-parser'
import { subscribe } from '@parcel/watcher'

const GITIGNORE = '.gitignore'
const MOUNTS = 'mounts.json'
const OVERRIDABLE_DEFAULTS = ['*.env', '.DS_Store', '.git', 'node_modules']

const log = (channel, message) =>
  console.error(`[fs2 ${new Date().toISOString().slice(11, 23)}] ${channel.padEnd(7)} ${message}`)

const isFileMap = value => value && typeof value === 'object' && !(value instanceof Uint8Array)

export async function fileSync2 (repo, folderPath = '.', options = {}) {
  const { registry = null, ignore = () => false } = options

  await mkdir(folderPath, { recursive: true })
  const folder = await realpath(folderPath)

  let accepts = null
  let onDisk = null

  const reloadIgnoresThenReadEverything = async reason => {
    let gitignoreRules = null
    try {
      gitignoreRules = (await readFile(join(folder, GITIGNORE), 'utf8')).split('\n')
    } catch {}

    const gitignore = compile([...OVERRIDABLE_DEFAULTS, ...(gitignoreRules ?? [])].join('\n'))
    accepts = rel => rel !== '' && !ignore(rel) && gitignore.accepts(rel)

    onDisk = {}
    const walk = async dir => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        const rel = relative(folder, abs)
        if (!accepts(rel)) continue
        if (entry.isDirectory()) await walk(abs)
        else if (entry.isFile()) onDisk[rel] = (await stat(abs)).size
      }
    }
    await walk(folder)

    log('disk', `${reason} — ${Object.keys(onDisk).length} files, ${gitignoreRules ? `${GITIGNORE}: ${gitignoreRules.length} lines` : `no ${GITIGNORE}`}`)
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
    for (const [prefix, mount] of Object.entries(committed[MOUNTS]?.mounts ?? {})) {
      const mounted = typeof mount?.key === 'string' && registry?.get(mount.key)
      const mountedFiles = mounted && mounted.get()
      if (!isFileMap(mountedFiles)) {
        notYetLoaded.push(prefix)
        continue
      }
      for (const [name, contents] of Object.entries(mountedFiles)) shouldBeOnDisk[prefix + name] = contents
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
