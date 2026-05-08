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
