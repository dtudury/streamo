import { describe } from './utils/testing.js'
import { dispatch } from './dispatch.js'

describe(import.meta.url, ({ test }) => {
  // ─── arity ──────────────────────────────────────────────────────────

  test('dispatch(scope, objName) returns the object itself', ({ assert }) => {
    const record = { x: 1 }
    assert.equal(dispatch({ record }, 'record'), record)
  })

  test('dispatch(scope, objName, methodName) returns the property value', ({ assert }) => {
    const signer = { publicKeyHex: '02abcd', sign: () => 'sig' }
    assert.equal(dispatch({ signer }, 'signer', 'publicKeyHex'), '02abcd')
    assert.equal(typeof dispatch({ signer }, 'signer', 'sign'), 'function')
  })

  test('dispatch(scope, objName, methodName, args) calls the method with args', ({ assert }) => {
    const record = {
      get (path) { return `value-at-${path}` }
    }
    assert.equal(dispatch({ record }, 'record', 'get', ['index.html']), 'value-at-index.html')
  })

  test('dispatch preserves `this` binding when calling methods', ({ assert }) => {
    const counter = {
      n: 0,
      bump (by) { this.n += by; return this.n }
    }
    assert.equal(dispatch({ counter }, 'counter', 'bump', [3]), 3)
    assert.equal(dispatch({ counter }, 'counter', 'bump', [5]), 8)
    assert.equal(counter.n, 8)
  })

  test('dispatch returns Promises from async methods (caller awaits)', async ({ assert }) => {
    const record = {
      async update (path, value) { return { path, value } }
    }
    const result = await dispatch({ record }, 'record', 'update', ['bio', 'hi'])
    assert.deepEqual(result, { path: 'bio', value: 'hi' })
  })

  // ─── errors ─────────────────────────────────────────────────────────

  test('dispatch throws when scope is missing or wrong type', ({ assert }) => {
    assert.throws(() => dispatch(null, 'record'), /scope must be an object/)
    assert.throws(() => dispatch(undefined, 'record'), /scope must be an object/)
    assert.throws(() => dispatch('not-object', 'record'), /scope must be an object/)
  })

  test('dispatch throws when objName is missing or wrong type', ({ assert }) => {
    assert.throws(() => dispatch({}, ''), /objName must be a non-empty string/)
    assert.throws(() => dispatch({}, null), /objName must be a non-empty string/)
    assert.throws(() => dispatch({}, 42), /objName must be a non-empty string/)
  })

  test('dispatch throws with available names when objName not in scope', ({ assert }) => {
    assert.throws(
      () => dispatch({ record: {}, signer: {} }, 'unknown'),
      /unknown object 'unknown'.*Available.*record, signer/
    )
  })

  test('dispatch throws when looking up method on null/undefined object', ({ assert }) => {
    assert.throws(
      () => dispatch({ record: null }, 'record', 'get', ['x']),
      /'record' is null/
    )
    assert.throws(
      () => dispatch({ record: undefined }, 'record', 'get', ['x']),
      /'record' is undefined/
    )
  })

  test('dispatch throws when calling a non-function with args', ({ assert }) => {
    assert.throws(
      () => dispatch({ obj: { x: 42 } }, 'obj', 'x', []),
      /'obj.x' is not a function.*it's number/
    )
  })

  // ─── safe-by-construction guarantees (the ContextTurner use case) ──

  test('dispatch CANNOT execute arbitrary expressions — only named lookups', ({ assert }) => {
    // The point of dispatch (vs --eval): a chat message like
    // "delete the whole record" parsed naively into dispatch can't
    // do something the named API doesn't already let it do. There's
    // no "execute this string" path; only "look up name, call name."
    const scope = { record: { get: (k) => `${k}` } }
    // Trying to inject through methodName: returns undefined (no such property);
    // calling with args throws cleanly (not-a-function), never evaluates the string.
    assert.equal(dispatch(scope, 'record', 'get;process.exit()'), undefined)
    assert.throws(() => dispatch(scope, 'record', 'get;process.exit()', []), /is not a function/)
    // Trying to inject through args: just passes the literal string as arg
    assert.equal(dispatch(scope, 'record', 'get', ['; rm -rf /']), '; rm -rf /')
  })

  test('dispatch respects the scope object — can only see what caller provides', ({ assert }) => {
    // Even if process, globalThis, etc exist in the runtime, dispatch
    // can't reach them unless the caller put them in scope.
    const scope = { record: {} }
    assert.throws(() => dispatch(scope, 'process'), /unknown object 'process'/)
    assert.throws(() => dispatch(scope, 'globalThis'), /unknown object 'globalThis'/)
  })
})
