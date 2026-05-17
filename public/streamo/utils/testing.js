/**
 * Universal test utility for stream/ tests.
 *
 * In Node.js:   wraps node:test describe/test — tests actually execute via `node --test`
 * In browser:   no-op for now; browser test runner to be rebuilt as a stream module
 *
 * Usage in test files:
 *
 *   import { describe, assert } from './utils/testing.js'
 *
 *   describe(import.meta.url, ({ test }) => {
 *     test('my case', () => {
 *       assert.equal(actual, expected)
 *     })
 *     test('async case', async () => {
 *       const result = await someAsyncThing()
 *       assert.ok(result)
 *     })
 *   })
 */

const IS_NODE = typeof process !== 'undefined' && process.versions?.node != null

// ── Assertions ────────────────────────────────────────────────────────────
// Throws on failure, works in any environment.

class AssertionError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AssertionError'
  }
}

function fmt (v) {
  try {
    if (v instanceof Uint8Array) return `Uint8Array[${[...v]}]`
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const assert = {
  ok (val, msg) {
    if (!val) throw new AssertionError(msg ?? `expected truthy, got ${fmt(val)}`)
  },
  equal (actual, expected, msg) {
    if (actual !== expected) throw new AssertionError(msg ?? `${fmt(actual)} !== ${fmt(expected)}`)
  },
  notEqual (actual, expected, msg) {
    if (actual === expected) throw new AssertionError(msg ?? `expected values to differ, both were ${fmt(actual)}`)
  },
  deepEqual (actual, expected, msg) {
    if (fmt(actual) !== fmt(expected)) throw new AssertionError(msg ?? `${fmt(actual)} !== ${fmt(expected)}`)
  },
  throws (fn, msg) {
    let threw = false
    try { fn() } catch { threw = true }
    if (!threw) throw new AssertionError(msg ?? 'expected function to throw')
  },
  async rejects (fn, msg) {
    // Async counterpart to throws — for functions that return a Promise
    // that should reject (e.g. `async` functions that throw inside their
    // body, which become rejections rather than sync throws).
    let threw = false
    try { await fn() } catch { threw = true }
    if (!threw) throw new AssertionError(msg ?? 'expected promise to reject')
  }
}

// ── describe / test ───────────────────────────────────────────────────────

let _impl

if (IS_NODE) {
  const { describe: nodeDescribe, test: nodeTest } = await import('node:test')
  _impl = {
    describe (name, fn) {
      nodeDescribe(name, () => fn({
        test: (testName, testFn) => nodeTest(testName, () => testFn({ assert }))
      }))
    }
  }
} else {
  // Browser test runner: TODO rebuild as a first-class stream module
  _impl = { describe () {} }
}

/**
 * Declare a group of tests. Pass import.meta.url as the name so the
 * test runner can show which file each group came from.
 *
 * @param {string} name  typically import.meta.url
 * @param {function({ test: function }): void} fn
 */
export function describe (name, fn) {
  _impl.describe(name, fn)
}
