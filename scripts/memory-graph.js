#!/usr/bin/env node
// scripts/memory-graph.js — parse the memory corpus and emit the cousin-graph as JSON.
//
// Stage 5 of the federation arc: structure-into-memory. Read-side probe that proves
// the schema by exercising it against real data — before anything migrates to Records.
//
// Two frontmatter shapes have drifted across the corpus:
//   flat:   `type: feedback` + `originSessionId: ...` at top level (older)
//   nested: `metadata: { node_type, type, originSessionId }` (newer)
// Both normalize on read. The sediment principle applies to the schema itself —
// older files keep their shape; the parser meets them where they are.
//
// `[[link]]` is the cousin-edge. It can appear in `description:` OR in the body.
// Resolution: link target is the filename-stem (kebab-case, no .md), NOT the
// `name:` frontmatter field — `name:` has drifted from filename in several places
// and what the corpus actually links to wins.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MEMORY_DIR = '/Users/davidtudury/.claude/projects/-Users-davidtudury-Documents-repos-streamo/memory'

function parseValue(s) {
  s = s.trim()
  if (s.startsWith('"')) {
    let out = ''
    let i = 1
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) {
        out += s[i + 1]
        i += 2
      } else {
        out += s[i]
        i += 1
      }
    }
    return out
  }
  if (s.startsWith("'")) {
    const end = s.lastIndexOf("'")
    return s.slice(1, end)
  }
  return s
}

function parseFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0] !== '---') return { fm: null, body: text }
  const fm = {}
  let i = 1
  let inMetadata = false
  while (i < lines.length && lines[i] !== '---') {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true
      i++
      continue
    }
    if (inMetadata && /^\s+/.test(line)) {
      const m = line.match(/^\s+(\w+):\s*(.*)$/)
      if (m) fm[m[1]] = parseValue(m[2])
    } else {
      inMetadata = false
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (m) fm[m[1]] = parseValue(m[2])
    }
    i++
  }
  const body = lines.slice(i + 1).join('\n')
  return { fm, body }
}

function extractLinks(text) {
  // Strip code blocks and code spans so `[[link]]`-style meta-references about
  // the convention itself don't get counted as real cousin-edges. The corpus
  // uses backticks to distinguish literal-syntax-discussion from invocation.
  const stripped = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
  const out = new Set()
  const re = /\[\[([a-z0-9_-]+)\]\]/g
  let m
  while ((m = re.exec(stripped)) !== null) out.add(m[1])
  return [...out]
}

function parseMemoryFile(stem, content) {
  const { fm, body } = parseFrontmatter(content)
  if (!fm) return { stem, error: 'no frontmatter', bodyLength: content.length, links: [] }
  const linkText = (fm.description ?? '') + '\n' + body
  return {
    stem,
    name: fm.name ?? null,
    description: fm.description ?? null,
    type: fm.type ?? null,
    nodeType: fm.node_type ?? null,
    originSessionId: fm.originSessionId ?? null,
    bodyLength: body.length,
    links: extractLinks(linkText),
  }
}

const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
const memories = files.map(f => {
  const stem = f.slice(0, -3)
  const content = readFileSync(join(MEMORY_DIR, f), 'utf8')
  return parseMemoryFile(stem, content)
})

const inbound = new Map()
for (const m of memories) {
  for (const l of m.links ?? []) {
    if (!inbound.has(l)) inbound.set(l, new Set())
    inbound.get(l).add(m.stem)
  }
}

const stems = new Set(memories.map(m => m.stem))
const annotated = memories.map(m => ({
  ...m,
  inboundLinks: [...(inbound.get(m.stem) ?? [])].sort(),
}))

const orphans = annotated
  .filter(m => (m.links?.length ?? 0) === 0 && m.inboundLinks.length === 0)
  .map(m => m.stem)
  .sort()

const danglingLinks = []
for (const m of annotated) {
  for (const l of m.links ?? []) {
    if (!stems.has(l)) danglingLinks.push({ from: m.stem, to: l })
  }
}

const hubsByDegree = [...annotated]
  .map(m => ({ stem: m.stem, out: m.links?.length ?? 0, in: m.inboundLinks.length, total: (m.links?.length ?? 0) + m.inboundLinks.length }))
  .sort((a, b) => b.total - a.total)
  .slice(0, 12)

console.log(JSON.stringify({
  count: annotated.length,
  hubsByDegree,
  orphans,
  danglingLinks,
  memories: annotated,
}, null, 2))
