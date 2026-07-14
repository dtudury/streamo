#!/usr/bin/env node
/**
 * @file wake-check.mjs — Stop hook watcher that subscribes to a wake-inbox
 * Record on streamo.dev and wakes Claude on content advance.
 *
 * Uses Recaller.when + AbortSignal.timeout (David's design 2026-07-13:
 * "if there was a mechanism that was just 'wake me on any commit to XXX'
 * could we build everything else with that?"). Replaces the local-file
 * bash MVP with real streamo-substrate subscription.
 *
 * Contract (verified 2026-07-14 by direct test in Turnstone's session):
 *   - Content to Claude MUST go on STDERR (not stdout)
 *   - Exit 2 signals "content follows, wake"
 *   - Exit 0 signals "window elapsed, no wake"
 *   - Claude Code surfaces stderr as "Stop hook feedback:" block
 *
 * Cursor is NOT advanced here — Claude advances at end-of-turn once
 * she's confirmed processing. Deja-vu-safe on Claude's forgetting.
 *
 * Env:
 *   WAKE_INBOX_KEY       hex pubkey of the wake-inbox Record (required)
 *   WAKE_INBOX_FILE      file within the Record's value.files (default: current.md)
 *   WAKE_CURSOR_PATH     local file for cursor state (default: /tmp/wake-inbox/.cursor)
 *   WAKE_WINDOW_MS       how long to watch before exit 0 (default: 300000 = 5 min)
 *   STREAMO_RELAY_URL    upstream relay (default: wss://streamo.dev)
 *
 * See [[notes/2026-07-13-wake-on-commit-primitive-design]] for the full design.
 */
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { StreamoRecordRegistry } from '../public/streamo/StreamoRecordRegistry.js'
import { registrySync } from '../public/streamo/registrySync.js'

const WAKE_INBOX_KEY = process.env.WAKE_INBOX_KEY
const WAKE_INBOX_FILE = process.env.WAKE_INBOX_FILE || 'current.md'
const CURSOR_PATH = process.env.WAKE_CURSOR_PATH || '/tmp/wake-inbox/.cursor'
const WINDOW_MS = Number(process.env.WAKE_WINDOW_MS || 300000)
const RELAY_URL = process.env.STREAMO_RELAY_URL || 'wss://streamo.dev'

if (!WAKE_INBOX_KEY) {
  console.error('wake-check.mjs: WAKE_INBOX_KEY env var required')
  process.exit(1)
}

// Read cursor (character count of file content we last processed)
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
    () => {
      const content = record.get('files', WAKE_INBOX_FILE)
      return typeof content === 'string' && content.length > stored
    },
    { signal: AbortSignal.timeout(WINDOW_MS), name: 'wake-inbox-advance' }
  )
  const content = record.get('files', WAKE_INBOX_FILE)
  const delta = content.slice(stored)
  console.error(`wake-inbox (chars ${stored}..${content.length}) via ${RELAY_URL}:`)
  console.error(delta)
  process.exit(2)
} catch {
  process.exit(0)
}
