import { test } from 'node:test'
import assert from 'node:assert'

// The package's public entry point. Nothing else in the suite imports it,
// which is how 15.0.2 shipped to npm re-exporting two deleted modules —
// `import '@dtudury/streamo'` threw for every consumer. `npm run typecheck`
// caught it; nothing ran typecheck. This test makes the gate the suite.
test('index.js — the published entry point actually imports', async () => {
  const mod = await import('../../index.js')
  assert.ok(Object.keys(mod).length > 0, 'entry point exports nothing')
})
