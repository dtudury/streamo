#!/usr/bin/env node
/**
 * @file dev-static — tiny Node static file server for public/.
 *
 * For one-off browser testing of apps that aren't wired into a Record's
 * mounts.json yet. Streamo-native serving (npm run dev) only serves bytes
 * declared via the home Record; this is the dev affordance for "I just
 * want to see the HTML render" without the full mount-and-publish dance.
 *
 * Replaces past-me's instinct of "python3 -m http.server" — that worked,
 * but using a Python tool to serve a Node project is the same family of
 * slip as "reach for CodeMirror when textarea would do." Owning a tiny
 * Node server here keeps the dev path in-ecosystem.
 *
 * Usage:
 *   node scripts/dev-static.mjs               # serves public/ on :8087
 *   node scripts/dev-static.mjs 9000          # serves public/ on :9000
 *   node scripts/dev-static.mjs 9000 ./other  # serves ./other/ on :9000
 *
 * For real Record-mounted serving, use `npm run dev` (the streamo all-in-one).
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'

const port = Number(process.argv[2]) || 8087
const root = resolve(process.argv[3] || 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.json': 'application/json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.ico':  'image/x-icon'
}

createServer(async (req, res) => {
  try {
    let path = join(root, decodeURIComponent(req.url.split('?')[0]))
    const info = await stat(path).catch(() => null)
    if (info?.isDirectory()) path = join(path, 'index.html')
    const data = await readFile(path)
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end(`Not found: ${req.url}`)
  }
}).listen(port, () => {
  console.log(`dev-static: serving ${root} at http://localhost:${port}/`)
})
