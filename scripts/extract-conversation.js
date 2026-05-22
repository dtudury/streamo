#!/usr/bin/env node
/**
 * scripts/extract-conversation.js
 *
 * Extracts the user<->Claude dialogue from this project's Claude Code session
 * transcripts (~/.claude/projects/<project>/*.jsonl) into conversations/ as
 * one Markdown file per local day — the *talking parts only*. Tool calls,
 * tool results, thinking blocks, hook attachments, and injected
 * <system-reminder>/<command-*> noise are all stripped.
 *
 * Workflow: regenerate at session end; read the most recent 1-3 day files at
 * warmup to reconstruct prior-conversation texture. See the memory note
 * reference_conversation_logs.md.
 *
 * The conversations/ output holds private dialogue and is gitignored — it must
 * never reach the public GitHub repo.
 */

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PROJECT_DIR = join(
  homedir(), '.claude', 'projects',
  '-Users-davidtudury-Documents-repos-streamo'
)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'conversations')
const TZ = 'America/Los_Angeles'

const dayOf = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ })
const timeOf = iso =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false })

// Pull human-readable text out of a message.content (string or block array).
const textOf = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n\n')
  }
  return ''
}

const isToolResult = content =>
  Array.isArray(content) && content.some(b => b && b.type === 'tool_result')

// Strip the harness-injected wrappers so only what David actually typed remains.
const cleanUser = raw => {
  const cmd = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)
  const t = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .trim()
  if (!t && cmd) return `_(ran ${cmd[1].trim()})_`
  return t
}

async function main () {
  const files = (await readdir(PROJECT_DIR)).filter(f => f.endsWith('.jsonl'))
  const seen = new Set()
  const turns = []

  for (const file of files) {
    const session = file.replace('.jsonl', '').slice(0, 8)
    const raw = await readFile(join(PROJECT_DIR, file), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.isSidechain || rec.isMeta) continue       // subagent / meta noise
      if (!rec.message || !rec.timestamp) continue       // hook attachments
      if (rec.uuid && seen.has(rec.uuid)) continue       // resumed-session dupes
      if (rec.uuid) seen.add(rec.uuid)

      const { role, content } = rec.message
      if (rec.type === 'user' || role === 'user') {
        if (isToolResult(content)) continue
        const text = cleanUser(textOf(content))
        if (text) turns.push({ ts: rec.timestamp, role: 'David', text, session })
      } else if (rec.type === 'assistant' || role === 'assistant') {
        const text = textOf(content).trim()
        if (text) turns.push({ ts: rec.timestamp, role: 'Claude', text, session })
      }
    }
  }

  turns.sort((a, b) => a.ts.localeCompare(b.ts))

  const byDay = new Map()
  for (const turn of turns) {
    const day = dayOf(turn.ts)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(turn)
  }

  await mkdir(OUT_DIR, { recursive: true })
  for (const [day, dayTurns] of byDay) {
    const lines = [`# ${day}`, '']
    let lastSession = null
    for (const turn of dayTurns) {
      if (turn.session !== lastSession) {
        lines.push('---', '', `### session ${turn.session}`, '')
        lastSession = turn.session
      }
      lines.push(`**${turn.role}** · ${timeOf(turn.ts)}`, '', turn.text, '')
    }
    await writeFile(join(OUT_DIR, `${day}.md`), lines.join('\n'))
  }

  console.log(
    `extracted ${turns.length} turns across ${byDay.size} days -> conversations/`
  )
}

main().catch(err => { console.error(err); process.exit(1) })
