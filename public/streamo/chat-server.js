#!/usr/bin/env node
/**
 * streamo chat server
 *
 * Usage:
 *   node public/streamo/chat-server.js [port]
 *
 * Starts an HTTP + WebSocket server.  Auto-accepts any participant that
 * announces their repo key to the root chat topic.
 *
 * The root key is printed on startup — pass it to clients via the
 * /api/chat-info endpoint or by copying it into the config.
 */
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import express from 'express'
import { Signer } from './Signer.js'
import { RepoRegistry } from './RepoRegistry.js'
import { attachStreamSync } from './outletSync.js'
import { bytesToHex } from './utils.js'

const port = Number(process.argv[2] ?? process.env.PORT ?? 8080)
const __dir = dirname(fileURLToPath(import.meta.url))

// Derive a stable, well-known root key for this chat room.
// Using 1 PBKDF2 iteration so startup is instant; this is fine for a demo.
const rootSigner = new Signer('streamo-chat-room', 'streamo-chat', 1)
const { publicKey: rootPubKey } = await rootSigner.keysFor('v1')
const ROOT_KEY = bytesToHex(rootPubKey)

const registry = new RepoRegistry()
const rootRepo = await registry.open(ROOT_KEY)
if (!rootRepo.get('members')) rootRepo.set({ name: 'chat-root', members: [] })

// Auto-accept: when a client announces their key to the root topic, add them.
function onAnnounce (key, topic) {
  if (topic !== ROOT_KEY) return
  const members = rootRepo.get('members') ?? []
  if (!members.includes(key)) {
    rootRepo.set({ name: 'chat-root', members: [...members, key] })
    console.log(`[chat] new member: ${key.slice(0, 12)}…`)
  }
}

const app = express()
app.use(express.static(join(__dir, '../../apps/chat')))
// Also serve public/streamo/ so the browser can import streamo modules
app.use('/streamo', express.static(__dir))
app.get('/api/chat-info', (_req, res) => res.json({ rootKey: ROOT_KEY }))

const server = createServer(app)
const wss = new WebSocketServer({ server })
attachStreamSync(wss, registry, 'chat', { onAnnounce })

server.listen(port, () => {
  console.log(`chat server → http://localhost:${port}`)
  console.log(`root key   → ${ROOT_KEY}`)
})
