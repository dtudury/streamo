/**
 * @file Streamo — reactive content-addressable codec.
 *
 * **The shape**: `set(value)` returns an address; `get(address)` returns
 * the value; the same value always encodes to the same address (dedup is
 * automatic). Streamo decomposes JS values into smaller chunks that are
 * reusable across encodings — every nested object/array gets its own
 * address, and parent chunks reference children by address. This is
 * Streamo's defining property: it's a codec where address IS identity.
 *
 * **Reactivity**: a Recaller tracks per-path reads and writes, so a UI
 * watcher that reads `streamo.get('settings', 'theme')` only re-fires when
 * that specific path changes — not on every chunk that lands.
 *
 * **Streamo is identity-blind.** It doesn't sign, verify, track chain
 * state, or hold a signer. Everything signed-chain-related — the
 * `signedLength` / `committedChainHash` bookkeeping, sign(), verify(),
 * makeRelayInboundStream + its reactive flags — lives on StreamoRecord, which
 * extends Streamo and overrides `append` + `valueAddress` to thread the
 * chain through.
 *
 * Exports: Streamo (the class), changedPaths.
 *
 * See design.md §5 — that section and this file header are two views
 * of the same thing. Keep them in sync when either changes.
 *
 * See [[birth-stories]] §"Streamo dedup bug" — the extended story for
 * the compressed rationale in the #valueAddress comment below. Reading
 * both is the encounter the atlas is designed for.
 */
import { Recaller } from './utils/Recaller.js'
import { CodecRegistry } from './CodecRegistry.js'

/**
 * Yield every path where addrA and addrB differ, including the root.
 * Compares by address so unchanged subtrees are skipped in O(1).
 *
 * Uses streamo.asRefs (mutation-impossible) rather than decode(_, true)
 * so the comparison cannot append chunks. Without this, calling
 * changedPaths during Streamo.set could materialize inline children as
 * separate chunks AFTER the new commit, moving valueAddress past the
 * commit and corrupting StreamoRecord.lastCommit.
 *
 * Tradeoff: asRefs returns `undefined` for inline children's addresses,
 * so changedPaths can't see differences that happen entirely inside
 * inline-only subtrees. The parent path still fires, which is enough
 * for any watcher that doesn't read at a depth past where the structure
 * goes inline.
 */
export function * changedPaths (streamo, addrA, addrB, path = []) {
  if (addrA === addrB) return
  yield path
  const refsA = addrA !== undefined ? streamo.asRefs(addrA) : undefined
  const refsB = addrB !== undefined ? streamo.asRefs(addrB) : undefined
  const isPlain = v => v != null && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  const objA = isPlain(refsA)
  const objB = isPlain(refsB)
  if (objA || objB) {
    // Array length is not in Object.keys but watchers may read arr.length
    // and register a dep on [...path, 'length']. Fire that path explicitly
    // so length-watchers see length changes; without this, they only fire
    // when an index they happen to read changes.
    if (Array.isArray(refsA) && Array.isArray(refsB) && refsA.length !== refsB.length) {
      yield [...path, 'length']
    }
    const keys = new Set([...Object.keys(refsA ?? {}), ...Object.keys(refsB ?? {})])
    for (const key of keys) {
      const a = objA ? refsA[key] : undefined
      const b = objB ? refsB[key] : undefined
      if (a !== b) yield * changedPaths(streamo, a, b, [...path, key])
    }
  }
}

/**
 * A Streamo is a reactive, content-addressable codec.
 *
 * It combines:
 *   - CodecRegistry: encode/decode any JS value to/from bytes
 *   - Recaller: fine-grained reactive dependency tracking (watch/get/set)
 *
 * Signing, verification, and chain bookkeeping live on StreamoRecord — Streamo
 * is intentionally identity-blind.
 */
export class Streamo extends CodecRegistry {
  #recaller
  // Address of the current top value. Tracks explicitly so it stays correct
  // even when set() encodes a value whose outermost subcode already exists
  // in the content map (dedup) — in that case super.append() returns the
  // existing address but byteLength doesn't grow. Falling back to
  // byteLength-1 would land on the previous top, NOT on the value just set.
  // -1 means "uninitialized; fall back to byteLength-1 in the getter."
  #valueAddress = -1

  /**
   * @param {{recaller?: Recaller, name?: string}} [options]
   */
  constructor ({ recaller, name = 'Streamo' } = {}) {
    super()
    this.#recaller = recaller ?? new Recaller(name)
  }

  get recaller () { return this.#recaller }

  get byteLength () {
    this.#recaller.reportKeyAccess(this, 'length')
    return super.byteLength
  }

  /**
   * Append code and notify reactive watchers. The new chunk's address
   * becomes valueAddress.
   *
   * @param {Uint8Array} code
   * @returns {number}
   */
  append (code) {
    const address = super.append(code)
    this.#valueAddress = address
    this.#recaller.reportKeyMutation(this, 'length')
    return address
  }

  /**
   * Decode the value at a path within the most-recently-appended value,
   * registering reactive dependencies so watchers re-run on changes.
   *
   * If the first argument is a number it is treated as an explicit address
   * (no dependency registered). Otherwise byteLength is accessed (dependency
   * registered) and all arguments are treated as a path into the decoded value.
   *
   * @param {...(number|string)} args
   * @returns {any}
   */
  get (...args) {
    /** @type {number} */
    let address
    if (typeof args[0] === 'number') {
      address = /** @type {number} */ (args.shift())
    } else {
      address = this.valueAddress
      // 'length': re-run when external bytes arrive (append() fires 'length').
      // path string: re-run when set() mutates this specific path via changedPaths.
      this.#recaller.reportKeyAccess(this, 'length')
      this.#recaller.reportKeyAccess(this, JSON.stringify(args))
    }
    if (address < 0) return undefined
    // Lazy descent — only decode the chunks the path touches. See
    // CodecRegistry.decodeAt's comment for the algorithm + fallback.
    return this.decodeAt(address, ...args)
  }

  /**
   * Encode and append a new value, optionally updating at a path within the
   * current top-level decoded value. Notifies reactive watchers of which paths
   * changed.
   *
   * Signature: set([address,] ...path, value)
   * - If first arg is a number, use it as the base address.
   * - The last argument is always the value to set.
   * - Intermediate arguments are the path to update.
   *
   * @param {...(number|string|any)} args
   * @returns {number} address of the newly appended code
   */
  set (...args) {
    const baseAddress = typeof args[0] === 'number' ? args.shift() : this.valueAddress
    const value = args.pop()
    const path = args

    const prevAddress = super.byteLength > 0 ? this.valueAddress : undefined

    let newAddress
    if (path.length === 0 || baseAddress < 0) {
      // Whole-value set: encode and store, bypassing Streamo.append so 'length'
      // is not fired — changedPaths will emit the right path-level mutations.
      let encodedValue = value
      if (path.length > 0) {
        // Empty streamo with a path: build nested object from path
        let obj = value
        for (let i = path.length - 1; i >= 0; i--) obj = { [path[i]]: obj }
        encodedValue = obj
      }
      // encode returns a Variable; bypass Streamo.append so 'length' is
      // not fired — changedPaths will emit the right path-level mutations.
      const variable = this.encode(encodedValue)
      const bytes = variable.isInline ? variable.bytes : variable.resolve(this)
      newAddress = this.addressOf(bytes) ?? super.append(bytes)
    } else {
      // Path update: navigate via asRefs(materialize=true) to avoid decoding
      // untouched subtrees, then rebuild the changed path bottom-up, reusing
      // sibling addresses.
      const levels = []
      let addr = baseAddress
      for (let i = 0; i < path.length - 1; i++) {
        const refs = this.asRefs(addr, true)
        levels.push({ refs, key: path[i] })
        addr = Array.isArray(refs) ? refs[+path[i]] : refs[path[i]]
      }
      levels.push({ refs: this.asRefs(addr, true), key: path[path.length - 1] })

      // Encode the new leaf value — bypass Streamo.append so 'length'
      // is not fired (changedPaths handles path-level mutations).
      const leafV = this.encode(value)
      const leafBytes = leafV.isInline ? leafV.bytes : leafV.resolve(this)
      let childAddr = this.addressOf(leafBytes) ?? super.append(leafBytes)

      // Rebuild from leaf to root, reusing unchanged siblings by address
      for (let i = levels.length - 1; i >= 0; i--) {
        const { refs, key } = levels[i]
        const newRefs = Array.isArray(refs) ? [...refs] : { ...refs }
        newRefs[Array.isArray(refs) ? +key : key] = childAddr
        const rebuiltV = this.encode(newRefs, true)
        const rebuiltBytes = rebuiltV.isInline ? rebuiltV.bytes : rebuiltV.resolve(this)
        childAddr = this.addressOf(rebuiltBytes) ?? super.append(rebuiltBytes)
      }
      // After the walk-up, childAddr is the address of the new root —
      // possibly an existing address if everything deduplicated.
      newAddress = childAddr
    }

    this.#valueAddress = newAddress
    for (const changed of changedPaths(this, prevAddress, newAddress)) {
      this.#recaller.reportKeyMutation(this, JSON.stringify(changed))
    }
    return newAddress
  }

  /**
   * Navigate a path and return refs (addresses instead of decoded values).
   * With no path, returns root refs. Returns a plain number if the target is
   * a leaf (non-object/array), or undefined if the path doesn't exist.
   *
   * @param {...string} path
   * @returns {Object|number|undefined}
   */
  getRefs (...path) {
    let address = this.valueAddress
    if (address < 0) return undefined
    for (const key of path) {
      const refs = this.asRefs(address)
      if (typeof refs === 'number') return undefined
      address = Array.isArray(refs) ? refs[+key] : refs[key]
      if (address === undefined) return undefined
    }
    return this.asRefs(address)
  }

  /**
   * Like set(), but the last argument is an address (number) rather than a
   * decoded value. Rebuilds only the changed path bottom-up, reusing sibling
   * addresses — same as set() but skips the leaf-encoding step.
   *
   * Requires at least one path key and an existing object at that path.
   *
   * @param {...(string|number)} args  ...path, address
   * @returns {number} address of the newly appended code
   */
  setRefs (...args) {
    /** @type {number} */
    let childAddr = /** @type {number} */ (args.pop())
    const path = args
    const baseAddress = this.valueAddress
    const prevAddress = super.byteLength > 0 ? this.valueAddress : undefined

    const levels = []
    let addr = baseAddress
    for (let i = 0; i < path.length - 1; i++) {
      const refs = this.asRefs(addr, true)
      levels.push({ refs, key: path[i] })
      addr = Array.isArray(refs) ? refs[+path[i]] : refs[path[i]]
    }
    levels.push({ refs: this.asRefs(addr, true), key: path[path.length - 1] })

    for (let i = levels.length - 1; i >= 0; i--) {
      const { refs, key } = levels[i]
      const newRefs = Array.isArray(refs) ? [...refs] : { ...refs }
      newRefs[Array.isArray(refs) ? +key : key] = childAddr
      const rebuiltV = this.encode(newRefs, true)
      const rebuiltBytes = rebuiltV.isInline ? rebuiltV.bytes : rebuiltV.resolve(this)
      childAddr = this.addressOf(rebuiltBytes) ?? super.append(rebuiltBytes)
    }

    // childAddr is the address of the new root — possibly an existing
    // address if the path-update fully deduplicated. Use it directly
    // instead of byteLength-1, which would land on the unchanged tail.
    const newAddress = childAddr
    this.#valueAddress = newAddress
    for (const changed of changedPaths(this, prevAddress, newAddress)) {
      this.#recaller.reportKeyMutation(this, JSON.stringify(changed))
    }
    return newAddress
  }

  /**
   * Snapshot this streamo up to (and including) `address`.
   * The returned Streamo shares no mutable state with the original.
   * @param {number} address
   * @param {{ recaller?: Recaller, name?: string }} [options]
   * @returns {Streamo}
   */
  clone (address, { recaller = this.#recaller, name } = {}) {
    // Returns the same subclass as `this` — clone means clone.
    // Previously hard-coded `new Streamo(...)` regardless of receiver, which
    // served WritableStreamoRecord.checkout's need for a base-Streamo
    // working scratch by accident. That accidental downcast is now
    // explicit in checkout (uses _applyClone into a fresh Streamo
    // directly), so clone gets to be honest about what its name promises.
    return this._applyClone(new this.constructor({ recaller, name }), address)
  }

  /**
   * Address of the most-recently-appended chunk (the "top value"). The
   * explicit pointer is set by set/setRefs/append; if uninitialized (a
   * fresh or cloned streamo), falls back to byteLength-1.
   *
   * Streamo is SIG-blind — if the last chunk happens to be a SIGNATURE,
   * valueAddress points at it. Subclasses (StreamoRecord) that track signed chains
   * override this to walk past trailing SIGs.
   */
  get valueAddress () {
    if (this.#valueAddress >= 0) return this.#valueAddress
    return super.byteLength - 1
  }

  /** @override Also resets the valueAddress pointer. */
  _reset () {
    super._reset()
    this.#valueAddress = -1
  }
}
