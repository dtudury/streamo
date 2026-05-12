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
 * **Already implementing the contract:** `Streamo` and `Repo`. Their
 * existing `streamo.get(...path)` / `streamo.set([address,] ...path,
 * value)` / `streamo.recaller` match the shape directly. Nothing else
 * is needed to pass a Streamo or Repo into a mount() call that wants
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
 * @param {object} target  Plain object to wrap.
 * @param {string} [name='object']  Recaller name (for debug logs).
 * @returns {{recaller: Recaller, get: Function, set: Function, target: object}}
 *
 * @example
 *   const state = liveObject({ count: 0 })
 *   state.get('count')       // 0 (subscribes the current watcher)
 *   state.set('count', 1)    // fires watchers reading 'count'
 *   state.set('a', 'b', 42)  // creates {a: {b: 42}} as needed
 */
export function liveObject (target, name = 'object') {
  const recaller = new Recaller(name)

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
      for (const k of Object.keys(target)) delete target[k]
      Object.assign(target, value)
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
