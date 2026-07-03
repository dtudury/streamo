#!/usr/bin/env node

import { readFileSync } from 'fs'
import { dirname, isAbsolute, resolve } from 'path'
import { Option, program } from 'commander'
import { config } from 'dotenv'
import { question } from 'readline-sync'
import { start as startRepl } from 'repl'
import { StreamoServer } from '../public/streamo/StreamoServer.js'
import { StreamoRecord } from '../public/streamo/StreamoRecord.js'
import { StreamoRecordRegistry } from '../public/streamo/StreamoRecordRegistry.js'
import { FolderRecord } from '../public/streamo/FolderRecord.js'
import { MemoryTier, DiskTier } from '../public/streamo/StorageTier.js'
import { archiveSync } from '../public/streamo/archiveSync.js'
import { fileSync } from '../public/streamo/fileSync.js'
import { identity } from '../public/streamo/identity.js'
import { dispatch } from '../public/streamo/dispatch.js'
import { outletSync } from '../public/streamo/outletSync.js'
import { originSync } from '../public/streamo/originSync.js'
import { s3Sync } from '../public/streamo/s3Sync.js'
import { join } from 'path'
import { PushStore, pushRoutes, notifyOnMessages } from '../public/apps/chat/push.js'
import { setLogLevel, logInfo, logDebug } from '../public/streamo/utils/logger.js'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))

program
  .name('streamo')
  .description('streamo CLI')
  .version(version)
  .allowExcessArguments(true)

  .addOption(
    new Option('--config <path>', 'path to a streamo.json config file. Fields under `identity` (name/username/password/keyIterations/self) and `server` (web/outlet/feed/files/archive/verbose/recordFile) fill in any options not set on the CLI. Relative paths resolve against the config file\'s directory.')
      .env('STREAMO_CONFIG')
  )
  .addOption(
    new Option('--env-file <path>', 'path to .env file')
  )
  .addOption(
    new Option('--name <string>', 'name for this dataset')
      .env('STREAMO_NAME')
  )
  .addOption(
    new Option('--username <string>', 'username for signing')
      .env('STREAMO_USERNAME')
  )
  .addOption(
    new Option('--password <string>', 'password for signing')
      .env('STREAMO_PASSWORD')
  )
  .addOption(
    new Option('--home-key <pubkeyhex>', 'open a Record by pubkey in relay-only mode (no signer derived; bytes arrive via sync from an author process). Mutually exclusive with --name/--username/--password and incompatible with --files/--merge-from.')
      .env('STREAMO_HOME_KEY')
  )
  .addOption(
    new Option('--data-dir <path>', 'directory for archive files (defaults to .streamo). Pass `false` to skip archive writes entirely — the in-memory cache still works; just nothing hits disk.')
      .env('STREAMO_DATA_DIR')
  )
  .addOption(
    new Option('--files [path]', 'mirror local files to/from streamo (defaults to current directory)')
      .env('STREAMO_FILES')
      .preset('.')
  )
  .addOption(
    new Option('--mounts-only', 'lightweight-outermost mode: only mounts.json lands in this Record. Shards populate separately (other --files runs, seed scripts, or FolderRecord.writeMany with mountsOnly).')
      .env('STREAMO_MOUNTS_ONLY')
  )
  .addOption(
    new Option('--record-file [name]', 'sync a JSON file on disk (default: streamo.json) into the record\'s value MINUS the files key. Lets you author top-level metadata (title, etc.) as plain JSON. Mounts live in their own file (mounts.json in the files map). Auto-enabled when --files is set; use --no-record-file to disable.')
      .env('STREAMO_RECORD_FILE')
      .preset('streamo.json')
  )
  .addOption(
    new Option('--no-record-file', 'disable the streamo.json sync')
  )
  .addOption(
    new Option('--merge-from <url>', 'on first run only (empty Record), fork from this URL or host. Accepts http(s)://host[:port]/streams/<keyHex> or just "host[:port]" (uses /api/info to find the primary key). Idempotent — skipped on subsequent runs.')
      .env('STREAMO_MERGE_FROM')
  )
  .addOption(
    new Option('--merge-from-key <key>', 'when merging from --merge-from, only incorporate the source value at this sub-key (e.g. "files" to merge just the homepage; defaults to the whole value)')
      .env('STREAMO_MERGE_FROM_KEY')
  )
  .addOption(
    new Option('--state-file <path>', 'write streamo state as JSON to this file on every change')
      .env('STREAMO_STATE_FILE')
  )
  .addOption(
    new Option('--s3-bucket <name>', 'S3 bucket name')
      .env('STREAMO_S3_BUCKET')
  )
  .addOption(
    new Option('--s3-endpoint <url>', 'S3-compatible endpoint (omit for AWS)')
      .env('STREAMO_S3_ENDPOINT')
  )
  .addOption(
    new Option('--s3-region <region>', 'S3 region')
      .env('STREAMO_S3_REGION')
  )
  .addOption(
    new Option('--s3-access-key-id <id>', 'S3 access key ID')
      .env('STREAMO_S3_ACCESS_KEY_ID')
  )
  .addOption(
    new Option('--s3-secret-access-key <key>', 'S3 secret access key')
      .env('STREAMO_S3_SECRET_ACCESS_KEY')
  )
  .addOption(
    new Option('--web [port]', 'start HTTP + WebSocket server for browsers and peers')
      .env('STREAMO_WEB')
      .preset('8080')
  )
  .addOption(
    new Option('--enable-push', 'enable Web Push notifications when --web is set. Requires STREAMO_VAPID_PUBLIC, STREAMO_VAPID_PRIVATE (and optional STREAMO_VAPID_SUBJECT) in env — secrets stay off argv.')
      .env('STREAMO_ENABLE_PUSH')
  )
  .addOption(
    new Option('--outlet [port]', 'accept inbound WebSocket peer connections')
      .env('STREAMO_OUTLET')
      .preset('1024')
  )
  .addOption(
    new Option('--origin <url>', 'connect to a remote outlet over WebSocket. Accepts ws://host[:port] or wss://host[:port] (URL shape), or host[:port] shorthand (port 443 → wss, no port → wss, other port → ws). On open, the remote opens (and persists, if archiveSync-backed) your streamo on its side — for a publicly-served relay, this is how your bytes become reachable at <host>/streams/<your-key>.')
      .env('STREAMO_ORIGIN')
  )
  .addOption(
    new Option('--feed <url>', 'attach a feed to a remote outlet — this relay\'s outbound WebSocket dial. Bytes for the remote\'s home Record (and its mounted records via the followMounts cascade) flow down; any local commits flow up through the same connection. Can be repeated; each value opens an independent feed. URL shape matches --origin.')
      .env('STREAMO_FEED')
      .argParser((val, prev = []) => [...prev, val])
      .default([])
  )
  .addOption(
    new Option('--subscribe <pubkey>', 'subscribe to a specific Record key beyond what the feed\'s followMounts cascade brings in. Repeatable. Requires --feed to give it a transport — subscriptions are attached to the first open feed session.')
      .env('STREAMO_SUBSCRIBE')
      .argParser((val, prev = []) => [...prev, val])
      .default([])
  )
  .addOption(
    new Option('--cat <file>', 'one-shot: print value.files[<file>] to stdout and exit (use with --home-key + --feed)')
      .env('STREAMO_CAT')
  )
  .addOption(
    new Option('--eval <expr>', 'one-shot: evaluate <expr> with streamo/signer/registry/recaller/record in scope, print result to stdout, exit')
      .env('STREAMO_EVAL')
  )
  .addOption(
    new Option('--interactive', 'start a REPL with streamo, signer, and helpers as globals')
      .env('STREAMO_INTERACTIVE')
  )
  .addOption(
    new Option('--repl-socket <path>', 'expose the REPL over a Unix socket at <path>; connect with `nc -U <path>` or `streamo --repl-connect <path>`. Multiple concurrent connections OK; disconnecting doesn\'t kill the process. Complements or replaces --interactive.')
      .env('STREAMO_REPL_SOCKET')
  )
  .addOption(
    new Option('--repl-connect <path>', 'connect to a Unix-socket REPL at <path> (typically served by another streamo process with --repl-socket). Forwards raw keystrokes so tab-completion, history, and line-editing work. Ctrl-D or `.exit` disconnects; Ctrl-C interrupts an eval.')
      .env('STREAMO_REPL_CONNECT')
  )
  .addOption(
    new Option('--key-iterations <number>', 'PBKDF2 iterations for key derivation (lower = faster startup, less secure)')
      .env('STREAMO_KEY_ITERATIONS')
      .default(100000)
      .argParser(Number)
  )
  .addOption(
    new Option('--verbose [level]', 'verbose logging level: off/warn/info/debug/trace/silly (no arg = debug)')
      .env('STREAMO_VERBOSE')
      .preset('debug')
  )

  .parse()

const options = program.opts()

// Early-exit client: connect the socket, raw-mode stdin so single
// keystrokes forward (tab-completion needs this), pipe stdout back.
// Ctrl-C (0x03) is forwarded — that's how the server-side REPL sees
// SIGINT to interrupt an eval.
if (options.replConnect) {
  const socketPath = options.replConnect
  const { createConnection } = await import('node:net')
  const socket = createConnection(socketPath)
  socket.on('error', (e) => { process.stderr.write(`--repl-connect: ${e.message}\n`); process.exit(1) })
  socket.on('close', () => {
    try { process.stdin.setRawMode?.(false) } catch {}
    process.exit(0)
  })
  socket.pipe(process.stdout)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.pipe(socket)
  // Block forever — never fall through to server setup.
  await new Promise(() => {})
}

// Positional dispatch: streamo <object> [<method> [<args>...]] becomes an
// --eval expression. Pure reflection of the JS API into bash positional
// args — no escape characters for typical method calls.
//
//   streamo signer publicKeyHex            → signer.publicKeyHex
//   streamo record                         → record  (whole object)
//   streamo record update bio "hello"      → await record.update("bio", "hello")
//   streamo record get index.html          → record.get("index.html")
//
// Args are JSON.stringified, so strings keep their quotes and the user
// doesn't escape anything. Numbers come in as strings — call sites that
// want number args use --eval explicitly with the right types.
if (program.args.length >= 1 && !options.eval) {
  const [objName, methodName, ...rest] = program.args
  options._dispatch = {
    objName,
    methodName,                       // may be undefined → returns the object itself
    args: rest.length ? rest : undefined  // may be undefined → returns the property
  }
}

// keep one-shot modes' stdout clean
if (options.cat || options.eval || options.chat || options._dispatch) {
  console.log = (...a) => process.stderr.write(a.join(' ') + '\n')
}

// Server-less verbs (run before server creation). `identity` is the
// canonical example: `streamo identity new <name>` creates a fresh
// signing identity (random password + derived pubkey + env file)
// BEFORE you have any credentials. No server needed; no env required.
// Detected by positional dispatch's objName === 'identity'.
if (options._dispatch?.objName === 'identity') {
  try {
    const { methodName, args } = options._dispatch
    const result = await dispatch({ identity }, 'identity', methodName, args)
    // CLI convention: stdout = the data, stderr = the human metadata.
    // For `identity new <name>`, that means: env-file content to stdout
    // (pipe it: `streamo identity new foo > env/secrets/foo.env`), and
    // the pubkey + usage hint to stderr (visible in terminal even when
    // stdout's redirected). For other identity verbs that return strings
    // or bytes directly, just write them.
    if (typeof result === 'string') {
      process.stdout.write(result.endsWith('\n') ? result : result + '\n')
    } else if (result instanceof Uint8Array) {
      process.stdout.write(result)
    } else if (result && typeof result === 'object' && typeof result.envContent === 'string') {
      // identity.new shape — pipe-friendly: env content to stdout.
      process.stdout.write(result.envContent)
      process.stderr.write(`\nidentity: ${result.name}\n`)
      process.stderr.write(`pubkey:   ${result.pubkeyHex}\n`)
      process.stderr.write(`save it:  streamo identity new ${result.name} > env/secrets/${result.name}.env\n`)
    } else if (result !== undefined) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    }
    process.exit(0)
  } catch (e) {
    process.stderr.write(`streamo identity: ${e.message}\n`)
    process.exit(1)
  }
}

if (options.envFile) {
  config({ path: options.envFile })
  program.parse()
  Object.assign(options, program.opts())
}

// streamo.json config — fields fill in defaults for any option not already
// set on the CLI (or via env). Relative paths resolve against the config
// file's directory, not CWD, so a config can ship next to its files dir
// and Just Work no matter where you run from.
if (options.config) {
  applyStreamoJsonConfig(options.config, options)
}

// Translate identity.homeKey (or its deprecated alias identity.self) into
// the right downstream signal based on whether credentials will be supplied.
//   - credentials present → _expectedSelf (verify derived pubkey matches)
//   - credentials absent  → homeKey (relay-only mode; no derivation)
// This is how a single config field replaces the two previous CLI-flag /
// config-field paths and gives the four-way matrix discussed in the
// homeKey rename.
if (options._configHomeKey) {
  if (options.homeKey && options.homeKey !== options._configHomeKey) {
    console.error('\x1b[31mconflict: --home-key flag and identity.homeKey config disagree\x1b[0m')
    console.error(`\x1b[31m  --home-key:        ${options.homeKey}\x1b[0m`)
    console.error(`\x1b[31m  identity.homeKey:  ${options._configHomeKey}\x1b[0m`)
    process.exit(2)
  }
  const willHaveCreds = !!(options.name || options.username || options.password)
  if (willHaveCreds) {
    options._expectedSelf = options._configHomeKey
  } else {
    options.homeKey ??= options._configHomeKey
  }
}

// Apply post-config defaults — fields the commander option no longer carries
// a default for (because config might want to leave them off / drop them).
// dataDir: false is the explicit no-archive signal; undefined defaults to
// `.streamo` (or `false` for one-shot reads — see --cat / --eval).
//
// Shell coercion: --data-dir false comes in as the string "false" from
// argv; coerce to actual boolean false so MemoryTier-only mode triggers
// instead of creating a directory literally named `false/`.
if (options.dataDir === 'false') options.dataDir = false
if (options.dataDir === undefined) {
  options.dataDir = (options.cat || options.eval || options.chat) ? false : '.streamo'
}

function applyStreamoJsonConfig (configPath, opts) {
  const absPath = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)
  const configDir = dirname(absPath)
  let raw
  try {
    raw = readFileSync(absPath, 'utf-8')
  } catch (e) {
    console.error(`\x1b[31m--config: failed to read ${absPath}: ${e.message}\x1b[0m`)
    process.exit(2)
  }
  let cfg
  try {
    cfg = JSON.parse(raw)
  } catch (e) {
    console.error(`\x1b[31m--config: ${absPath} is not valid JSON: ${e.message}\x1b[0m`)
    process.exit(2)
  }
  const resolveRel = p => (typeof p === 'string') ? (isAbsolute(p) ? p : resolve(configDir, p)) : p

  // identity → credentials + homeKey
  if (cfg.identity && typeof cfg.identity === 'object') {
    opts.name          ??= cfg.identity.name
    opts.username      ??= cfg.identity.username
    opts.password      ??= cfg.identity.password
    opts.keyIterations  =  opts.keyIterations ?? cfg.identity.keyIterations ?? opts.keyIterations

    // `homeKey` is the canonical name for "the pubkey of the Record we're
    // operating on." Behavior depends on what else is set:
    //   - homeKey + credentials  → derive + verify (refuse if mismatch).
    //                              Catches typo'd password / wrong config
    //                              before any bytes get signed under the
    //                              wrong key.
    //   - homeKey alone          → relay-only mode (no derivation; same
    //                              codepath as the --home-key CLI flag).
    //   - credentials alone      → derive; pubkey is whatever results.
    //   - nothing                → error (relay needs to know what Record
    //                              it's serving).
    if (cfg.identity.homeKey) {
      // Defer the mode decision to the credential-presence check below;
      // store on _configHomeKey so the CLI's --home-key flag can take
      // precedence (and so we can decide verify-vs-relay-only correctly).
      opts._configHomeKey = cfg.identity.homeKey
    }
  }

  // server → feature flags
  const s = cfg.server || {}

  // archive:
  //   false                 → ephemeral (no DiskTier; MemoryTier only)
  //   <string>              → dataDir path
  //   { dataDir }           → explicit dataDir
  //   { mode: 'ephemeral' } → same as false
  // The old `mode: 'flat'/'tiered'/'preserved-only'` switch was removed
  // in 13.0; explicit tier construction handles those shapes now.
  if (s.archive === false) {
    opts.dataDir = false
  } else if (typeof s.archive === 'string') {
    opts.dataDir ??= resolveRel(s.archive)
  } else if (s.archive && typeof s.archive === 'object') {
    if (s.archive.mode === 'ephemeral') opts.dataDir = false
    else if (s.archive.dataDir) opts.dataDir ??= resolveRel(s.archive.dataDir)
  }

  // web: true → default port, number → that port
  if (s.web !== undefined && opts.web === undefined) {
    opts.web = s.web === true ? '8080' : String(s.web)
  }

  // outlet: true → default port, number → that port
  if (s.outlet !== undefined && opts.outlet === undefined) {
    opts.outlet = s.outlet === true ? '1024' : String(s.outlet)
  }

  // feed: merged with any CLI --feed flags (so config can declare base
  // outbound connections and CLI can add more). `feed` is canonical;
  // `watch` is accepted as a deprecated alias.
  const feedField = s.feed ?? s.watch
  if (feedField) {
    const feeds = Array.isArray(feedField) ? feedField : [feedField]
    opts.feed = [...(opts.feed || []), ...feeds]
  }

  // files: directory to mirror — resolved against config's directory
  if (s.files !== undefined && opts.files === undefined) {
    opts.files = resolveRel(s.files)
  }

  // verbose: log level
  if (s.verbose !== undefined && opts.verbose === undefined) {
    opts.verbose = String(s.verbose)
  }

  // recordFile: explicit on/off/name from config
  if (s.recordFile !== undefined && opts.recordFile === undefined) {
    opts.recordFile = s.recordFile
  }

  // subscribe: explicit pubkeys to pull beyond the feed's followMounts
  // cascade. Merged with any CLI --subscribe.
  if (Array.isArray(s.subscribe)) {
    opts.subscribe = [...(opts.subscribe || []), ...s.subscribe]
  }

  // hostMap: { hostname: pubkeyHex } for host-aware --web routing.
  // Config-only (a map doesn't make sense as a CLI flag). webSync uses
  // this to pick which Record's files serve each incoming Host: header.
  if (s.hostMap && typeof s.hostMap === 'object') {
    opts.hostMap = { ...(opts.hostMap || {}), ...s.hostMap }
  }
}

if (options.verbose !== undefined) setLogLevel(options.verbose)

// Build the tier list for StreamoServer.create from legacy --data-dir
// semantics. `options.dataDir === false` → MemoryTier-only (ephemeral);
// otherwise a single DiskTier at the resolved path. Callers wanting
// multi-tier setups (memory + disk with eviction, preserved/cache split,
// etc.) construct their own tiers and pass via --config or embedding.
function buildTiers (opts) {
  if (opts.dataDir === false) {
    return [new MemoryTier({ capacity: Infinity })]
  }
  return [new DiskTier({ dir: opts.dataDir, capacity: Infinity })]
}

// --feed doesn't auto-push --home-key
if (options.homeKey && options.feed?.length > 0) {
  options.subscribe = options.subscribe ?? []
  if (!options.subscribe.includes(options.homeKey)) {
    options.subscribe.push(options.homeKey)
  }
}

// Two startup shapes:
//   (1) Author — derives a signer from {name, username, password}; can
//       commit (--files, --merge-from, REPL writes).
//   (2) Relay-only — opens a repo by pubkey via --home-key; holds no
//       secrets; bytes arrive via sync from an author process running
//       elsewhere with the matching credentials.
//
// In relay-only mode, --files / --merge-from are rejected up front
// because both require a signer.
let server
if (options.homeKey) {
  if (options.username || options.password || options.name) {
    console.error('\x1b[31mcannot combine --home-key with --name/--username/--password — author and relay are mutually exclusive modes\x1b[0m')
    process.exit(2)
  }
  if (options.files) {
    console.error('\x1b[31m--files requires a signer; not available with --home-key (run an author process separately for the signing side)\x1b[0m')
    process.exit(2)
  }
  if (options.mergeFrom) {
    console.error('\x1b[31m--merge-from writes a signed commit; not available with --home-key (run an author process for the merge)\x1b[0m')
    process.exit(2)
  }
  server = await StreamoServer.create({
    publicKeyHex:  options.homeKey,
    tiers:         buildTiers(options),
    keyIterations: options.keyIterations,
  })
} else {
  options.name     ||= question('Name: ')
  options.username ||= question('Username: ')
  // Single-entry hidden input — same deterministic-key model as
  // fork-homepage.js.  No confirmation prompt: streamo's password →
  // keypair is recoverable (re-run with the right password lands on
  // the right key), so the double-prompt was security theater for
  // this use case and friction on every re-run.
  const password = options.password || question('Password (hidden): ', { hideEchoBack: true, mask: '' })
  server = await StreamoServer.create({
    name:          options.name,
    username:      options.username,
    password,
    tiers:         buildTiers(options),
    keyIterations: options.keyIterations,
  })
}

const { name, username, publicKeyHex, signer, streamo, registry } = server

// Soft-assert: if --config declared an expected pubkey (`identity.homeKey`,
// or its deprecated alias `identity.self`), refuse to start when the derived
// pubkey doesn't match. Catches typo'd password / wrong credentials before
// any bytes get signed under the wrong key.
if (options._expectedSelf && options._expectedSelf !== publicKeyHex) {
  console.error(`\x1b[31midentity.homeKey mismatch:\x1b[0m`)
  console.error(`\x1b[31m  config expects:  ${options._expectedSelf}\x1b[0m`)
  console.error(`\x1b[31m  derived:         ${publicKeyHex}\x1b[0m`)
  console.error(`\x1b[31mcheck name / username / password / keyIterations against the config\x1b[0m`)
  process.exit(2)
}

const envDir  = options.envFile ? dirname(options.envFile).replace(/^public\//, '') : null
const appPath = (envDir && envDir !== '.') ? `/${envDir}/` : '/'
const webUrl  = options.web ? `http://localhost:${+options.web}${appPath}` : null
const rows = [
  ...(name     ? [['NAME',     name]]     : []),
  ...(username ? [['USERNAME', username]] : []),
  ...(server.signer ? [] : [['MODE', 'relay-only (no signer)']]),
  ['PUBLIC KEY', publicKeyHex],
  ...(webUrl ? [['URL', webUrl]] : []),
]
const maxLength = Math.max(...rows.map(([, v]) => v.length))
const pad   = (v) => v + ' '.repeat(maxLength - v.length)
const div   = '─'.repeat(maxLength)
const label = (l) => l.padStart(16)
console.log(`\x1b[35m
    ╭${'─'.repeat(maxLength + 23)}╮
    ╞══════════════════╤══${'═'.repeat(maxLength)}══╡
${rows.map(([l, v], i) => [
  `    │ ${label(l + ':')} │  \x1b[0m${pad(v)}\x1b[35m  │`,
  i < rows.length - 1 ? `    ├──────────────────┼──${div}──┤` : null
].filter(Boolean).join('\n')).join('\n')}
    ╰──────────────────┴──${'━'.repeat(maxLength)}──╯\x1b[0m`)

// First-run fork: if --merge-from is set AND this repo is empty,
// pull a snapshot from the upstream and commit a pure-copy with
// remoteParent cited.  On subsequent runs (repo has commits already),
// this is a no-op — the user's own chain is the canonical state and
// re-merging would just append duplicate fork commits.  Runs BEFORE
// --files so fileSync sees the merged content when it starts.
if (options.mergeFrom) {
  if (streamo.lastCommit) {
    logInfo(`\x1b[33mmerge-from: skipping (Record already has commits)\x1b[0m`)
  } else {
    try {
      const mergeOptions = options.mergeFromKey ? { from: options.mergeFromKey } : {}
      await streamo.merge(options.mergeFrom, mergeOptions)
      const c = streamo.lastCommit
      const rp = c.remoteParent
      const slice = options.mergeFromKey
        ? `value.${options.mergeFromKey}`
        : 'value'
      console.log(`\x1b[32mmerge-from: forked from ${rp.host} (${rp.repo.slice(0, 12)}…) — ${slice} @${rp.dataAddress}\x1b[0m`)
    } catch (e) {
      console.error(`\x1b[31mmerge-from failed: ${e.message}\x1b[0m`)
      console.error(`\x1b[31m  is a streamo running at ${options.mergeFrom}?\x1b[0m`)
      process.exit(7)
    }
  }
}

// --origin connects BEFORE --files so the relay's `{type: 'subscribed',
// atOffset}` ack can arrive before fileSync makes its disk-vs-repo
// authority decision. With this order, an author command against a
// populated relay reads "no relay → wait → caught up → author"
// instead of "no relay yet (false negative) → commit on fresh chain →
// push rejected with chain-mismatch." See StreamoRecord.isReadyToAuthor.
if (options.origin) {
  await server.connect(options.origin)
  console.log(`\x1b[32morigin: connected to ${options.origin}\x1b[0m`)
}

// --feed attaches this relay's outbound connections to remote outlets.
// Each remote's home Record + mounted records flow down via the
// followMounts cascade. Combined with --web's hostMap option, this lets
// one relay serve content authored on another. Repeatable: each --feed
// opens an independent connection. (Deprecated 10.x aliases --watch and
// --peer retired in 11.0.)
const feedHosts = options.feed || []
const feedSessions = []
if (feedHosts.length > 0) {
  for (const feedUrl of feedHosts) {
    const session = await server.feed(feedUrl)
    feedSessions.push(session)
    console.log(`\x1b[32mfeed: attached to ${feedUrl}\x1b[0m`)
  }
}

// --subscribe pulls in Records that the feed's followMounts cascade
// doesn't bring naturally — explicit keys outside the host's mount tree.
// Attaches to the first feed session; subscriptions stick across reconnect.
if (options.subscribe && options.subscribe.length > 0) {
  if (feedSessions.length === 0) {
    console.error('\x1b[31m--subscribe requires --feed to give it a transport\x1b[0m')
    process.exit(2)
  }
  for (const key of options.subscribe) {
    await feedSessions[0].subscribe(key)
    console.log(`\x1b[32msubscribe: ${key.slice(0, 8)}…\x1b[0m`)
  }
}

if (options.cat) {
  const targetFile = options.cat
  const recaller = server.registry.recaller
  const record = server.streamo
  const session = feedSessions[0] ?? null
  const timeoutMs = 30000

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for record to materialize')),
        timeoutMs
      )
      recaller.watch('cat-wait', () => {
        if (record.lastCommit) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    const folder = new FolderRecord(record, server.registry, { session, materializeTimeoutMs: timeoutMs })
    const content = await folder.resolvePath(targetFile)
    if (content === null || content === undefined) {
      process.stderr.write(`--cat: ${JSON.stringify(targetFile)} not found in this record or any mounted record\n`)
      process.exit(1)
    }
    process.stdout.write(typeof content === 'string' ? content : (content instanceof Uint8Array ? content : JSON.stringify(content, null, 2)))
    process.exit(0)
  } catch (e) {
    process.stderr.write(`--cat: ${e.message}\n`)
    process.exit(1)
  }
}

if (options.eval) {
  const recaller = server.registry.recaller
  const record = server.streamo

  try {
    // Soft-wait for record materialization ONLY if the expression
    // references the record. Otherwise (e.g., `signer.publicKeyHex`)
    // run immediately. Soft wait caps at 3s — past that, the eval
    // runs against whatever the local record has.
    if (/\brecord\b/.test(options.eval)) {
      await Promise.race([
        new Promise(resolve => {
          recaller.watch('eval-wait', () => {
            if (record.get() != null) resolve()
          })
        }),
        new Promise(resolve => setTimeout(resolve, 3000))
      ])
    }

    const AsyncFunction = (async () => {}).constructor
    const fn = new AsyncFunction(
      'streamo', 'signer', 'registry', 'recaller', 'record', 'identity', 'dispatch',
      `return (${options.eval})`
    )
    const result = await fn(
      server.streamo, server.signer, server.registry,
      server.registry.recaller, server.streamo, identity, dispatch
    )
    if (typeof result === 'string') process.stdout.write(result)
    else if (result instanceof Uint8Array) process.stdout.write(result)
    else if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2))
    process.exit(0)
  } catch (e) {
    process.stderr.write(`--eval: ${e.message}\n`)
    process.exit(1)
  }
}

// Positional dispatch (post-server). The early `_dispatch` block above
// handles the server-less identity case; this block handles everything
// else: `streamo record get index.html`, `streamo signer publicKeyHex`,
// `streamo record update bio "new bio"`, etc. Single primitive (dispatch)
// across all surfaces — see public/streamo/dispatch.js.
if (options._dispatch) {
  const recaller = server.registry.recaller
  const record = server.streamo
  try {
    // Soft-wait for record materialization (same heuristic as --eval)
    // when the call targets the record.
    if (options._dispatch.objName === 'record') {
      await Promise.race([
        new Promise(resolve => {
          recaller.watch('dispatch-wait', () => {
            if (record.get() != null) resolve()
          })
        }),
        new Promise(resolve => setTimeout(resolve, 3000))
      ])
    }
    const scope = {
      streamo: server.streamo,
      signer:  server.signer,
      registry: server.registry,
      recaller: server.registry.recaller,
      record:  server.streamo,
      identity
    }
    const { objName, methodName, args } = options._dispatch
    const result = await dispatch(scope, objName, methodName, args)
    if (typeof result === 'string') process.stdout.write(result)
    else if (result instanceof Uint8Array) process.stdout.write(result)
    else if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2))
    process.exit(0)
  } catch (e) {
    process.stderr.write(`streamo: ${e.message}\n`)
    process.exit(1)
  }
}

if (options.files) {
  const folder = typeof options.files === 'string' ? options.files : '.'
  // recordFile defaults to `'streamo.json'` whenever --files is set, so
  // top-level metadata (title, journalists, entries, ...) authored on
  // disk reaches the Record's value without a separate opt-in. Mounts
  // are NOT in the recordFile mirror — they live in mounts.json (a
  // regular file in the Record's files map), synced like any other
  // file. --no-record-file disables the streamo.json sync entirely.
  const recordFile = options.recordFile !== undefined
    ? options.recordFile
    : 'streamo.json'
  await server.files(folder, { recordFile, dataDir: options.dataDir, mountsOnly: !!options.mountsOnly })
  const recordFileNote = recordFile
    ? ` (recordFile: ${recordFile === true ? 'streamo.json' : recordFile})`
    : ''
  console.log(`\x1b[32mmirroring files: ${folder} (at value.files)${recordFileNote}\x1b[0m`)
}

if (options.stateFile) {
  server.stateFile(options.stateFile)
  console.log(`\x1b[32mstate file: ${options.stateFile}\x1b[0m`)
}

if (options.s3Bucket) {
  await server.s3({
    bucket:          options.s3Bucket,
    endpoint:        options.s3Endpoint,
    region:          options.s3Region,
    accessKeyId:     options.s3AccessKeyId,
    secretAccessKey: options.s3SecretAccessKey,
  })
  console.log(`\x1b[32ms3: syncing to bucket ${options.s3Bucket}\x1b[0m`)
}

if (options.web) {
  const webOptions = {}

  // Optional Web Push. VAPID secrets come from env only (never argv).
  // Subscriptions are stored as a plain JSON file in the data-dir — they
  // hold endpoint URLs + auth secrets and must stay off the public
  // registry. notifyOnMessages walks chat-shaped repos in the registry
  // for new messages; on non-chat deployments it's a no-op watcher.
  // Check first so an env mistake fails fast, before the server starts.
  if (options.enablePush) {
    const vapidPub  = process.env.STREAMO_VAPID_PUBLIC
    const vapidPriv = process.env.STREAMO_VAPID_PRIVATE
    if (!vapidPub || !vapidPriv) {
      console.error('\x1b[31m--enable-push set but STREAMO_VAPID_PUBLIC / STREAMO_VAPID_PRIVATE not in env — refusing to start\x1b[0m')
      process.exit(2)
    }
    const pushStore = new PushStore(join(options.dataDir, 'push-subscriptions.json'))
    const vapid = {
      publicKey: vapidPub,
      privateKey: vapidPriv,
      subject: process.env.STREAMO_VAPID_SUBJECT ?? 'mailto:streamo@streamo.dev'
    }
    webOptions.routes = pushRoutes(pushStore, vapid.publicKey)
    notifyOnMessages(server.registry, pushStore, vapid)
    console.log(`\x1b[32mweb push: enabled (${pushStore.all().length} stored subscription(s))\x1b[0m`)
  }

  // Always serve from the record's value.files when --web is set — the
  // page-as-StreamoRecord shape. No static-file fallback (9.x architectural
  // commitment): paths the home Record doesn't declare via `files` or
  // route via `mounts` return 404. In relay-only mode (--home-key) this
  // lets a bare relay serve a homepage whose bytes arrived via origin sync.
  webOptions.serveRepoFiles = { repo: server.streamo }
  console.log(`\x1b[32mserving from Record: value.files ↔ http://localhost:${+options.web}/\x1b[0m`)

  if (options.hostMap) {
    webOptions.hostMap = options.hostMap
    const count = Object.keys(options.hostMap).length
    console.log(`\x1b[32mhostMap: ${count} host${count === 1 ? '' : 's'} routed to non-primary Records\x1b[0m`)
  }

  await server.web(+options.web, webOptions)
}

if (options.outlet) {
  const port = +options.outlet
  server.outlet(port)
  console.log(`\x1b[32moutlet: listening on port ${port}\x1b[0m`)
}

logInfo(`archive: ${options.dataDir === false ? 'ephemeral (memory only)' : `${options.dataDir}/${publicKeyHex}.bin`} (${streamo.byteLength} bytes loaded)`)
logDebug(() => `options: ${JSON.stringify(options, null, 2)}`)

if (options.interactive || options.replSocket) {
  const get     = (...args) => streamo.get(...args)
  const set     = (...args) => streamo.set(...args)
  const merge   = (source, opts) => streamo.merge(source, opts)
  const ls      = () => [...registry].map(([k, s]) => ({ key: k.slice(0, 8) + '…', bytes: s.byteLength }))
  const connect = (hostPort) => server.connect(hostPort)

  Object.assign(globalThis, {
    // identity
    name, username, publicKeyHex, signer,
    // data
    streamo, registry, record: streamo,
    // shorthands
    get, set, merge, ls,
    // networking
    connect, originSync, outletSync,
    // sync modules
    archiveSync, fileSync, s3Sync,
    // class
    StreamoRecord, StreamoRecordRegistry,
    // substrate verbs
    identity, dispatch,
  })

  const REPL_HEADER = `\x1b[36m
  record / streamo      the primary Record + its underlying Streamo codec
  registry              StreamoRecordRegistry — walk all open Records
  signer                Signer for this identity (has publicKey, keysFor)
  get(...path)          record.get() shorthand
  set(value)            record.set() shorthand
  await merge(src, o)   record.merge() shorthand (fork or pull from another)
  ls()                  registry summary — { key, bytes } per Record
  connect('host:port')  attach this streamo to a remote outlet

  ── substrate verbs ──
  identity.new(name)               fresh signing identity
  dispatch(scope, obj, m?, args?)  safe named-method dispatch
  originSync / outletSync / archiveSync / fileSync / s3Sync   sync modules
  StreamoRecord / StreamoRecordRegistry                       classes\x1b[0m`

  console.log(REPL_HEADER)

  // --interactive: attach REPL to this process's stdin/stdout. Quitting
  // the REPL kills the process (existing behavior).
  if (options.interactive) {
    const replServer = startRepl({ breakEvalOnSigint: true })
    replServer.setupHistory('.node_repl_history', err => {
      if (err) console.error(err)
    })
    replServer.on('exit', process.exit)
  }

  // Each connection gets its own REPL instance; they share globalThis.
  if (options.replSocket) {
    const socketPath = options.replSocket
    const { createServer } = await import('node:net')
    const { unlinkSync } = await import('node:fs')
    try { unlinkSync(socketPath) } catch {}
    const socketServer = createServer(socket => {
      // Sockets have no columns/rows; set defaults so REPL cursor math
      // has something to work with (a proper fix forwards client size).
      socket.columns = 120
      socket.rows = 40
      socket.write(REPL_HEADER + '\n\n')
      const r = startRepl({
        prompt: '> ',
        input: socket,
        output: socket,
        terminal: true,
        breakEvalOnSigint: true,
        // Auto-preview needs save/restore + accurate width; broken over
        // sockets that can't carry SIGWINCH. Tab completion still works.
        preview: false
      })
      r.on('exit', () => socket.end())
      socket.on('error', () => { try { r.close?.() } catch {} })
    })
    socketServer.listen(socketPath, () => {
      console.log(`\x1b[32mREPL socket listening at ${socketPath}\x1b[0m`)
      console.log(`  connect: nc -U ${socketPath}`)
    })
    process.on('exit', () => { try { unlinkSync(socketPath) } catch {} })
  }
}
