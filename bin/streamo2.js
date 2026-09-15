#!/usr/bin/env node
import { parseArgs } from 'node:util'

import { WebSocketServer } from 'ws'

import { Recaller } from '../public/streamo/utils/Recaller.js'
import { Signer } from '../public/streamo/Signer.js'
import { bytesToHex } from '../public/streamo/utils.js'
import { Hub } from '../public/streamo/v2/Hub.js'
import { Downstream } from '../public/streamo/v2/Downstream.js'
import { fileSync2 } from '../public/streamo/v2/fileSync2.js'
import { wsConnection } from '../public/streamo/v2/wsConnection.js'

const UPSTREAM_KINDS = ['folder']
const DOWNSTREAM_KINDS = ['listen']

const fail = message => {
  console.error(`streamo2: ${message}`)
  process.exit(1)
}

const kindAndValue = (arg, known) => {
  const colon = arg.indexOf(':')
  if (colon < 1) fail(`expected kind:value, got "${arg}"`)
  const kind = arg.slice(0, colon)
  if (!known.includes(kind)) fail(`unknown kind "${kind}" in "${arg}" (known: ${known.join(', ')})`)
  return { kind, value: arg.slice(colon + 1) }
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

if (values['env-file']) process.loadEnvFile(values['env-file'])
const { STREAMO_NAME: name, STREAMO_USERNAME: username, STREAMO_PASSWORD: password, STREAMO_KEY_ITERATIONS: iterations = '100000' } = process.env
if (!name || !username || password == null) fail('identity needs STREAMO_NAME, STREAMO_USERNAME and STREAMO_PASSWORD (try --env-file)')

const signer = new Signer(username, password, Number(iterations))
const rootKey = bytesToHex((await signer.keysFor(name)).publicKey)
const hub = new Hub({ recaller: new Recaller(`streamo2:${name}`) })

if (upstream.kind === 'folder') {
  await fileSync2({ hub, rootKey, folder: upstream.value, signer, signerName: name, upstream: true })
}

for (const downstream of downstreams) {
  if (downstream.kind === 'listen') {
    const server = new WebSocketServer({ port: Number(downstream.value) })
    // eslint-disable-next-line no-new
    server.on('connection', ws => { new Downstream({ hub, connection: wsConnection(ws) }) })
    await new Promise(resolve => server.once('listening', resolve))
  }
}

console.log(`streamo2: ${rootKey}`)
console.log(`streamo2:   upstream   ${upstreams[0]}`)
for (const arg of values.downstream ?? []) console.log(`streamo2:   downstream ${arg}`)
