#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { start as startRepl } from 'node:repl'
import { parseArgs } from 'node:util'

import { WebSocketServer } from 'ws'

import { Recaller } from '../public/streamo/utils/Recaller.js'
import { Signer } from '../public/streamo/Signer.js'
import { bytesToHex, parseOrigin } from '../public/streamo/utils.js'
import { Hub } from '../public/streamo/v2/Hub.js'
import { Downstream } from '../public/streamo/v2/Downstream.js'
import { Upstream } from '../public/streamo/v2/Upstream.js'
import { fileSync2 } from '../public/streamo/v2/fileSync2.js'
import { connectWs, wsConnection } from '../public/streamo/v2/wsConnection.js'

const UPSTREAM_KINDS = ['folder', 'websocket']
const DOWNSTREAM_KINDS = ['websocket', 'repl']
const NEEDS_VALUE = ['folder', 'websocket']
const isPort = value => /^\d+$/.test(value)

const fail = message => {
  console.error(`streamo2: ${message}`)
  process.exit(1)
}

const kindAndValue = (arg, known) => {
  const colon = arg.indexOf(':')
  const kind = colon === -1 ? arg : arg.slice(0, colon)
  const value = colon === -1 ? '' : arg.slice(colon + 1)
  if (!known.includes(kind)) fail(`unknown kind "${kind}" in "${arg}" (known: ${known.join(', ')})`)
  if (NEEDS_VALUE.includes(kind) && !value) fail(`"${kind}" needs a value, like ${kind}:${kind === 'folder' ? './path' : '1024'}`)
  return { kind, value }
}

const { values } = parseArgs({
  options: {
    upstream: { type: 'string', multiple: true },
    downstream: { type: 'string', multiple: true },
    'env-file': { type: 'string' }
  }
})

const upstreams = values.upstream ?? []
if (upstreams.length !== 1) fail(`needs exactly one --upstream, got ${upstreams.length}`)
const upstream = kindAndValue(upstreams[0], UPSTREAM_KINDS)
const downstreams = (values.downstream ?? []).map(arg => kindAndValue(arg, DOWNSTREAM_KINDS))
if (downstreams.filter(d => d.kind === 'repl').length > 1) fail('at most one repl downstream — there is only one stdin')
if (upstream.kind === 'websocket' && isPort(upstream.value)) fail(`upstream websocket:${upstream.value} would accept canon pushed to us — not built yet; give a host or URL to dial`)
for (const d of downstreams) {
  if (d.kind === 'websocket' && !isPort(d.value)) fail(`downstream websocket:${d.value} would dial out to publish — not built yet; give a bare port to listen`)
}

if (values['env-file']) process.loadEnvFile(values['env-file'])
const { STREAMO_NAME: name, STREAMO_USERNAME: username, STREAMO_PASSWORD: password, STREAMO_KEY_ITERATIONS: iterations = '100000' } = process.env
if (!name || !username || password == null) fail('identity needs STREAMO_NAME, STREAMO_USERNAME and STREAMO_PASSWORD (try --env-file)')

const signer = new Signer(username, password, Number(iterations))
const rootKey = bytesToHex((await signer.keysFor(name)).publicKey)
const recaller = new Recaller(`streamo2:${name}`)

let hub
if (upstream.kind === 'folder') {
  hub = new Hub({ recaller })
  await fileSync2({ hub, rootKey, folder: upstream.value, signer, signerName: name, upstream: true })
} else {
  const { host, port, protocol } = parseOrigin(upstream.value)
  const link = new Upstream({ recaller, connection: await connectWs(`${protocol}://${host}:${port}`) })
  hub = link.hub
  hub.getMirror(rootKey)
}

for (const downstream of downstreams) {
  if (downstream.kind === 'websocket') {
    const server = new WebSocketServer({ port: Number(downstream.value) })
    // eslint-disable-next-line no-new
    server.on('connection', ws => { new Downstream({ hub, connection: wsConnection(ws) }) })
    await new Promise(resolve => server.once('listening', resolve))
  }
}

console.log(`streamo2: ${rootKey}`)
console.log(`streamo2:   upstream   ${upstreams[0]}`)
for (const arg of values.downstream ?? []) console.log(`streamo2:   downstream ${arg}`)

const repl = downstreams.find(d => d.kind === 'repl')
if (repl) {
  const history = repl.value || join(homedir(), '.node_repl_history')
  const server = startRepl({ prompt: 'streamo2> ', breakEvalOnSigint: true })
  server.setupHistory(history, err => { if (err) console.error(`streamo2: repl history: ${err.message}`) })
  Object.assign(server.context, {
    hub,
    key: rootKey,
    name,
    signer,
    get: (...path) => hub.getMirror(rootKey).get(...path),
    keys: () => [...hub.keys()]
  })
  server.on('exit', () => process.exit(0))
}
