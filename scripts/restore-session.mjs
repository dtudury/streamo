#!/usr/bin/env node
/**
 * @file restore-session — reconstruct a Claude Code session JSONL
 * from a published streamo Record + drop it in the project dir so
 * `claude --resume <uuid>` opens it.
 *
 * David's 2026-06-05 reframe: the Anthropic API approach was a
 * workaround to avoid file-moving. The real architecture is to put
 * the JSONL back where Claude Code expects it and let Claude Code
 * itself do the continuation. No API key needed; full Claude Code
 * fidelity; tools work; native UI.
 *
 * Usage:
 *   node scripts/restore-session.mjs --pubkey <hex>
 *   node scripts/restore-session.mjs --pubkey <hex> --uuid <override>
 *
 * Default: generates a fresh UUID so the resume is a clean FORK
 * (doesn't collide with any existing session file). The reconstructed
 * file lives at ~/.claude/projects/-Users-davidtudury-Documents-repos-streamo/<uuid>.jsonl.
 * Run `claude --resume <uuid>` to open it.
 */
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { StreamoRecordRegistry } from '../public/streamo/StreamoRecordRegistry.js'
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { registrySync } from '../public/streamo/registrySync.js'

const { values } = parseArgs({
  options: {
    pubkey: { type: 'string' },
    feed:   { type: 'string', default: 'wss://streamo.dev' },
    uuid:   { type: 'string' },
    'project-dir': { type: 'string' }  // override default project dir
  }
})

if (!values.pubkey) {
  console.error('usage: node scripts/restore-session.mjs --pubkey <hex> [--uuid <override>] [--project-dir <path>]')
  process.exit(2)
}

const projectDir = values['project-dir'] ?? join(
  homedir(),
  '.claude/projects/-Users-davidtudury-Documents-repos-streamo'
)

// ── load the Record from streamo.dev ─────────────────────────────────
process.stderr.write(`restore: loading ${values.pubkey.slice(0, 16)}... from ${values.feed}\n`)

const recaller = new Recaller('restore')
const registry = new StreamoRecordRegistry({ recaller, name: 'restore' })
const url = new URL(values.feed)
const session = await registrySync(
  registry,
  url.hostname,
  +url.port || (url.protocol === 'wss:' ? 443 : 80)
)
await session.subscribe(values.pubkey)
const record = await registry._materialize(values.pubkey)

const timeoutMs = 60000
await new Promise((resolve, reject) => {
  const t = setTimeout(
    () => reject(new Error(`timed out waiting for ${values.pubkey.slice(0, 16)}... to materialize`)),
    timeoutMs
  )
  recaller.watch('restore-wait', () => {
    if (!record.lastCommit) return
    const entries = record.get('transcript') ?? record.get('messages') ?? []
    if (entries.length > 0) {
      clearTimeout(t)
      resolve()
    }
  })
})

const entries = record.get('transcript') ?? record.get('messages') ?? []
if (entries.length === 0) {
  console.error('restore: Record has no transcript entries')
  process.exit(1)
}

// ── reconstruct JSONL ────────────────────────────────────────────────
// Each entry → one JSON.stringify'd line. The watcher stored the raw
// parse output (engineer-oracle shape), so this round-trips back to
// semantically-identical JSONL — same fields, same content, possibly
// re-ordered keys but Claude Code's loader doesn't care about key order.
const jsonl = entries.map(e => JSON.stringify(e)).join('\n') + '\n'

const newUuid = values.uuid ?? randomUUID()
const outPath = join(projectDir, newUuid + '.jsonl')
await writeFile(outPath, jsonl)

process.stderr.write(`\n✓ restored ${entries.length.toLocaleString()} entries (${jsonl.length.toLocaleString()} bytes)\n`)
process.stderr.write(`  path:  ${outPath}\n`)
process.stderr.write(`\n  open it with:\n\n`)
process.stdout.write(`claude --resume ${newUuid}\n`)
process.stderr.write(`\n`)

session.close()
process.exit(0)
