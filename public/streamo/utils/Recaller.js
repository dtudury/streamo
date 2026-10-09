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

  get watchCount () {
    return this.#names.size
  }

  get watcherNames () {
    return [...this.#names.values()]
  }

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
    this.#pending.delete(f)
    this.#disassociate(f)
  }

  /** @param {(r: Recaller) => any} predicate @param {{ signal?: AbortSignal, name?: string }} [options] @returns {Promise<void>} */
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
        if (!this.#names.has(f)) continue
        const name = this.#names.get(f)
        this.watch(name, f)
      }
      loops++
    }
    this.#flushing = false
  }
}
