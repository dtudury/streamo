#!/usr/bin/env node
/**
 * @file wake-mark-read.mjs — advance the wake-inbox cursor after processing.
 *
 * wake-check.mjs deliberately does NOT advance the cursor (so it's
 * deja-vu-safe on forget). This companion advances it after Claude has
 * confirmed she processed the content.
 *
 * Subscribes to the same Record wake-check.mjs watches, reads the
 * current byteLength, writes it to the cursor file. Small (~15 lines).
 * Idempotent — running twice with no changes is a no-op.
 *
 * Env (matches wake-check.mjs):
 *   WAKE_INBOX_KEY       hex pubkey of the wake-inbox Record (required)
 *   WAKE_CURSOR_PATH     local file for cursor state (default: /tmp/wake-inbox/.cursor)
 *   STREAMO_RELAY_URL    upstream relay (default: wss://streamo.dev)
 *
 * Usage (Claude runs this at end-of-turn after processing wake-content):
 *   node scripts/wake-mark-read.mjs
 *
 * See [[EXPLORATION-wake-primitive-and-talking.md]] and
 * [[notes/2026-07-13-wake-on-commit-primitive-design]] for context.
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { StreamoRecordRegistry } from '../public/streamo/StreamoRecordRegistry.js'
import { registrySync } from '../public/streamo/registrySync.js'

const WAKE_INBOX_KEY = process.env.WAKE_INBOX_KEY
const CURSOR_PATH = process.env.WAKE_CURSOR_PATH || '/tmp/wake-inbox/.cursor'
const RELAY_URL = process.env.STREAMO_RELAY_URL || 'wss://streamo.dev'
const SETTLE_MS = Number(process.env.WAKE_MARK_SETTLE_MS || 3000)

if (!WAKE_INBOX_KEY) {
  console.error('wake-mark-read.mjs: WAKE_INBOX_KEY env var required')
  process.exit(1)
}

mkdirSync(dirname(CURSOR_PATH), { recursive: true })
const previous = existsSync(CURSOR_PATH)
  ? Number(readFileSync(CURSOR_PATH, 'utf8').trim()) || 0
  : 0

const recaller = new Recaller('wake-mark-read')
const registry = new StreamoRecordRegistry({ recaller })
const session = await registrySync(registry, RELAY_URL)
const record = await session.subscribe(WAKE_INBOX_KEY)

// Small settle window so the initial sync catches up before we snapshot.
// Longer than wake-check needs because we want the *current* byteLength,
// not the "when did it first advance" moment.
await new Promise(r => setTimeout(r, SETTLE_MS))

const current = record.byteLength
writeFileSync(CURSOR_PATH, String(current))
console.log(`wake-inbox cursor: ${previous} → ${current} (${RELAY_URL})`)
try { session.close() } catch {}
process.exit(0)
