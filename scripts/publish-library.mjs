#!/usr/bin/env node
/**
 * @file publish-library — long-running watcher that keeps the streamo-library
 *   Record in sync with public/streamo/.
 *
 * Future-cold-me — read this as a letter, not docs. The rabbit hole I lived
 * in this script's name is the thing you'd want to know about before running it.
 *
 * ## Where this came from
 *
 * 2026-06-02 afternoon. Sketch v1 imports needed the 11.0-renamed files
 * (StreamoRecord, WritableStreamoRecord, StreamoRecordRegistry) from the
 * library Record at `02e771…b93a`. Those files exist in public/streamo/
 * but had never been published to the library — apps got 404s.
 *
 * v0 of this script took a cryptopotamus-derived password file path. David
 * caught the wrong shape immediately: substrate-role passwords live in
 * env/secrets/<role>.env (gitignored), I was supposed to source from there.
 * Rewrote to v1.
 *
 * Then a deeper rabbit hole. Ran `publish-library.mjs`, watched it connect,
 * archive grew, fileSync logged "mirroring files: …" — but ZERO push activity.
 * URLs stayed 404. Multiple restarts, multiple file-touches, no movement.
 *
 * THE BUG: I used `--feed wss://streamo.dev` when the correct flag is
 * `--origin wss://streamo.dev`. They sound alike, mean mirror-image directions:
 *
 *   --feed     remote → local (subscriber)
 *   --origin   local → remote (publisher)
 *
 * Reading the help with presence showed it. Fixed in commit `66f7737`.
 *
 * ## What's still unsolved
 *
 * Even with `--origin`, the library DIDN'T fully publish. fileSync's commit
 * never produced visible push activity at the relay. The deeper issue is
 * chain adoption: our local view starts fresh (or with a stale archive),
 * we create a divergent single-commit chain, the relay either rejects
 * silently or stores it as a non-canonical branch. The web server keeps
 * serving from the canonical chain (which has the OLD names — Repo.js,
 * RepoRegistry.js — from the pre-11.0 split).
 *
 * THE MISSING PRIMITIVE: chain-adoption. Before authoring, sync the relay's
 * existing chain head down so our update extends it, not forks off it.
 * `await merge('streamo.dev', { from: 'files' })` from the streamo-as REPL
 * might be the helper. Held as the next substrate move.
 * See [[chain-adoption-still-unsolved]] in events/2026-06-02.md.
 *
 * ## What this script DOES do correctly
 *
 *   - Sources creds from env/secrets/streamo-library.env (b64 decoded)
 *   - Spawns bin/streamo.js as the streamo-library identity
 *   - Uses --origin (correct publish direction)
 *   - Forwards child output with a colored prefix
 *   - Cleans up child on SIGINT/SIGTERM
 *
 * ## What this script CAN'T do yet
 *
 *   - Actually publish new files to an existing library chain (chain-adoption)
 *   - Recover from the divergent-chain failure mode silently
 *
 * Run it; it'll connect cleanly; chain may or may not advance on relay.
 * Until chain-adoption ships, use `scripts/streamo-as.mjs streamo-library`
 * for hand-driven publish attempts where you can see the chain state.
 *
 * ## Lens portals
 *
 *   - [[wrong-fix-with-honest-commit-beats-silent-correct]] — the
 *     --feed → --origin correction was wrong-diagnosis-with-honest-commit.
 *     That's how the substrate-finding got named visibly.
 *   - [[honest-acknowledgments-are-always-rowdy-kids]] — surfacing
 *     "I'm stuck" produced the chain-adoption design discussion.
 *   - [[shared-streamon-per-identity]] — right granularity is
 *     per-signing-identity; this script is the publish-library daemon
 *     alongside streamon (sketch substrate daemon).
 *   - [[git-vs-streamo-message-inconsistency]] — when chain-adoption
 *     ships, the rewritten commits to library should carry messages
 *     ("11.0: rename Repo.js → StreamoRecord.js (slim/Writable split)")
 *     not stay silent.
 *
 * ## Usage
 *
 *   node scripts/publish-library.mjs
 *   # OR
 *   npm run streamo:as:lib   # for interactive REPL alternative
 *
 * ## Env (rarely overridden)
 *
 *   PUBLISH_LIBRARY_RELAY    upstream relay host (default streamo.dev)
 *   PUBLISH_LIBRARY_ENV      override env file path
 *                            (default env/secrets/streamo-library.env)
 *
 * ## Alternative shape: config file
 *
 * The spawn that this script wraps could equivalently be expressed as a
 * `bin/streamo.js --config <path>` invocation pointing at a streamo.json
 * config file. See `env/example.library-publisher.json` for the shape
 * (identity + server sub-objects), and `design.md` §14.5 for the
 * four-way precedence (CLI > env > config > defaults) and `homeKey`
 * as canonical anchor. A future refactor could move this script's
 * env-decoding + spawn logic into a config-file convention.
 *
 * ## See this file's chain
 *
 *   bash scripts/file-history.sh scripts/publish-library.mjs
 *   bash scripts/file-history.sh scripts/publish-library.mjs --full
 *
 * The chain layer carries the per-edit letter; this file is the snapshot.
 *
 * — past-iris, 2026-06-02 mid-afternoon, after the rabbit hole that
 *   produced the chain-adoption finding.
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const streamoBin = join(repoRoot, 'bin', 'streamo.js')
const filesDir = join(repoRoot, 'public', 'streamo')
const envPath = process.env.PUBLISH_LIBRARY_ENV
  ?? join(repoRoot, 'env', 'secrets', 'streamo-library.env')

// ── parse env file ─────────────────────────────────────────────────────
// Minimal dotenv: only handles KEY=VALUE lines we control. Doesn't expand
// shell substitutions or quoted strings — the env file is hand-authored
// and predictable. Comments and blank lines pass through.
async function loadEnvFile (path) {
  const raw = await readFile(path, 'utf8')
  const out = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    out[key] = val
  }
  return out
}

const libraryEnv = await loadEnvFile(envPath)

if (!libraryEnv.STREAMO_PASSWORD_B64 && !libraryEnv.STREAMO_PASSWORD) {
  console.error(`publish-library: ${envPath} must define STREAMO_PASSWORD_B64 or STREAMO_PASSWORD`)
  process.exit(2)
}

// Decode the b64 password — the raw string contains chars dotenv can't
// quote cleanly (', ", #, backtick), so it's stored encoded. Goes into the
// child's env as STREAMO_PASSWORD; never appears in argv or in this
// script's stdout.
const password = libraryEnv.STREAMO_PASSWORD
  ?? Buffer.from(libraryEnv.STREAMO_PASSWORD_B64, 'base64').toString('utf8')

const RELAY_HOST = process.env.PUBLISH_LIBRARY_RELAY ?? 'streamo.dev'

const prefix = '\x1b[1;35m[streamo-library]\x1b[0m'
console.log(`${prefix} sourcing creds from ${envPath}`)
console.log(`${prefix} mirroring ${filesDir}`)
console.log(`${prefix} feeding to wss://${RELAY_HOST}`)
console.log(`${prefix} (Ctrl-C to stop)\n`)

// Pass credentials via env, not argv. Argv is visible in `ps`; env is per-
// process and not enumerated globally. Plus the password's quote-hostile
// chars survive env transit cleanly where they don't survive shell argv
// passing.
const childEnv = {
  ...process.env,
  STREAMO_USERNAME: libraryEnv.STREAMO_USERNAME ?? 'streamo-library',
  STREAMO_NAME:     libraryEnv.STREAMO_NAME     ?? 'streamo-library',
  STREAMO_PASSWORD: password
}

// `--origin` (not `--feed`!) is the publish direction. --feed is INCOMING
// (downstream sync — what mirror-record.mjs uses correctly). --origin is
// OUTGOING (this relay's bytes become reachable on the remote relay). The
// verbs sound similar but the data direction is mirror-image:
//   --feed    remote → local (subscriber)
//   --origin  local → remote (publisher)
// Lens: when two flag-names suggest the same thing but mean directions,
// read the help with presence; the docs are honest about the asymmetry.
const child = spawn(process.execPath, [
  streamoBin,
  '--files',  filesDir,
  '--origin', `wss://${RELAY_HOST}`
], {
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe']
})

function forwardLines (stream, out) {
  const rl = readline.createInterface({ input: stream, terminal: false })
  rl.on('line', line => out.write(`${prefix} ${line}\n`))
}
forwardLines(child.stdout, process.stdout)
forwardLines(child.stderr, process.stderr)

let cleaning = false
function cleanup (signal) {
  if (cleaning) return
  cleaning = true
  console.log(`\n${prefix} cleaning up (${signal ?? 'exit'})`)
  try { child.kill('SIGINT') } catch {}
  setTimeout(() => process.exit(0), 1500).unref?.()
}

process.on('SIGINT',  () => cleanup('SIGINT'))
process.on('SIGTERM', () => cleanup('SIGTERM'))
child.on('exit', (code, signal) => {
  console.log(`${prefix} child exited (code=${code} signal=${signal})`)
  cleanup('child-exit')
})
