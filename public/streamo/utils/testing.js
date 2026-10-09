
const IS_NODE = typeof process !== 'undefined' && process.versions?.node != null

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
    let threw = false
    try { await fn() } catch { threw = true }
    if (!threw) throw new AssertionError(msg ?? 'expected promise to reject')
  }
}

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
  _impl = { describe () {} }
}

export function describe (name, fn) {
  _impl.describe(name, fn)
}
