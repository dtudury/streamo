/**
 * @file LiveSource — the reactive data source contract.
 *
 * A LiveSource is the minimum interface streamo's UI layer (`h` +
 * `mount`) reaches for when it needs reactive data. The contract:
 *
 *   {
 *     recaller: Recaller,
 *     get(...path): any,
 *     set(...path, value): void
 *   }
 *
 * - `recaller`: the Recaller that mount() and h slots register on.
 *   When the source's data is mutated, the recaller's watchers fire.
 * - `get(...path)`: returns the current value at the given path. Must
 *   call recaller.reportKeyAccess for the segment(s) it reads, so
 *   slots that touched the value re-run when it mutates.
 * - `set(...path, value)`: mutates the value at the given path, then
 *   calls recaller.reportKeyMutation for the affected key(s).
 *
 * **Already implementing the contract:** `Streamo` and `StreamoRecord`. Their
 * existing `streamo.get(...path)` / `streamo.set([address,] ...path,
 * value)` / `streamo.recaller` match the shape directly. Nothing else
 * is needed to pass a Streamo or StreamoRecord into a mount() call that wants
 * a LiveSource.
 *
 * **Wrap anything else:** `liveObject` below for plain objects;
 * `public/apps/location/main.js` for a worked example wrapping
 * `window.location` (with browser-event wiring so the recaller fires
 * on hashchange / popstate).
 *
 * The contract is just a convention — JS has no interfaces to
 * enforce. The convention earns its keep by making "if I read it
 * with the right recaller, I can rely on slots re-running" a thing
 * you can count on, instead of a thing you discover the hard way
 * when a slot mysteriously goes stale.
 */

import { Recaller } from './utils/Recaller.js'

/**
 * Wrap a plain object as a LiveSource. The returned object's
 * `get(...path)` and `set(...path, value)` walk the target by path
 * and report access / mutation on the recaller. The target is
 * mutated in place; `target` is exposed for direct inspection.
 *
 * Pass `{recaller}` to share a recaller across multiple LiveSources
 * (and with the mount() call) — this is usually what app code wants,
 * because cross-recaller subscriptions don't form automatically. If
 * no recaller is passed, a fresh one is created.
 *
 * @param {object} target  Plain object to wrap.
 * @param {({name?: string, recaller?: Recaller})|string} [options]
 *   Options object, or a string treated as `{name: ...}` for legacy
 *   convenience. `name` defaults to `'object'`; `recaller` defaults
 *   to a fresh `new Recaller(name)` if omitted.
 * @returns {{recaller: Recaller, get: Function, set: Function, target: object}}
 *
 * @example
 *   // Fresh recaller per source:
 *   const state = liveObject({ count: 0 })
 *
 *   // Shared recaller across sources + the mount call:
 *   const recaller = new Recaller('app')
 *   const login = liveObject({ in: false }, { recaller, name: 'login' })
 *   const edit  = liveObject({},           { recaller, name: 'edit'  })
 *   mount(h\`…\`, document.body, recaller)
 */
export function liveObject (target, options = {}) {
  if (typeof options === 'string') options = { name: options }
  const { name = 'object', recaller = new Recaller(name) } = options

  function get (...path) {
    if (path.length === 0) {
      recaller.reportKeyAccess(target, '__root__')
      return target
    }
    let parent = target
    for (let i = 0; i < path.length - 1; i++) {
      recaller.reportKeyAccess(parent, path[i])
      if (parent == null || typeof parent !== 'object') return undefined
      parent = parent[path[i]]
    }
    const last = path[path.length - 1]
    if (parent == null || typeof parent !== 'object') return undefined
    recaller.reportKeyAccess(parent, last)
    return parent[last]
  }

  function set (...args) {
    const value = args.pop()
    const path = args
    if (path.length === 0) {
      // Whole-value replacement: clear and copy. We can't replace the
      // `target` reference from inside (callers hold their own
      // reference), so we mutate in place — keys not in `value` are
      // dropped; keys in `value` are written.
      //
      // Fire per-key mutations for every affected key — old keys
      // being dropped + new keys being written — so path-based
      // readers (`get('phase')`) wake just like they would on
      // `set('phase', ...)`. Without this, the two call shapes
      // diverged: whole-value set fired only '__root__', leaving
      // path-readers asleep — a substrate-articulation footgun
      // (caught by David 2026-05-26 via the shared-note login).
      // Plus the '__root__' mutation so whole-object readers
      // (`get()` with no args) wake too.
      const affectedKeys = new Set([...Object.keys(target), ...Object.keys(value)])
      for (const k of Object.keys(target)) delete target[k]
      Object.assign(target, value)
      for (const k of affectedKeys) recaller.reportKeyMutation(target, k)
      recaller.reportKeyMutation(target, '__root__')
      return
    }
    // Walk to the parent of the leaf, creating intermediate objects
    // as needed.
    let parent = target
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]
      if (parent[key] == null || typeof parent[key] !== 'object') {
        parent[key] = {}
      }
      parent = parent[key]
    }
    const leaf = path[path.length - 1]
    parent[leaf] = value
    recaller.reportKeyMutation(parent, leaf)
  }

  return { recaller, get, set, target }
}

/**
 * A single-value LiveSource. Same shape as `liveObject` (recaller +
 * get + set + target), but for values that aren't object-shaped:
 * a number, a string, null, etc. `get()` takes no path; `set(value)`
 * replaces the whole value.
 *
 *   const hover = liveValue(null, { recaller })
 *   hover.get()      // null
 *   hover.set(42)    // fires
 *   hover.get()      // 42
 *
 * Use this when a piece of reactive state is a single primitive (or a
 * whole-object-at-once swap). For finer-grained updates inside an
 * object, use `liveObject` with path-shaped get/set.
 *
 * @param {any} initial         starting value
 * @param {({name?: string, recaller?: Recaller})|string} [options]
 *   Options object (or a string treated as `{name: ...}` for legacy
 *   convenience). `name` defaults to `'value'`; `recaller` defaults
 *   to a fresh `new Recaller(name)` if omitted.
 */
export function liveValue (initial, options = {}) {
  if (typeof options === 'string') options = { name: options }
  const { name = 'value', recaller = new Recaller(name) } = options
  // Wrap in a ref so we can replace the value while keeping a stable
  // target identity for the recaller's (target, key) bookkeeping.
  const ref = { current: initial }
  function get () {
    recaller.reportKeyAccess(ref, 'value')
    return ref.current
  }
  function set (value) {
    ref.current = value
    recaller.reportKeyMutation(ref, 'value')
  }
  return { recaller, get, set, target: ref }
}

/**
 * A reactive clock. `get()` returns `Date.now()` and reports access
 * on the recaller; an internal interval ticks at `tickMs` (default
 * 1 second) and fires a key mutation, causing any slot or watcher
 * that read it to re-run with the fresh time.
 *
 * The canonical worked example of *non-streamo state, wrapped as a
 * LiveSource so the reactive substrate can see it.* Same shape as
 * `apps/location/main.js` does for `window.location` — anything not
 * naturally reactive becomes participating-reactive when wrapped
 * this way.
 *
 * Use cases:
 *  - Live countdowns ("due in 5m 23s", ticking).
 *  - Stale-after-N-seconds UI cues.
 *  - Anything where a slot's correctness depends on elapsed time.
 *
 * `set` is exposed for symmetry but is rarely meaningful — the
 * clock's value is determined externally. Calling `set()` is a no-op
 * by design (we don't pretend to mutate real time).
 *
 *   const time = liveTime({ recaller })
 *   mount(h\`<span>${() => formatRelative(deadline - time.get())}</span>\`, ...)
 *
 * @param {object} [options]
 * @param {Recaller} [options.recaller]  Recaller to share; defaults to a fresh one.
 * @param {string} [options.name='time']
 * @param {number} [options.tickMs=1000]  Tick interval in ms.
 * @returns {{recaller: Recaller, get: () => number, set: () => void, target: object, stop: () => void}}
 */
export function liveTime (options = {}) {
  const { name = 'time', recaller = new Recaller(name), tickMs = 1000 } = options
  const ref = { now: Date.now() }
  const intervalId = setInterval(() => {
    ref.now = Date.now()
    recaller.reportKeyMutation(ref, 'now')
  }, tickMs)
  return {
    recaller,
    get () {
      recaller.reportKeyAccess(ref, 'now')
      return ref.now
    },
    set () { /* no-op: the wall clock isn't ours to set */ },
    target: ref,
    stop () { clearInterval(intervalId) }
  }
}

/**
 * Runtime check: does this value satisfy the LiveSource contract?
 * Structural, not nominal — `Streamo`, `StreamoRecord`, `liveObject` return
 * values, and any custom factory that exposes the shape all pass.
 *
 * @param {any} x
 * @returns {boolean}
 */
export function isLiveSource (x) {
  return x != null &&
    x.recaller instanceof Recaller &&
    typeof x.get === 'function' &&
    typeof x.set === 'function'
}
