#!/usr/bin/env node
/**
 * Append an entry to the relay's own journal — the `entries` array on the
 * server's primary repo (the same one rendered on the homepage).
 *
 * Usage (run on the streamo.dev server, where .env.prod is readable):
 *
 *     cd ~/apps/streamo
 *     set -a; source .env.prod; set +a
 *     node scripts/journal.js "headline" "body"
 *
 * Reads STREAMO_USERNAME / STREAMO_PASSWORD / STREAMO_KEY_ITERATIONS from env
 * (same vars the relay itself uses), so credentials never live in argv or in
 * this repo. Connects to localhost:8080, derives the relay's keypair, opens
 * its own repo, pushes a new entry, waits briefly for chunks to upload, exits.
 *
 * Entry shape matches what public/index.html renders: { at, headline, body }.
 */
import { Signer }       from '../public/streamo/Signer.js'
import { RepoRegistry } from '../public/streamo/RepoRegistry.js'
import { registrySync } from '../public/streamo/registrySync.js'
import { bytesToHex }   from '../public/streamo/utils.js'

const username = process.env.STREAMO_USERNAME
const password = process.env.STREAMO_PASSWORD
const iters    = Number(process.env.STREAMO_KEY_ITERATIONS ?? 100000)
const name     = process.env.STREAMO_NAME ?? 'streamo'
const host     = process.env.STREAMO_JOURNAL_HOST ?? 'localhost'
const port     = Number(process.env.STREAMO_JOURNAL_PORT ?? 8080)

if (!username || !password) {
  console.error('STREAMO_USERNAME and STREAMO_PASSWORD must be set (source .env.prod first).')
  process.exit(1)
}

const [, , headline, body = ''] = process.argv
if (!headline) {
  console.error('Usage: node scripts/journal.js "headline" "body"')
  process.exit(1)
}

const signer = new Signer(username, password, iters)
const { publicKey } = await signer.keysFor(name)
const myKey = bytesToHex(publicKey)

const registry = new RepoRegistry()
const session = await registrySync(registry, host, port, {
  filter: k => k === myKey
})

const myRepo = await registry.open(myKey)
myRepo.attachSigner(signer, name)

const entries = myRepo.get('entries') ?? []
const entry = { at: new Date().toISOString(), headline, body }
myRepo.defaultMessage = `journal: ${headline.slice(0, 60)}`
myRepo.set({ ...myRepo.get(), entries: [...entries, entry] })

// Give the WS a moment to push the new chunks upstream before exiting.
await new Promise(r => setTimeout(r, 1500))
session.close()
console.log(`appended (${entries.length + 1} total): ${headline}`)
process.exit(0)
