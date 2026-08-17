import { mkdir, readFile, readdir, realpath, stat } from 'fs/promises'
import { join, relative } from 'path'

import { compile } from '@gerhobbelt/gitignore-parser'
import { subscribe as watchFolder } from '@parcel/watcher'

import { isPlainObject } from './codecs.js'

const GITIGNORE = '.gitignore'
const MOUNTS = 'mounts.json'
const OVERRIDABLE_DEFAULTS = ['*.env', '.DS_Store', '.git', 'node_modules']

const log = (channel, message) =>
  console.error(`[fs2 ${new Date().toISOString().slice(11, 23)}] ${channel.padEnd(7)} ${message}`)

const describe = value =>
  value === undefined ? 'undefined'
    : value === null ? 'null'
      : value instanceof Uint8Array ? `a ${value.length}-byte Uint8Array`
        : Array.isArray(value) ? `an array of ${value.length}`
          : `a ${typeof value}`.replace('a o', 'an o')

export async function fileSync2 ({ registry, subscribe, rootKey, folder: folderPath = '.', ignore = () => false }) {
  await mkdir(folderPath, { recursive: true })
  const folder = await realpath(folderPath)

  const root = await subscribe(rootKey)
  const asked = new Set([rootKey])

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
  registry.recaller.watch('fileSync2:disk-matches-record', () => {
    reconciliations++

    const committed = root.get()
    if (committed === undefined) {
      log('reconcile', `#${reconciliations} root has not reported yet`)
      return
    }
    if (!isPlainObject(committed)) {
      log('FAULT', `#${reconciliations} root committed ${describe(committed)}, not a file map`)
      return
    }

    const shouldBeOnDisk = { ...committed }
    const waitingFor = []

    for (const [prefix, mount] of Object.entries(committed[MOUNTS]?.mounts ?? {})) {
      if (typeof mount?.key !== 'string') {
        log('FAULT', `#${reconciliations} mount ${prefix} has no key (${describe(mount)})`)
        continue
      }
      const mounted = registry.get(mount.key)
      if (!mounted) {
        waitingFor.push(prefix)
        if (!asked.has(mount.key)) {
          asked.add(mount.key)
          subscribe(mount.key).catch(err => log('FAULT', `subscribe ${prefix} failed: ${err.message}`))
        }
        continue
      }
      const mountedFiles = mounted.get()
      if (mountedFiles === undefined) {
        waitingFor.push(prefix)
        continue
      }
      if (!isPlainObject(mountedFiles)) {
        log('FAULT', `#${reconciliations} mount ${prefix} committed ${describe(mountedFiles)}, not a file map`)
        continue
      }
      for (const [name, contents] of Object.entries(mountedFiles)) shouldBeOnDisk[prefix + name] = contents
    }

    const names = Object.keys(shouldBeOnDisk).sort()
    log('reconcile', `#${reconciliations} disk should hold ${names.length} [${names}]${waitingFor.length ? ` — waiting for [${waitingFor}]` : ''}`)
  })

  await watchFolder(folder, (err, events) => {
    if (err) { log('disk', `watcher error: ${err.message}`); return }
    const changed = events.map(event => relative(folder, event.path))
    if (changed.includes(GITIGNORE)) {
      reloadIgnoresThenReadEverything(`${GITIGNORE} changed`)
      return
    }
    for (const rel of changed) if (accepts(rel)) log('disk', rel)
  })

  log('setup', `watching ${folder} for ${rootKey.slice(0, 12)}… — logging only, nothing is written`)
}
