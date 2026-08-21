import { mkdir, readFile, readdir, realpath } from 'fs/promises'
import { join, relative } from 'path'

import { compile } from '@gerhobbelt/gitignore-parser'
import { subscribe as watchFolder } from '@parcel/watcher'

import { commitWithRetry } from './Draft.js'
import { isPlainObject } from './codecs.js'
import { decodeBytes, decodeFile, filesEqual } from './fileCodec.js'

const GITIGNORE = '.gitignore'
const MOUNTS = 'mounts.json'
const OVERRIDABLE_DEFAULTS = ['*.env', '.DS_Store', '.git', 'node_modules']

const log = (channel, message) =>
  console.error(`[fs2 ${new Date().toISOString().slice(11, 23)}] ${channel.padEnd(9)} ${message}`)

const describe = value =>
  value === undefined ? 'undefined'
    : value === null ? 'null'
      : value instanceof Uint8Array ? `a ${value.length}-byte Uint8Array`
        : Array.isArray(value) ? `an array of ${value.length}`
          : `a ${typeof value}`.replace('a o', 'an o')

export async function fileSync2 ({ registry, subscribe, rootKey, folder: folderPath = '.', ignore = () => false, signer = null, signerName = null }) {
  await mkdir(folderPath, { recursive: true })
  const folder = await realpath(folderPath)

  const root = await subscribe(rootKey)
  const asked = new Set([rootKey])

  let accepts = null
  let onDisk = null

  const GONE = Symbol('gone')
  const NOT_A_FILE = Symbol('not a file')

  const readOne = async rel => {
    try {
      return decodeFile(rel, decodeBytes(await readFile(join(folder, rel))))
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return GONE
      if (err?.code === 'EISDIR') return NOT_A_FILE
      throw err
    }
  }

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
        else if (entry.isFile()) {
          const value = await readOne(rel)
          if (value !== GONE && value !== NOT_A_FILE) onDisk[rel] = value
        }
      }
    }
    await walk(folder)

    log('disk', `${reason} — ${Object.keys(onDisk).length} files, ${gitignoreRules ? `${GITIGNORE}: ${gitignoreRules.length} lines` : `no ${GITIGNORE}`}`)
  }

  const mountPrefixes = () => {
    const mounts = onDisk?.[MOUNTS]
    return isPlainObject(mounts?.mounts) ? Object.keys(mounts.mounts) : []
  }

  const ownFilesOnDisk = () => {
    const prefixes = mountPrefixes()
    const ours = {}
    for (const [rel, value] of Object.entries(onDisk)) {
      if (prefixes.some(prefix => rel.startsWith(prefix))) continue
      ours[rel] = value
    }
    return ours
  }

  let sends = 0
  let inFlight = Promise.resolve()

  const sendDraft = reason => {
    inFlight = inFlight.then(async () => {
      sends++
      const ours = ownFilesOnDisk()
      const committed = root.lastCommit ? root.get() : undefined

      if (committed !== undefined && !isPlainObject(committed)) {
        log('FAULT', `#${sends} root committed ${describe(committed)}, not a file map`)
        return
      }
      if (committed !== undefined && filesEqual(ours, committed)) {
        log('send', `#${sends} ${reason} — disk matches the record, nothing to send`)
        return
      }

      const from = committed ?? {}
      const added = Object.keys(ours).filter(rel => !(rel in from)).sort()
      const removed = Object.keys(from).filter(rel => !(rel in ours)).sort()
      const changed = Object.keys(ours)
        .filter(rel => rel in from && !filesEqual({ [rel]: ours[rel] }, { [rel]: from[rel] })).sort()

      const parts = []
      if (added.length) parts.push(`+${added.length} [${added}]`)
      if (changed.length) parts.push(`~${changed.length} [${changed}]`)
      if (removed.length) parts.push(`-${removed.length} [${removed}]`)
      const summary = `${parts.join(' ') || '(no difference)'}${committed === undefined ? '  (record has never reported)' : ''}`

      if (typeof root.newDraft !== 'function' || root.isAuthorable === false) {
        log('send', `#${sends} ${reason} — ${summary}, but this record is not authorable here`)
        return
      }

      try {
        const { attempts } = await commitWithRetry(root, () => ours, {
          message: `fileSync2: ${reason}`,
          signer,
          signerName
        })
        log('send', `#${sends} ${reason} — committed ${summary}${attempts > 1 ? ` (${attempts} attempts)` : ''}`)
      } catch (err) {
        log('FAULT', `#${sends} ${reason} — commit failed after ${err.attempts ?? '?'} attempts: ${err.message}`)
      }
    })
    return inFlight
  }

  await reloadIgnoresThenReadEverything('read everything')
  await sendDraft('after the complete read')

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

  const watcher = await watchFolder(folder, async (err, events) => {
    if (err) { log('disk', `watcher error: ${err.message}`); return }
    const changed = events.map(event => relative(folder, event.path))
    if (changed.includes(GITIGNORE)) {
      await reloadIgnoresThenReadEverything(`${GITIGNORE} changed`)
      await sendDraft(`${GITIGNORE} changed`)
      return
    }
    const accepted = changed.filter(rel => accepts(rel))
    if (!accepted.length) return
    let touched = 0
    for (const rel of accepted) {
      const value = await readOne(rel)
      if (value === NOT_A_FILE) continue
      if (value === GONE) delete onDisk[rel]
      else onDisk[rel] = value
      touched++
      log('disk', `${value === GONE ? 'gone' : 'read'} ${rel}`)
    }
    if (touched) await sendDraft(`${touched} disk change${touched > 1 ? 's' : ''}`)
  })

  log('setup', `watching ${folder} for ${rootKey.slice(0, 12)}… — mechanism 1 live: disk changes are committed. nothing is written to disk`)

  return {
    folder,
    settled: () => inFlight,
    unsubscribe: () => watcher.unsubscribe()
  }
}
