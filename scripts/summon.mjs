#!/usr/bin/env node
/**
 * @file summon — load a past-Engineer's context and ask them a question.
 *
 * v0 of ContextTurner (David's reframe, 2026-06-05): **the Engineer
 * becomes queryable across time.** Past-instances of the Engineer
 * (heron, wren, iris, etc.) have their full conversation context
 * preserved — locally as Claude Code JSONL session logs, or on the
 * network as streamo Records (wren's save-points,
 * `[[argo-context-as-record-2026-06-03]]`).
 *
 * When current-me has a question that past-me would have answered
 * immediately — because past-me was DEEP in that arc — we summon
 * past-me by loading their context into a fresh Anthropic API call.
 *
 * Two source modes:
 *
 *   # local JSONL (fastest; for save-points in env/secrets/ or claude project dir)
 *   node scripts/summon.mjs \
 *     --jsonl env/secrets/heron-2026-06-04-evening-post-folderrecord-write.jsonl \
 *     --question "why did you pick the writeMany shape over per-file writes?"
 *
 *   # streamo Record (the network shape — wren's published save-points)
 *   node scripts/summon.mjs \
 *     --pubkey 03d44aeb6b737034cd0cc6ff803a9c5829e51827a78d71b6d03ece2dff7fe5bccf \
 *     --question "what was the franken-fleece moment?"
 *
 * Read-only by default — doesn't extend the past-instance's session.
 * Pass `--commit` to append the new turn back (requires streamo
 * source AND authoring credentials for the original pubkey, which
 * we usually don't have — typically forking to a derived pubkey is
 * the right shape; v0.1 territory).
 *
 * Requires ANTHROPIC_API_KEY in env.
 */
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { ContextRecord } from '../public/streamo/ContextRecord.js'

const { values } = parseArgs({
  options: {
    jsonl:    { type: 'string' },
    pubkey:   { type: 'string' },
    question: { type: 'string' },
    model:    { type: 'string' },
    system:   { type: 'string' },
    feed:     { type: 'string', default: 'wss://streamo.dev' },
    'dry-run': { type: 'boolean', default: false }
  }
})

if (!values.question) {
  console.error('summon: --question is required')
  console.error('usage: node scripts/summon.mjs (--jsonl PATH | --pubkey HEX) --question TEXT [--model NAME] [--system TEXT]')
  process.exit(2)
}
if (!values.jsonl && !values.pubkey) {
  console.error('summon: one of --jsonl or --pubkey is required')
  process.exit(2)
}
if (values.jsonl && values.pubkey) {
  console.error('summon: pass only one of --jsonl or --pubkey')
  process.exit(2)
}

async function loadJsonl (path) {
  const buf = await readFile(path)
  const text = new TextDecoder().decode(buf)
  const lines = text.split('\n').filter(l => l.length > 0)
  const messages = lines.map(l => JSON.parse(l))
  // Stub record — just answers .get('messages').
  return {
    get (key) {
      return key === 'messages' ? messages : undefined
    }
  }
}

async function loadPubkey (pubkey, feed) {
  const { StreamoRecord } = await import('../public/streamo/StreamoRecord.js')
  const { StreamoRecordRegistry } = await import('../public/streamo/StreamoRecordRegistry.js')
  const { Recaller } = await import('../public/streamo/utils/Recaller.js')
  const { registrySync } = await import('../public/streamo/registrySync.js')
  const recaller = new Recaller('summon')
  const registry = new StreamoRecordRegistry({ recaller, name: 'summon' })
  const url = new URL(feed)
  const session = await registrySync(registry, url.hostname, +url.port || (url.protocol === 'wss:' ? 443 : 80))
  await session.subscribe(pubkey)
  const record = await registry._materialize(pubkey)
  // Wait for materialization — generous; large Records take time.
  const timeoutMs = 60000
  await new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timed out waiting for ${pubkey.slice(0, 16)}... to materialize`)),
      timeoutMs
    )
    recaller.watch('summon-wait', () => {
      if (!record.lastCommit) return
      const transcript = record.get('transcript') ?? record.get('messages') ?? []
      if (transcript.length > 0) {
        clearTimeout(t)
        resolve()
      }
    })
  })
  return { record, session }
}

const sourceName = values.jsonl ?? values.pubkey.slice(0, 16) + '...'
process.stderr.write(`summon: loading ${sourceName}\n`)

let sessionToClose = null
let record
if (values.jsonl) {
  record = await loadJsonl(values.jsonl)
} else {
  const result = await loadPubkey(values.pubkey, values.feed)
  record = result.record
  sessionToClose = result.session
}

const ctx = new ContextRecord(record, {
  model: values.model,
  system: values.system
})
const raw = ctx.rawMessages()
const api = ctx.apiMessages()
process.stderr.write(`summon: ${raw.length} raw messages → ${api.length} API messages (after filter+collapse)\n`)

if (values['dry-run']) {
  // Show what would go to the API without firing the call.
  const totalChars = api.reduce((s, m) => s + m.content.length, 0)
  process.stderr.write(`summon: --dry-run — not calling the API\n`)
  process.stderr.write(`summon: would send ${api.length} messages + 1 user question; ~${totalChars.toLocaleString()} content chars\n`)
  if (api.length > 0) {
    const first = api[0]
    const last = api[api.length - 1]
    process.stderr.write(`summon: first message — ${first.role}: "${first.content.slice(0, 60)}..."\n`)
    process.stderr.write(`summon: last message  — ${last.role}: "${last.content.slice(0, 60)}..."\n`)
  }
  process.stderr.write(`summon: would append user question: "${values.question.slice(0, 80)}..."\n`)
  if (sessionToClose) sessionToClose.close()
  process.exit(0)
}

process.stderr.write(`summon: asking past-instance...\n\n`)

const t0 = Date.now()
const { text, raw: response } = await ctx.chat(values.question)
const ms = Date.now() - t0

process.stdout.write(text)
process.stdout.write('\n')

process.stderr.write(`\nsummon: ${response.usage.input_tokens.toLocaleString()} input tokens, ${response.usage.output_tokens.toLocaleString()} output tokens, ${ms.toLocaleString()}ms\n`)

if (sessionToClose) sessionToClose.close()
process.exit(0)
