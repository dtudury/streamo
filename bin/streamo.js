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
import { archiveSync } from '../public/streamo/archiveSync.js'
import { fileSync } from '../public/streamo/fileSync.js'
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

  .addOption(
    new Option('--config <path>', 'path to a streamo.json config file. Fields under `identity` (name/username/password/keyIterations/self) and `server` (web/outlet/watch/files/archive/verbose/recordFile) fill in any options not set on the CLI. Relative paths resolve against the config file\'s directory.')
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
    new Option('--watch <url>', 'subscribe to another relay\'s home Record (and its mounted records via the followMounts cascade) and watch for changes. Streamo\'s per-record authority model makes this an asymmetric subscription (each Record has one origin; this flag makes the local relay a subscriber). Can be repeated; each value opens an independent registrySync session. URL shape matches --origin.')
      .env('STREAMO_WATCH')
      .argParser((val, prev = []) => [...prev, val])
      .default([])
  )
  .addOption(
    new Option('--peer <url>', '[DEPRECATED 2026-05-28] alias for --watch. The "peer" name implied a symmetric federation relationship streamo\'s per-record authority model prohibits — every Record has exactly one origin, so a relay is either an origin or a subscriber per-Record, never a peer in the symmetric sense. Use --watch.')
      .env('STREAMO_PEER')
      .argParser((val, prev = []) => [...prev, val])
      .default([])
  )
  .addOption(
    new Option('--interactive', 'start a REPL with streamo, signer, and helpers as globals')
      .env('STREAMO_INTERACTIVE')
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

// Apply post-config defaults — fields the commander option no longer carries
// a default for (because config might want to leave them off / drop them).
// dataDir: false is the explicit no-archive signal; undefined defaults to
// `.streamo`; a string path passes through.
if (options.dataDir === undefined) options.dataDir = '.streamo'

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

  // identity → credentials
  if (cfg.identity && typeof cfg.identity === 'object') {
    opts.name          ??= cfg.identity.name
    opts.username      ??= cfg.identity.username
    opts.password      ??= cfg.identity.password
    opts.keyIterations  =  opts.keyIterations ?? cfg.identity.keyIterations ?? opts.keyIterations
    // `self` is a soft-assert: stored for later check against the
    // derived pubkey. Mismatch (typo'd password, wrong config) refuses
    // to start instead of silently authoring under the wrong key.
    if (cfg.identity.self) opts._expectedSelf = cfg.identity.self
  }

  // server → feature flags
  const s = cfg.server || {}

  // archive:
  //   false           → ephemeral (skip disk writes; cache still works)
  //   string          → dataDir path (relative to config dir)
  //   { dataDir, … }  → object form, dataDir field same shape as string
  //   { mode: 'ephemeral' } → same as false
  if (s.archive === false) {
    opts.dataDir = false   // direct override; the no-disk signal
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

  // watch: merged with any CLI --watch flags (so config can declare base
  // upstream subscriptions and CLI can add more)
  if (s.watch) {
    const watches = Array.isArray(s.watch) ? s.watch : [s.watch]
    opts.watch = [...(opts.watch || []), ...watches]
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
}

if (options.verbose !== undefined) setLogLevel(options.verbose)

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
    dataDir:       options.dataDir,
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
    dataDir:       options.dataDir,
    keyIterations: options.keyIterations,
  })
}

const { name, username, publicKeyHex, signer, streamo, registry } = server

// Soft-assert: if --config declared an expected pubkey (`identity.self`),
// refuse to start when the derived pubkey doesn't match. Catches typo'd
// password / wrong credentials before any bytes get signed under the
// wrong key.
if (options._expectedSelf && options._expectedSelf !== publicKeyHex) {
  console.error(`\x1b[31midentity.self mismatch:\x1b[0m`)
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

// --watch (formerly --peer) subscribes this relay to another relay's
// Records. Each watched host's home Record + mounted records flow down
// into our local registry (via the followMounts cascade). Combined with
// --web's hostMap option, this lets one relay serve content authored on
// another. Repeatable: each --watch opens an independent registrySync
// session. We honor both --watch and --peer (deprecated alias) by
// combining them at use site, so existing callers keep working.
const watchHosts = [...(options.watch || []), ...(options.peer || [])]
if (watchHosts.length > 0) {
  for (const watchUrl of watchHosts) {
    await server.watch(watchUrl)
    console.log(`\x1b[32mwatch: subscribed to ${watchUrl}\x1b[0m`)
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
  await server.files(folder, { recordFile })
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

  await server.web(+options.web, webOptions)
}

if (options.outlet) {
  const port = +options.outlet
  server.outlet(port)
  console.log(`\x1b[32moutlet: listening on port ${port}\x1b[0m`)
}

logInfo(`archive: ${options.dataDir}/${publicKeyHex}.bin (${streamo.byteLength} bytes loaded)`)
logDebug(() => `options: ${JSON.stringify(options, null, 2)}`)

if (options.interactive) {
  const get     = (...args) => streamo.get(...args)
  const set     = (...args) => streamo.set(...args)
  const merge   = (source, opts) => streamo.merge(source, opts)
  const ls      = () => [...registry].map(([k, s]) => ({ key: k.slice(0, 8) + '…', bytes: s.byteLength }))
  const connect = (hostPort) => server.connect(hostPort)

  Object.assign(globalThis, {
    // identity
    name, username, publicKeyHex, signer,
    // data
    streamo, registry,
    // shorthands
    get, set, merge, ls,
    // networking
    connect, originSync, outletSync,
    // sync modules
    archiveSync, fileSync, s3Sync,
    // class
    StreamoRecord, StreamoRecordRegistry,
  })

  console.log(`\x1b[36m
  get(...path)          streamo.get() — read a value by path
  set(value)            streamo.set() — write a value
  await merge(src, opts) streamo.merge() — fork or pull from another Record
                        e.g. await merge('streamo.dev', { from: 'files' })
  ls()                  list all open streamos in the registry
  connect('host:port')  connect this streamo to a remote outlet
  streamo / registry    the live streamo and registry instances
  signer                sign / verify data
  originSync(s,k,h,p)   attach any streamo as an origin
  outletSync(reg,port)  start a new outlet server\x1b[0m`)

  const replServer = startRepl({ breakEvalOnSigint: true })
  replServer.setupHistory('.node_repl_history', err => {
    if (err) console.error(err)
  })
  replServer.on('exit', process.exit)
}
