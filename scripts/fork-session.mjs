#!/usr/bin/env node
// fork-session.mjs — parse a Claude Code session JSONL, re-emit as a new
// UUID-named file in the same directory, ready for `claude --resume`.
//
// JSON is closed under parse/stringify, so the round-trip is semantically
// lossless. If `claude --resume` accepts the re-emitted file as
// resume-identical, single-storage of parse-output is viable as backup —
// store the parse-output, re-emit on summon, don't preserve raw bytes.
//
// Usage:
//   node scripts/fork-session.mjs <source.jsonl>           # generate UUID
//   node scripts/fork-session.mjs <source.jsonl> <uuid>    # explicit UUID
//
// New file lands in the same directory as the source (where `claude --resume`
// enumerates from). Prints new UUID + a structural round-trip sanity check.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const [,, srcPath, providedUuid] = process.argv
if (!srcPath) {
  console.error('usage: node scripts/fork-session.mjs <source.jsonl> [new-uuid]')
  process.exit(1)
}

const newUuid = providedUuid ?? randomUUID()
const destPath = join(dirname(srcPath), `${newUuid}.jsonl`)
if (existsSync(destPath)) {
  console.error(`destination already exists: ${destPath}`)
  process.exit(1)
}

const lines = readFileSync(srcPath, 'utf8').split('\n').filter(l => l.trim())
const parsed = lines.map(l => JSON.parse(l))
const reemitted = parsed.map(d => JSON.stringify(d)).join('\n') + '\n'
writeFileSync(destPath, reemitted)

// sanity check: re-read and structurally compare
const verifyParsed = readFileSync(destPath, 'utf8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
const structurallyEqual = JSON.stringify(parsed) === JSON.stringify(verifyParsed)

console.log(`forked ${lines.length} lines`)
console.log(`  source: ${srcPath}`)
console.log(`  new:    ${destPath}`)
console.log(`  uuid:   ${newUuid}`)
console.log(`  structural round-trip: ${structurallyEqual ? 'PASS' : 'FAIL'}`)
console.log()
console.log(`next: claude --resume   # then pick ${newUuid.slice(0, 8)}… from the list`)
