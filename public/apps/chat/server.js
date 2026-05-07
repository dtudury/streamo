#!/usr/bin/env node

import { config } from 'dotenv'
import { StreamoServer } from '../../streamo/StreamoServer.js'

const envFile = process.argv.find((_, i) => process.argv[i - 1] === '--env-file')
if (envFile) config({ path: envFile })

const name       = process.env.STREAMO_NAME             ?? 'chat'
const username   = process.env.STREAMO_USERNAME         ?? 'relay'
const password   = process.env.STREAMO_PASSWORD         ?? ''
const port       = +(process.env.STREAMO_WEB            ?? 8080)
const dataDir    = process.env.STREAMO_DATA_DIR         ?? '.streamo'
const keyIter    = +(process.env.STREAMO_KEY_ITERATIONS ?? 100000)

const server = await StreamoServer.create({ name, username, password, dataDir, keyIterations: keyIter })

console.log(`[chat] room key: ${server.publicKeyHex}`)
console.log(`[chat] serving on http://localhost:${port}/apps/chat/`)

if (!server.streamo.get('members')) {
  server.streamo.set({ ...(server.streamo.get() ?? {}), members: [] })
  console.log('[chat] initialized chat room')
}

await server.web(port, {
  onAnnounce: (key, topic) => {
    if (topic !== server.publicKeyHex) return
    const members = server.streamo.get('members') ?? []
    if (!members.includes(key)) {
      server.streamo.set({ ...(server.streamo.get() ?? {}), members: [...members, key] })
      console.log(`[chat] new member: ${key.slice(0, 12)}…`)
    }
  }
})
