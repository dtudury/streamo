import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Every relative import reachable from an entry point, transitively.
// Resolved, not executed — bin/streamo.js prompts for a tty on load, so
// importing it isn't a test; and the bug class here is "module deleted,
// import left behind," which is a resolution failure, not a runtime one.
function unresolvedFrom (entry) {
  const seen = new Set()
  const missing = []
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    if (!existsSync(file)) { missing.push(file); return }
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      walk(resolve(dirname(file), m[1]))
    }
  }
  walk(resolve(root, entry))
  return missing
}

// Regression, twice over: 15.0.0 deleted ContextRecord.js and left
// bin/streamo.js importing it — the binary threw on startup. 15.0.2 fixed
// bin/ and missed index.js, so `import '@dtudury/streamo'` threw for every
// consumer of the published package until 2026-08-01. Same bug, consecutive
// releases, caught by nothing: npm test imported neither entry point, and
// `npm run typecheck` flagged it while being run by no one.
for (const entry of ['index.js', 'bin/streamo.js']) {
  test(`${entry} — every relative import resolves`, () => {
    const missing = unresolvedFrom(entry)
    assert.deepStrictEqual(missing, [],
      `${entry} imports files that don't exist:\n  ${missing.join('\n  ')}`)
  })
}

test('index.js — the published entry point actually imports', async () => {
  const mod = await import('../../index.js')
  assert.ok(Object.keys(mod).length > 0, 'entry point exports nothing')
})
