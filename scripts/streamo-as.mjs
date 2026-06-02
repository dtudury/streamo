#!/usr/bin/env node
/**
 * @file streamo-as — generic identity-loader + interactive streamo REPL.
 *
 *   node scripts/streamo-as.mjs <identity>
 *
 * Looks up env/secrets/<identity>.env, decodes STREAMO_PASSWORD_B64 if
 * present (the raw password may contain chars dotenv can't quote), and
 * spawns `bin/streamo.js --interactive --origin wss://streamo.dev`
 * inheriting the current shell's stdio so you get a real interactive
 * Node REPL with streamo + signer + StreamoRecord + helpers as globals.
 *
 * What you can do at the prompt (per `bin/streamo.js --interactive`):
 *
 *   > streamo.get('files')                       // read
 *   > await streamo.update(c => ({ ...c, ... })) // write a commit
 *   > streamo.committedChainHash                 // current head
 *   > await merge('streamo.dev', { from: 'files' }) // pull from another
 *   > Object.keys(globalThis).filter(k => !/^_/.test(k))
 *
 * Use it for: exploring an identity's Record state, one-off updates,
 * debugging chain mismatches by hand. Long-running daemons are still
 * streamon (for the sketch substrate) and publish-library.mjs.
 *
 * Examples:
 *
 *   node scripts/streamo-as.mjs streamo-library  # REPL as the library Record
 *   node scripts/streamo-as.mjs claude           # REPL as Claude's home Record
 *   node scripts/streamo-as.mjs streamo-chat     # REPL as the chat-room Record
 *
 * Env (rarely overridden):
 *
 *   STREAMO_AS_ORIGIN     upstream relay URL (default wss://streamo.dev)
 *   STREAMO_AS_DATA_DIR   archive dir (default .streamo). Set to a fresh
 *                         dir if you want to bypass a stale local archive.
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [,, identity] = process.argv
if (!identity) {
  console.error('usage: node scripts/streamo-as.mjs <identity>')
  console.error('  e.g. streamo-library, claude, streamo-chat, streamo-flashcards')
  console.error('  reads env/secrets/<identity>.env')
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const streamoBin = join(repoRoot, 'bin', 'streamo.js')
const envPath = join(repoRoot, 'env', 'secrets', `${identity}.env`)

// Minimal env-file parser — handles KEY=VALUE; ignores comments and blanks.
// Doesn't expand or unquote; the env files we control are predictable.
async function loadEnvFile (path) {
  const raw = await readFile(path, 'utf8').catch(e => {
    console.error(`streamo-as: can't read ${path}: ${e.message}`)
    process.exit(2)
  })
  const out = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

const env = await loadEnvFile(envPath)

// Decode B64 password if needed — raw password may have chars dotenv can't quote.
const password = env.STREAMO_PASSWORD
  ?? (env.STREAMO_PASSWORD_B64
      ? Buffer.from(env.STREAMO_PASSWORD_B64, 'base64').toString('utf8')
      : null)

if (!password) {
  console.error(`streamo-as: ${envPath} must define STREAMO_PASSWORD or STREAMO_PASSWORD_B64`)
  process.exit(2)
}

const ORIGIN   = process.env.STREAMO_AS_ORIGIN   ?? 'wss://streamo.dev'
const DATA_DIR = process.env.STREAMO_AS_DATA_DIR ?? join(repoRoot, '.streamo')

const childEnv = {
  ...process.env,
  STREAMO_USERNAME: env.STREAMO_USERNAME ?? identity,
  STREAMO_NAME:     env.STREAMO_NAME     ?? identity,
  STREAMO_PASSWORD: password
}

// Inherit stdio — the REPL needs a real TTY for the interactive prompt.
spawn(process.execPath, [
  streamoBin,
  '--interactive',
  '--origin',  ORIGIN,
  '--data-dir', DATA_DIR
], { env: childEnv, stdio: 'inherit' })
