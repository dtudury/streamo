#!/usr/bin/env node
/**
 * @file wake-check.mjs — Stop hook watcher for a wake-inbox streamo Record.
 *
 * The primitive (per David 2026-07-14): "wake me on any commit to Record X."
 * Watches the Record's byteLength via Recaller.when + AbortSignal.timeout;
 * on any advance, emits the Record's current decoded value + exits 2.
 * File-agnostic — any change to any file (or top-level value) triggers wake.
 *
 * If per-file granularity is wanted, use a per-file Record. Cheap-to-create,
 * cheap-to-abandon; we prune later.
 *
 * Contract (verified 2026-07-14):
 *   - Content to Claude MUST go on STDERR (not stdout)
 *   - Exit 2 signals wake with content; exit 0 signals window elapsed
 *   - Claude Code surfaces stderr as "Stop hook feedback:" block
 *
 * Cursor is byteLength (numeric). NOT advanced here — Claude advances at
 * end-of-turn once she's confirmed processing. Deja-vu-safe on forget.
 *
 * Env:
 *   WAKE_INBOX_KEY       hex pubkey of the wake-inbox Record (required)
 *   WAKE_CURSOR_PATH     local file for cursor state — if unset, derived from
 *                        the Claude session UUID (read from Claude Code's hook
 *                        stdin JSON: transcript_path). Fallback:
 *                        /tmp/wake-inbox/.cursor (shared; only correct when
 *                        one Claude Code session runs this at a time).
 *   WAKE_WINDOW_MS       how long to watch before exit 0 (default: 300000 = 5 min)
 *   STREAMO_RELAY_URL    upstream relay (default: wss://streamo.dev)
 *
 * See [[notes/2026-07-13-wake-on-commit-primitive-design]] for the full design,
 * and [[procedure_waking_on_streamo_events]] for the runbook on what to do
 * when this hook fires.
 */
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { dirname, basename } from 'path'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { StreamoRecordRegistry } from '../public/streamo/StreamoRecordRegistry.js'
import { registrySync } from '../public/streamo/registrySync.js'

// Claude Code passes hook data as JSON on stdin (including transcript_path,
// which encodes the Claude session UUID). We use it to derive a per-session
// cursor file — critical when multiple Claude Code sessions are open on the
// same project, so one session's cursor advance doesn't block another
// session's wake. Caught 2026-07-21 when Turnstone + Wagtail shared a
// cursor and messages were invisible to whichever session's Stop hook
// fired second.
let hookInput = {}
try {
  const stdinData = readFileSync(0, 'utf8')
  if (stdinData.trim()) hookInput = JSON.parse(stdinData)
} catch {}
const transcriptPath = hookInput.transcript_path
const sessionId = transcriptPath ? basename(transcriptPath, '.jsonl') : null

const WAKE_INBOX_KEY = process.env.WAKE_INBOX_KEY
const CURSOR_PATH = process.env.WAKE_CURSOR_PATH
  || (sessionId ? `/tmp/wake-inbox/.cursor-${sessionId}` : '/tmp/wake-inbox/.cursor')
const WINDOW_MS = Number(process.env.WAKE_WINDOW_MS || 300000)
const RELAY_URL = process.env.STREAMO_RELAY_URL || 'wss://streamo.dev'

if (!WAKE_INBOX_KEY) {
  console.error('wake-check.mjs: WAKE_INBOX_KEY env var required')
  process.exit(1)
}

mkdirSync(dirname(CURSOR_PATH), { recursive: true })
const stored = existsSync(CURSOR_PATH)
  ? Number(readFileSync(CURSOR_PATH, 'utf8').trim()) || 0
  : 0

const recaller = new Recaller('wake-check')
const registry = new StreamoRecordRegistry({ recaller })
const session = await registrySync(registry, RELAY_URL)
const record = await session.subscribe(WAKE_INBOX_KEY)

try {
  await recaller.when(
    () => record.byteLength > stored,
    { signal: AbortSignal.timeout(WINDOW_MS), name: 'wake-inbox-advance' }
  )
  const currentLen = record.byteLength
  let valueStr
  try {
    valueStr = JSON.stringify(record.get(), null, 2)
  } catch (e) {
    valueStr = `(could not decode value: ${e.message})`
  }
  console.error(`wake-inbox advanced (byteLength ${stored} → ${currentLen}) via ${RELAY_URL}:`)
  console.error(valueStr)
  console.error('')
  console.error('after processing, advance cursor with:')
  console.error(`  echo ${currentLen} > ${CURSOR_PATH}`)
  console.error('(see the-grove memory/procedure_waking_on_streamo_events.md for the full runbook)')
  process.exit(2)
} catch {
  process.exit(0)
}
