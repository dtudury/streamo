#!/usr/bin/env node
/**
 * @file mirror-record — subscribe to a streamo Record by pubkey and mirror
 *   its `value.files` to a local directory. Key-only / read-only — no
 *   credentials, no signer, no writes. Just a viewing-window onto someone
 *   else's signed bytes.
 *
 * Usage:
 *   node scripts/mirror-record.mjs <pubkey> <dir>
 *
 *   <pubkey>  hex pubkey of the Record to subscribe to (the long
 *             66-char identifier you see in /streams/<...>/ URLs)
 *   <dir>     local directory to mirror into (created if missing)
 *
 * Env (rarely overridden):
 *   MIRROR_RELAY     upstream relay URL (default wss://streamo.dev)
 *
 * What it does (concretely):
 *   1. Opens a streamo session to the relay (slim, no signer)
 *   2. Subscribes to <pubkey> — bytes start arriving via registrySync
 *   3. Watches the Record's value via the recaller; on every change,
 *      diffs current `value.files` against last-seen and:
 *         + writes new/changed files to <dir>/<filename>
 *         - removes files no longer present in value.files
 *      Top-level metadata (everything in value MINUS files) dumps to
 *      <dir>/_meta.json so non-file structure is also visible.
 *
 * Architectural notes (the why):
 *   - This is the read-side counterpart to `streamon.mjs`'s write side.
 *     Streamon is one process that holds the sketch identity and pushes
 *     OUT; mirror-record is many processes (one per Record-you-watch)
 *     that just pull IN. No state file, no warm-daemon — these are
 *     tiny long-running viewers, each subscribed to exactly one key.
 *   - Within-Record file storage lives at `value.files[<filename>]`;
 *     this script unpacks that map into actual files on disk. For
 *     cross-Record nesting (mounts.json), this v1 doesn't follow —
 *     you'd run a second `mirror-record` for the target pubkey if
 *     you wanted the mounted Record's bytes locally too. See
 *     [[within-record-vs-cross-record-different-layers]].
 *   - The recaller's `watch` is the reactive primitive: `mirror()`
 *     reads `repo.get()`, the recaller tracks the dependency, and
 *     subsequent value mutations re-fire `mirror()`. No polling,
 *     no setTimeout — the substrate articulates "value changed"
 *     directly. ([[feedback_dont_invent_events]] applied positively.)
 */
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { StreamoRecord } from '../public/streamo/StreamoRecord.js'
import { StreamoRecordRegistry } from '../public/streamo/StreamoRecordRegistry.js'
import { registrySync } from '../public/streamo/registrySync.js'

const [,, pubkey, dirArg] = process.argv
if (!pubkey || !dirArg) {
  console.error('usage: node scripts/mirror-record.mjs <pubkey> <dir>')
  process.exit(2)
}
if (!/^[0-9a-f]{66}$/i.test(pubkey)) {
  console.error(`mirror-record: pubkey must be 66 hex chars; got "${pubkey}"`)
  process.exit(2)
}

const dir = resolve(dirArg)
await mkdir(dir, { recursive: true })

const RELAY_URL = process.env.MIRROR_RELAY ?? 'wss://streamo.dev'

const recaller = new Recaller('mirror')
// Slim factory — we never write, only observe.
const registry = new StreamoRecordRegistry({
  recaller,
  factory: () => new StreamoRecord({ recaller })
})

console.error(`mirror-record: connecting to ${RELAY_URL}…`)
const session = await registrySync(registry, RELAY_URL)
console.error(`mirror-record: subscribing to ${pubkey.slice(0, 16)}…`)
const repo = await session.subscribe(pubkey)
console.error(`mirror-record: mirroring to ${dir}`)
console.error('mirror-record: watching for changes (Ctrl-C to stop)\n')

let lastFiles = {}

async function mirror () {
  const value = repo.get()
  if (value == null) return // value not landed yet

  const files = (value.files && typeof value.files === 'object' && !(value.files instanceof Uint8Array))
    ? value.files
    : {}

  const wrote = []
  for (const [name, body] of Object.entries(files)) {
    if (lastFiles[name] === body) continue
    const fullPath = join(dir, name)
    await mkdir(dirname(fullPath), { recursive: true })
    const bytes = typeof body === 'string'
      ? body
      : (body instanceof Uint8Array ? body : JSON.stringify(body, null, 2))
    await writeFile(fullPath, bytes)
    wrote.push(name)
  }

  const removed = []
  for (const name of Object.keys(lastFiles)) {
    if (name in files) continue
    try { await unlink(join(dir, name)); removed.push(name) } catch {}
  }

  // Top-level metadata (everything in value minus files) → _meta.json.
  // Lets the viewer see record-level state (writtenAt, identityType,
  // mounts.json's structure once we flatten it, etc.) alongside the files.
  const { files: _ignored, ...meta } = value
  if (Object.keys(meta).length > 0) {
    await writeFile(join(dir, '_meta.json'), JSON.stringify(meta, null, 2))
  }

  lastFiles = { ...files }

  if (wrote.length || removed.length) {
    const ts = new Date().toISOString().slice(11, 19) + 'Z'
    console.log(`[${ts}] +${wrote.length} -${removed.length}`)
    for (const n of wrote)   console.log(`  + ${n}`)
    for (const n of removed) console.log(`  - ${n}`)
  }
}

recaller.watch('mirror', mirror)

process.on('SIGINT', () => {
  console.error('\nmirror-record: shutting down')
  process.exit(0)
})
