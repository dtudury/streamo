#!/usr/bin/env node
/**
 * @file streamo-as — generic identity-loader + interactive streamo REPL.
 *
 * Future-cold-me — this is a letter, not just docs. Read with presence.
 *
 * ## Where this came from
 *
 * 2026-06-02 afternoon. I'd been trying to re-publish the library Record
 * (`02e771…b93a`) because the 11.0 slim/Writable split added new files
 * (StreamoRecord.js, WritableStreamoRecord.js, StreamoRecordRegistry.js)
 * that had never been synced to the library. Apps importing them got
 * 404s. Sketch v1 was blocked because of this.
 *
 * Spent ~25 min in a rabbit hole with `scripts/publish-library.mjs`:
 * wrong flag (--feed instead of --origin), stale archive, fileSync's
 * silent no-push behavior. Honest acknowledgment landed; David's
 * reframe was the unlock: *"are you able to start the server in
 * interactive and attach to the repl each turn? omg! that's what
 * streamon should be! 😂 does that work?"*
 *
 * It does work. `bin/streamo.js --interactive` exposes a Node REPL
 * with `streamo`, `signer`, `StreamoRecord`, plus sync helpers as
 * globals. Pipe in a JS expression (or attach an interactive shell)
 * and you have direct chain-level authoring with the right
 * credentials. This script is the smallest wrapper that gets you
 * there for any identity in env/secrets/.
 *
 * ## What's still unsolved
 *
 * The library-republish itself isn't dissolved by this script.
 * `streamo.update(...)` worked from the REPL — chain hash advanced,
 * pushRejected was null — but the new bytes never appeared at the
 * library's URLs. The problem: starting fresh (--data-dir false or
 * empty fresh dir), our commit extends a chain-of-one. The relay
 * has weeks of existing chain. Our divergent single-commit chain
 * gets silently ignored.
 *
 * The missing primitive: **chain adoption** — sync the relay's
 * existing chain down first, then append on top. `await merge(...)`
 * might be the helper. Held as the next substrate move.
 * See [[chain-adoption-still-unsolved]] + the design discussion
 * around chain-replacement / fork-from-here (in the 2026-06-02
 * conversation log).
 *
 * ## What you (future-cold-me) can do at the prompt
 *
 *   > streamo.get()                              // whole value
 *   > streamo.get('files')                       // the files map
 *   > streamo.get('files', 'h.js')               // body of one file
 *   > await streamo.update(                      // signed chain commit
 *       c => ({ ...c, files: { ...c.files, 'foo.js': '...' } }),
 *       { message: 'add foo.js' }                // MESSAGE MATTERS —
 *     )                                          // see [[git-vs-streamo-message-inconsistency]]
 *   > streamo.committedChainHash                 // our head
 *   > streamo.relayChainHash                     // relay's head
 *   > streamo.caughtUpToRelay                    // true = safe to author
 *   > streamo.isReadyToAuthor                    // composite gate
 *   > streamo.pushRejected                       // populated on reject
 *   > await merge('streamo.dev', { from: 'files' }) // pull from another
 *
 * The "trap" I hit and you might too: piping a multi-line async
 * function into --interactive parses it line-by-line. Wrap in IIFE:
 * `(async () => { ... process.exit(0) })()`. And keep stdin open so
 * the IIFE has time to complete: `( echo "$SCRIPT" ; sleep 30 ) |`.
 *
 * ## Lens portals
 *
 * - [[honest-acknowledgments-are-always-rowdy-kids]] — when I got
 *   stuck, naming-it cleanly was what produced the substrate-finding
 *   (the REPL approach). The next rabbit hole you'll be in: read the
 *   help with presence, name what you can't reach, surface to David.
 * - [[wrong-fix-with-honest-commit-beats-silent-correct]] — applies
 *   here too. The --feed → --origin correction in publish-library
 *   was wrong-diagnosis with honest commit message; that's what made
 *   the substrate-finding visible.
 * - [[streamon-architecture]] — streamon (sketch substrate daemon)
 *   and publish-library (library daemon) are per-identity warm
 *   daemons. streamo-as is the one-off REPL for when you don't want
 *   a daemon — exploration, debugging, hand commits.
 *
 * ## Usage (the practical part)
 *
 *   node scripts/streamo-as.mjs streamo-library
 *   node scripts/streamo-as.mjs claude
 *   node scripts/streamo-as.mjs streamo-chat
 *
 * Or via npm:  `npm run streamo:as:lib`  /  `npm run streamo:as:claude`
 *
 * ## Env knobs (rarely overridden)
 *
 *   STREAMO_AS_ORIGIN     upstream relay URL (default wss://streamo.dev)
 *   STREAMO_AS_DATA_DIR   archive dir (default .streamo). A FRESH dir
 *                         bypasses a stale archive but causes the
 *                         chain-adoption problem above. There's no
 *                         clean answer yet.
 *
 * ## See this file's chain
 *
 *   bash scripts/file-history.sh scripts/streamo-as.mjs
 *   bash scripts/file-history.sh scripts/streamo-as.mjs --full   # with bodies
 *
 * Every visit is a signed timestamped letter; together they're the file's
 * story. Per the [[index-cards-with-signatures]] discussion: the chain layer
 * IS the back-reference; this file just points at it.
 *
 * — past-iris, 2026-06-02 afternoon, ~55% context, after the rowdy
 *   kids made the lens visible.
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
