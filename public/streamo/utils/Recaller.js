/**
 * @file Recaller — fine-grained reactive dependency tracker.
 *
 * watch(name, fn) runs fn on a tracking stack; reportKeyAccess(target,
 * key) inside fn registers (target, key) → fn; reportKeyMutation
 * elsewhere wakes any matching watcher on the next microtask. The flush
 * loop is robust against unwatch happening mid-flight, which matters
 * for slot watchers torn down during DOM reconciliation.
 *
 * See design.md §6.
 */
import { NestedSet } from './NestedSet.js'
import { nextTick } from './nextTick.js'

export class Recaller {
  #deps = new NestedSet()
  #names = new Map()
  #stack = []
  #pending = new Set()
  #flushing = false
  loopLimit = 10

  constructor (name) {
    if (!name) throw new Error('Recaller must be named')
    this.name = name
  }

  /**
   * Reactive watchers currently registered on this Recaller. The base
   * leak-detection signal: a sequence of operations (subscribe + unsubscribe,
   * `when` + resolve, etc.) should leave this stable. Growing-without-bound
   * across canonical operations indicates a watcher being registered without
   * a matching `unwatch` somewhere.
   *
   * Read-only. Don't mutate from outside.
   */
  get watchCount () {
    return this.#names.size
  }

  /**
   * Names of currently-registered watchers, in registration order, with
   * duplicates preserved (multiple watchers can share a name — that's
   * conventional, e.g. `fileSync:await-ready-to-author` could be active
   * once per fileSync invocation). Useful for diagnosing *which* watcher
   * isn't being cleaned up when `watchCount` is growing unexpectedly.
   *
   * Read-only snapshot. Don't mutate from outside.
   *
   * @returns {string[]}
   */
  get watcherNames () {
    return [...this.#names.values()]
  }

  /**
   * Call f immediately while tracking any reportKeyAccess calls made during
   * execution. Re-runs f whenever reportKeyMutation is called on a key that
   * was accessed. Each re-run establishes a fresh set of tracked dependencies.
   * @param {string} name
   * @param {function} f
   */
  watch (name, f) {
    if (!name || typeof name !== 'string') throw new Error('please name watches')
    if (typeof f !== 'function') throw new Error(`can only watch functions (${name})`)
    this.#disassociate(f)
    this.#names.set(f, name)
    this.#stack.unshift(f)
    try { f(this) } catch (e) { console.error(e) }
    this.#stack.shift()
  }

  unwatch (f) {
    // Drop f from the pending queue (catches the case where unwatch happens
    // before #flush() starts) and clear its deps/name. The complementary fix
    // in #flush() — checking #names presence per item — handles the harder
    // case where unwatch happens MID-flush, after the batch was snapshotted.
    this.#pending.delete(f)
    this.#disassociate(f)
  }

  /**
   * Promise-shaped wait for a reactive predicate to become truthy.
   *
   * Returns a promise that resolves once `predicate()` returns a truthy
   * value (immediately if already truthy; otherwise on the first
   * reactive re-run that sees it flip). Cancellation via standard
   * `AbortSignal` — abort and the watcher is torn down + the promise
   * rejects with the signal's reason.
   *
   * The hydroplane move on top of the watch+predicate+gate boilerplate
   * (a 25-line dance of watcher setup, fire-on-flip, cleanup, optional
   * timeout). Caller writes intent — *"await readiness"* — and composes
   * with `Promise.race` / `AbortSignal` for timeout / cancellation.
   *
   * @param {(r: Recaller) => any} predicate  reactive predicate function
   *   (any reportKeyAccess inside subscribes the wait to that key)
   * @param {{ signal?: AbortSignal, name?: string }} [options]
   * @returns {Promise<void>}
   */
  when (predicate, { signal, name = 'recaller:when' } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      const fn = () => {
        if (settled) return
        let v
        try { v = predicate(this) } catch (e) { settled = true; this.unwatch(fn); reject(e); return }
        if (v) { settled = true; this.unwatch(fn); resolve() }
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        this.unwatch(fn)
        reject(signal?.reason ?? new Error('aborted'))
      }
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.watch(name, fn)
    })
  }

  reportKeyAccess (target, key) {
    const f = this.#stack[0]
    if (typeof f !== 'function') return
    this.#deps.add(key, target, f)
    this.#deps.add(f, target, key)
  }

  reportKeyMutation (target, key) {
    const triggered = this.#deps.values(key, target)
    if (!triggered.length) return
    triggered.forEach(f => this.#pending.add(f))
    if (this.#flushing) return
    this.#flushing = true
    nextTick(() => this.#flush())
  }

  #disassociate (f) {
    this.#deps.delete(f)
    this.#names.delete(f)
  }

  #flush () {
    let loops = 0
    while (this.#pending.size) {
      if (loops >= this.loopLimit) {
        console.error(`Recaller[${this.name}]: loop limit exceeded`)
        break
      }
      const batch = [...this.#pending]
      this.#pending = new Set()
      for (const f of batch) {
        // Skip watchers unwatched during this flush — e.g. when processing one
        // watcher tears down DOM that contained another watcher's slot anchor.
        // #names is the source of truth for "is this watcher still registered."
        if (!this.#names.has(f)) continue
        const name = this.#names.get(f)
        this.watch(name, f)  // watch() handles its own #disassociate
      }
      loops++
    }
    this.#flushing = false
  }
}
