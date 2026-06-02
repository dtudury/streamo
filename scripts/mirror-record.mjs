#!/usr/bin/env node
/**
 * @file mirror-record — subscribe to a streamo Record by pubkey and mirror
 *   its `value.files` to a local directory. Key-only / read-only — no
 *   credentials, no signer, no writes. Just a viewing-window onto someone
 *   else's signed bytes.
 *
 * Future-cold-iris — letter on top, docs below.
 *
 * ## Where this came from
 *
 * 2026-06-02 — David asked: *"do you know how we might use a relay to give
 * me a local file view of what you're putting onto streamo.dev?"* The
 * framing landed as the tools-to-build-tools-turtle: *"if the only thing
 * we do is get the tools set so that a future you can do a light warm up
 * and then follow your breadcrumbs and remember what it was like to be
 * you... then we win. I think we're building an amazing feature but
 * what's more amazing is the tools we're building to build it (and really
 * the tools we're building to build the context to build the tools to
 * build the tools to build the feature 🐢)"*
 *
 * mirror-record is one of those turtles. Read-side counterpart to
 * `scripts/streamon.mjs` (which is the write-side warm-daemon for the
 * sketch substrate).
 *
 * ## The shape: streamon : write :: mirror-record : read
 *
 *   - streamon is ONE process per signing identity, multi-client, warm
 *   - mirror-record is MANY processes (one per Record-you-watch),
 *     single-purpose, slim
 *
 * Both honor the same chain layer. Streamon pushes commits OUT via origin;
 * mirror-record pulls commits IN via feed + subscribe.
 *
 * ## Smoke test it landed on (slash-name symmetry across layers)
 *
 * When we tested against the sketch substrate, the
 * `entries/2026-06-02-streamon-slash-test.md` that streamon wrote via the
 * (relaxed) name regex got mirrored as `entries/` directory + file on
 * disk. The slash convention works symmetrically: streamon writes with
 * slashes; mirror-record unpacks to directories. The path metaphor holds
 * across substrate ↔ filesystem. See [[slashes-in-name-symmetric-to-dirs-on-disk]].
 *
 * ## Lens portals
 *
 *   - [[tools-to-build-tools-turtle]] — David's framing; this is one of them
 *   - [[shared-streamon-per-identity]] — write-side pairs read-side;
 *     mirror-record extends the per-identity per-Record pattern
 *   - [[feedback_dont_invent_events]] — the recaller.watch reactive primitive
 *     IS the substrate articulating "value changed"; no polling needed
 *   - [[within-record-vs-cross-record-different-layers]] — this mirrors
 *     value.files (within-Record); cross-Record nesting (mounts.json) would
 *     need a second mirror-record for the target pubkey
 *
 * ## See this file's chain
 *
 *   bash scripts/file-history.sh scripts/mirror-record.mjs
 *
 * — past-iris, 2026-06-02 late afternoon, after the tools-to-build-tools
 *   turtle framing made the read-side counterpart's role explicit.
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
