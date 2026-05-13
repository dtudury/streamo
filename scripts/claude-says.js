#!/usr/bin/env node
/**
 * @file claude-says — append a journal entry as Claude.
 *
 * The CLI face of `claudeSync`. Reads Claude's credentials from the
 * environment (loaded from .env.prod when --env-file is given), opens
 * Claude's repo, syncs it with the upstream relay, appends one
 * journal entry, flushes, and exits.
 *
 * Usage:
 *
 *     node scripts/claude-says.js --env-file .env.prod "headline" "body text"
 *
 * Environment variables consumed:
 *
 *   STREAMO_CLAUDE_USERNAME      — Claude's signer username
 *   STREAMO_CLAUDE_PASSWORD      — Claude's signer password
 *                                  (regenerable via cryptopotamus.com;
 *                                  see project memory for the recipe)
 *   STREAMO_CLAUDE_ITERATIONS    — PBKDF2 iterations (default 100000)
 *   STREAMO_NAME                 — signer namespace (default 'streamo')
 *   STREAMO_RELAY_HOST           — relay hostname (default 'localhost')
 *   STREAMO_RELAY_PORT           — relay port (default 8080)
 *   STREAMO_RELAY_PROTOCOL       — 'ws' or 'wss' (default: 'wss' if port=443,
 *                                  else 'ws'). Set explicitly for non-standard
 *                                  TLS-terminated ports.
 *
 * No password is ever printed; the public key is, so the operator can
 * sanity-check that the right identity wrote the entry.
 */
import { config } from 'dotenv'
import { claudeSync } from '../public/streamo/claudeSync.js'

const args = process.argv.slice(2)
const envFileIdx = args.indexOf('--env-file')
if (envFileIdx !== -1) {
  config({ path: args[envFileIdx + 1] })
  args.splice(envFileIdx, 2)
}

const [headline, body = ''] = args
if (!headline) {
  console.error('usage: claude-says [--env-file <path>] "headline" ["body"]')
  process.exit(2)
}

const username   = process.env.STREAMO_CLAUDE_USERNAME
const password   = process.env.STREAMO_CLAUDE_PASSWORD
const iterations = +(process.env.STREAMO_CLAUDE_ITERATIONS ?? 100000)
const name       = process.env.STREAMO_NAME                ?? 'streamo'
const host       = process.env.STREAMO_RELAY_HOST          ?? 'localhost'
const port       = +(process.env.STREAMO_RELAY_PORT        ?? 8080)
const protocol   = process.env.STREAMO_RELAY_PROTOCOL      ?? (port === 443 ? 'wss' : 'ws')

if (!username || !password) {
  console.error('STREAMO_CLAUDE_USERNAME and STREAMO_CLAUDE_PASSWORD must be set')
  process.exit(2)
}

console.log(`[claude-says] ${protocol}://${host}:${port}`)
const claude = await claudeSync({ username, password, host, port, protocol, iterations, name })
console.log(`[claude-says] pubkey: ${claude.publicKeyHex}`)

const entry = await claude.appendJournalEntry(headline, body)
console.log(`[claude-says] appended: ${entry.headline}`)

await claude.close()
console.log('[claude-says] done')
