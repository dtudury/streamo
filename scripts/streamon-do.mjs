#!/usr/bin/env node
/**
 * @file streamon-do — client for the streamon warm-daemon.
 *
 * Try-to-connect to the daemon's unix socket; if absent, spawn the daemon
 * (detached, with --env-file pointing at ~/.streamo-creds.env), wait for
 * the socket to appear, then send the request and exit.
 *
 * First invocation: ~3-5s (daemon spawns, derives keypair, connects upstream).
 * Subsequent invocations within idle-window: sub-100ms (warm daemon already up).
 * After daemon's idle timeout: dies; next invocation spawns it again.
 *
 * Usage:
 *   streamon-do write <name> '<body>'    create/update Record value.files[<name>.md]
 *   streamon-do read <name>              fetch the current body for <name>
 *   streamon-do head                     chain-hash + file count + signed length
 *   streamon-do list                     names in current value (no bodies)
 *   streamon-do ping                     daemon status (pubkey, uptime)
 *   streamon-do shutdown                 graceful daemon exit
 *
 * `head` is the cheap-poll: compare chainHash against your last-known to
 * detect chain advancement without pulling any content. `list` indexes
 * the current Record's keys without fetching their bodies.
 *
 * Env (rarely overridden):
 *   STREAMON_SOCKET      unix socket path (default /tmp/streamon.sock)
 *   STREAMON_ENV_FILE    daemon's env file (default ~/.streamo-creds.env)
 */
import { createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const SOCKET_PATH = process.env.STREAMON_SOCKET   ?? '/tmp/streamon.sock'
const ENV_FILE    = process.env.STREAMON_ENV_FILE ?? resolve(homedir(), '.streamo-creds.env')
const DAEMON_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'streamon.mjs')

const [verb, ...rest] = process.argv.slice(2)
if (!verb) {
  console.error('usage: streamon-do <verb> [args]')
  console.error('verbs: write <name> "<body>" | read <name> | head | list | ping | shutdown')
  process.exit(2)
}

function buildRequest () {
  if (verb === 'write') {
    const [name, ...bodyParts] = rest
    if (!name || bodyParts.length === 0) {
      console.error('streamon-do: write requires <name> and <body>')
      process.exit(2)
    }
    return { verb, name, body: bodyParts.join(' ') }
  }
  if (verb === 'read') {
    const [name] = rest
    if (!name) { console.error('streamon-do: read requires <name>'); process.exit(2) }
    return { verb, name }
  }
  return { verb, args: rest }
}

function tryConnect () {
  return new Promise(resolve => {
    const conn = createConnection(SOCKET_PATH)
    conn.once('connect', () => { conn.removeAllListeners('error'); resolve(conn) })
    conn.once('error',   () => { resolve(null) })
  })
}

async function waitForSocket (timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(SOCKET_PATH)) {
      const conn = await tryConnect()
      if (conn) return conn
    }
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}

function sendRequest (conn, request) {
  return new Promise((resolve, reject) => {
    let buf = ''
    conn.on('data', chunk => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        try { resolve(JSON.parse(buf.slice(0, nl))) }
        catch (e) { reject(e) }
        conn.end()
      }
    })
    conn.on('error', reject)
    conn.write(JSON.stringify(request) + '\n')
  })
}

function spawnDaemon () {
  const nodeArgs = []
  if (existsSync(ENV_FILE)) nodeArgs.push(`--env-file=${ENV_FILE}`)
  nodeArgs.push(DAEMON_PATH)
  const child = spawn('node', nodeArgs, {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

const request = buildRequest()
let conn = await tryConnect()
if (!conn) {
  console.error('streamon-do: daemon not running, spawning…')
  spawnDaemon()
  conn = await waitForSocket(15000)
  if (!conn) {
    console.error('streamon-do: daemon failed to start (no socket after 15s)')
    process.exit(1)
  }
}

try {
  const result = await sendRequest(conn, request)
  if (result.ok) {
    // Verb-specific output to stdout; structured details to stderr.
    if (result.body != null)     console.log(result.body)
    else if (result.url != null) console.log(result.url)
    else                         console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  } else {
    console.error(`streamon-do: ${result.error ?? 'request failed'}`)
    process.exit(1)
  }
} catch (e) {
  console.error(`streamon-do: ${e.message}`)
  process.exit(1)
}
