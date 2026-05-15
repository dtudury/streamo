#!/usr/bin/env node

import { readFileSync } from 'fs'
import { dirname } from 'path'
import { Option, program } from 'commander'
import { config } from 'dotenv'
import { question, questionNewPassword } from 'readline-sync'
import { start as startRepl } from 'repl'
import { StreamoServer } from '../public/streamo/StreamoServer.js'
import { Repo } from '../public/streamo/Repo.js'
import { RepoRegistry } from '../public/streamo/RepoRegistry.js'
import { archiveSync } from '../public/streamo/archiveSync.js'
import { fileSync } from '../public/streamo/fileSync.js'
import { outletSync } from '../public/streamo/outletSync.js'
import { originSync } from '../public/streamo/originSync.js'
import { s3Sync } from '../public/streamo/s3Sync.js'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))

program
  .name('streamo')
  .description('streamo CLI')
  .version(version)

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
    new Option('--data-dir <path>', 'directory for archive files')
      .env('STREAMO_DATA_DIR')
      .default('.streamo')
  )
  .addOption(
    new Option('--files [path]', 'mirror local files to/from streamo (defaults to current directory)')
      .env('STREAMO_FILES')
      .preset('.')
  )
  .addOption(
    new Option('--files-key <key>', 'mount file sync at repo.value[key] instead of replacing the whole value (preserves sibling state like members/journalists/entries)')
      .env('STREAMO_FILES_KEY')
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
    new Option('--outlet [port]', 'accept inbound WebSocket peer connections')
      .env('STREAMO_OUTLET')
      .preset('1024')
  )
  .addOption(
    new Option('--origin <host:port>', 'connect to a remote outlet')
      .env('STREAMO_ORIGIN')
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
    new Option('--verbose', 'enable verbose logging')
      .env('STREAMO_VERBOSE')
  )

  .parse()

const options = program.opts()

if (options.envFile) {
  config({ path: options.envFile })
  program.parse()
  Object.assign(options, program.opts())
}

options.name     ||= question('Name: ')
options.username ||= question('Username: ')
const password = options.password || questionNewPassword('Password [ATTENTION!: Backspace won\'t work here]: ', { min: 4, max: 999 })

const server = await StreamoServer.create({
  name:          options.name,
  username:      options.username,
  password,
  dataDir:       options.dataDir,
  keyIterations: options.keyIterations,
})

const { name, username, publicKeyHex, signer, streamo, registry } = server

const envDir  = options.envFile ? dirname(options.envFile).replace(/^public\//, '') : null
const appPath = (envDir && envDir !== '.') ? `/${envDir}/` : '/'
const webUrl  = options.web ? `http://localhost:${+options.web}${appPath}` : null
const rows = [
  ['NAME',       name],
  ['USERNAME',   username],
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

if (options.files) {
  const folder = typeof options.files === 'string' ? options.files : '.'
  const filesKey = options.filesKey || null
  await server.files(folder, { filesKey })
  console.log(`\x1b[32mmirroring files: ${folder}${filesKey ? ` (at value.${filesKey})` : ''}\x1b[0m`)
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
  // When the user is mirroring a folder into the streamo, serve those
  // bytes via the repo on the same port — the page-as-Repo shape.
  // Misses fall through to express.static so the streamo lib + bundled
  // apps still work for forks that don't override them.
  if (options.files) {
    webOptions.serveRepoFiles = {
      repo: server.streamo,
      filesKey: options.filesKey || null
    }
    console.log(`\x1b[32mserving from repo: ${options.filesKey ? `value.${options.filesKey}` : 'value'} ↔ http://localhost:${+options.web}/\x1b[0m`)
  }
  await server.web(+options.web, webOptions)
}

if (options.outlet) {
  const port = +options.outlet
  server.outlet(port)
  console.log(`\x1b[32moutlet: listening on port ${port}\x1b[0m`)
}

if (options.origin) {
  await server.connect(options.origin)
  console.log(`\x1b[32morigin: connected to ${options.origin}\x1b[0m`)
}

if (options.verbose) {
  console.log(`archive: ${options.dataDir}/${publicKeyHex}.bin (${streamo.byteLength} bytes loaded)`)
  console.log({ options })
}

if (options.interactive) {
  const get     = (...args) => streamo.get(...args)
  const set     = (...args) => streamo.set(...args)
  const ls      = () => [...registry].map(([k, s]) => ({ key: k.slice(0, 8) + '…', bytes: s.byteLength }))
  const connect = (hostPort) => server.connect(hostPort)

  Object.assign(globalThis, {
    // identity
    name, username, publicKeyHex, signer,
    // data
    streamo, registry,
    // shorthands
    get, set, ls,
    // networking
    connect, originSync, outletSync,
    // sync modules
    archiveSync, fileSync, s3Sync,
    // class
    Repo, RepoRegistry,
  })

  console.log(`\x1b[36m
  get(...path)          streamo.get() — read a value by path
  set(value)            streamo.set() — write a value
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
