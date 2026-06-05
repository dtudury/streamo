/**
 * @file dispatch — the substrate primitive for "call this object's
 * method with these args" that bridges every surface that wants to
 * invoke the streamo API.
 *
 * Yesterday's discovery (heron, 2026-06-04): if positional CLI just
 * translates to an --eval string inline in bin/streamo.js, then any
 * future surface that wants the same shape (REPL, config files,
 * ContextTurner-as-chat-interface) has to re-implement the translation.
 * Worse: --eval allows arbitrary JS, which is wrong for NL-driven
 * surfaces where you DON'T want chat messages executing arbitrary code.
 *
 * dispatch is the *constrained* surface: only "look up named object,
 * look up named method, call with these args." Strict enough to be
 * safe for NL-parsing-fed surfaces; expressive enough to handle the
 * common cases (record.get, record.update, signer.publicKeyHex,
 * identity.new, registry.size, etc.).
 *
 * Four surfaces, one primitive:
 *
 *   - **CLI** synthesizes the call from positional args
 *     (`streamo record update bio "hello"` → `dispatch(scope, 'record', 'update', ['bio', 'hello'])`)
 *   - **REPL** from interactive input (the user can `dispatch(...)` directly,
 *     or the REPL parses simple `obj method args` lines into dispatch calls)
 *   - **Config files** from declarative entries
 *     (`{ object: 'record', method: 'update', args: ['bio', 'hello'] }`)
 *   - **ContextTurner** from chat-message intent — NL → dispatch
 *     (`"tell the engineer to update her bio"` → parsed → `dispatch(scope, 'record', 'update', ['bio', 'value'])`)
 *
 * Same dispatcher across all four. Neither gets left behind because
 * they all call the same code path. --eval remains the arbitrary-JS
 * escape hatch for power users; dispatch is the safe surface for
 * everything else.
 *
 * See `memory/notes/2026-06-04-late-the-one-command-deploy-landed.md`
 * for the surrounding ContextTurner arc that dispatch unblocks.
 */

/**
 * Look up `objName` in `scope`, then optionally `methodName` on that
 * object, then optionally call it with `args`. Returns the value
 * (or the Promise the method returned).
 *
 * @param {object} scope  the namespace of available objects, e.g.
 *   `{ record, signer, registry, recaller, identity }`. Caller controls
 *   what's in scope; dispatch only walks names within it.
 *
 * @param {string} objName  the object to look up in scope. Throws
 *   with the available names listed if not found.
 *
 * @param {string} [methodName]  optional. If omitted, returns the
 *   object itself (e.g. `dispatch(scope, 'record')` → the record).
 *
 * @param {Array} [args]  optional. If omitted (when methodName is
 *   present), returns the property value (e.g. `dispatch(scope,
 *   'signer', 'publicKeyHex')` → string). If present, calls the
 *   method with `...args` (and returns whatever it returns,
 *   including Promises).
 *
 * @returns {*}  whatever the resolution / call produces. Method
 *   results may be Promises; callers `await` if needed.
 */
export function dispatch (scope, objName, methodName, args) {
  if (!scope || typeof scope !== 'object') {
    throw new TypeError('dispatch: scope must be an object')
  }
  if (!objName || typeof objName !== 'string') {
    throw new TypeError('dispatch: objName must be a non-empty string')
  }
  if (!(objName in scope)) {
    const available = Object.keys(scope).join(', ') || '(empty)'
    throw new Error(`dispatch: unknown object '${objName}'. Available in scope: ${available}`)
  }
  const obj = scope[objName]
  if (methodName === undefined) return obj
  if (obj == null) {
    throw new Error(`dispatch: '${objName}' is ${obj === null ? 'null' : 'undefined'} — can't look up '${methodName}' on it`)
  }
  const value = obj[methodName]
  if (args === undefined) return value
  if (typeof value !== 'function') {
    throw new TypeError(`dispatch: '${objName}.${methodName}' is not a function (it's ${value === null ? 'null' : typeof value}) — can't call with args`)
  }
  return value.apply(obj, args)
}
