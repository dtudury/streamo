import { mkdir, open, readFile, readdir, stat, unlink } from 'fs/promises'
import { join } from 'path'

/**
 * @file StorageTier — byte-blob KV store per-key, with capacity + eviction.
 *
 * Layered substrate for the eviction-tier work (see
 * [[2026-05-31-storage-tier-abstraction-sketch]] for the design).
 * Tiers are *storage-pure*: they hold bytes per key, nothing about
 * stream semantics or chain interpretation. A higher-level adapter
 * (forthcoming `tieredArchiveSync`) bridges Records to tier-lists.
 *
 * The cascade pattern (write → tier 0 → if full, spill to tier 1 → ...)
 * is orchestrated by the caller, not the tier itself; tiers only know
 * how to write/read/evict their own bytes.
 *
 * Three concrete tiers ship in this file:
 *   - StorageTier (abstract base + contract)
 *   - MemoryTier (JS-Map-backed; bytes in RAM; lost on restart)
 *   - DiskTier (one .bin file per key under a directory)
 *
 * Future tiers (S3Tier, etc.) slot in without touching this code —
 * extend StorageTier, implement the contract.
 */

/**
 * Abstract base. Concrete tiers MUST implement the abstract methods.
 * All methods are async-capable; concrete impls may return sync values
 * where I/O isn't needed (MemoryTier mostly does).
 */
export class StorageTier {
  /**
   * Whether this tier has bytes for `key` *right now*.
   * Cheap; MUST NOT trigger expensive I/O.
   * @param {string} key
   * @returns {boolean | Promise<boolean>}
   */
  has (key) { throw new Error('StorageTier.has: abstract') }

  /**
   * Read ALL bytes for `key` from this tier.
   * @param {string} key
   * @returns {Promise<Uint8Array | null>}  null if not present
   */
  read (key) { throw new Error('StorageTier.read: abstract') }

  /**
   * Append `bytes` to `key` in this tier. Creates the key's slot if
   * not present. Caller is responsible for spill-on-capacity decisions
   * (this method does NOT auto-evict; throws if `this.size + bytes.length`
   * would exceed capacity).
   * @param {string} key
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  append (key, bytes) { throw new Error('StorageTier.append: abstract') }

  /**
   * Remove `key`'s bytes from this tier. Returns the bytes so the
   * caller can spill them to a deeper tier (or null if `key` wasn't
   * present).
   * @param {string} key
   * @returns {Promise<Uint8Array | null>}
   */
  evict (key) { throw new Error('StorageTier.evict: abstract') }

  /** Current total bytes stored in this tier. */
  get size () { throw new Error('StorageTier.size: abstract') }

  /** Max bytes this tier will hold. `Infinity` for canonical (terminal) tier. */
  get capacity () { throw new Error('StorageTier.capacity: abstract') }

  /**
   * Pick the next key to evict according to this tier's strategy.
   * Default strategy is LRU (least-recently-accessed); concrete tiers
   * may override. Returns null if no key is eligible.
   * @returns {string | null}
   */
  pickToEvict () { throw new Error('StorageTier.pickToEvict: abstract') }

  /**
   * Mark `key` as accessed. Used by LRU; no-op for FIFO/none.
   * @param {string} key
   */
  recordAccess (key) { throw new Error('StorageTier.recordAccess: abstract') }
}

/**
 * In-memory tier — bytes held in a JS Map.
 * Bytes are lost on process exit; intended for hot cache.
 *
 * Append-correctness: append uses Uint8Array set() to copy into a new
 * combined buffer. Cost is O(N) per append where N is the existing
 * size. For tiny Records (the 10MB cap keeps individuals bounded),
 * this is acceptable. Future optimization: store chunk arrays + flatten
 * on read.
 */
export class MemoryTier extends StorageTier {
  #data = new Map()        // key → Uint8Array
  #lastAccess = new Map()  // key → ms timestamp
  #size = 0
  #capacity

  constructor ({ capacity = Infinity } = {}) {
    super()
    this.#capacity = capacity
  }

  has (key) {
    return this.#data.has(key)
  }

  read (key) {
    if (!this.#data.has(key)) return null
    this.recordAccess(key)
    return this.#data.get(key)
  }

  append (key, bytes) {
    if (this.#size + bytes.length > this.#capacity) {
      throw new Error(`MemoryTier.append: would exceed capacity (${this.#size + bytes.length} > ${this.#capacity})`)
    }
    const existing = this.#data.get(key)
    if (existing) {
      const combined = new Uint8Array(existing.length + bytes.length)
      combined.set(existing, 0)
      combined.set(bytes, existing.length)
      this.#data.set(key, combined)
    } else {
      // Copy `bytes` defensively — caller might mutate. The receive
      // path already slices once (registrySync.js double-copies; see
      // [[eviction-safety]]) but tiers can't assume that.
      this.#data.set(key, new Uint8Array(bytes))
    }
    this.#size += bytes.length
    this.recordAccess(key)
  }

  evict (key) {
    if (!this.#data.has(key)) return null
    const bytes = this.#data.get(key)
    this.#data.delete(key)
    this.#lastAccess.delete(key)
    this.#size -= bytes.length
    return bytes
  }

  get size () { return this.#size }
  get capacity () { return this.#capacity }

  pickToEvict () {
    if (this.#data.size === 0) return null
    let oldestKey = null
    let oldestTime = Infinity
    for (const [k, t] of this.#lastAccess) {
      if (t < oldestTime) {
        oldestTime = t
        oldestKey = k
      }
    }
    return oldestKey
  }

  recordAccess (key) {
    this.#lastAccess.set(key, Date.now())
  }
}

/**
 * Disk tier — one `.bin` file per key under a directory.
 * Mirrors the on-disk layout that archiveSync uses today, so an
 * existing archive directory can be wrapped as a DiskTier without
 * migrating bytes.
 *
 * Maintains an in-memory size cache to avoid stat() on every size read.
 * Cache is populated by `init()` (walks the dir on startup) and
 * incrementally updated on append/evict.
 */
export class DiskTier extends StorageTier {
  #dir
  #capacity
  #sizeByKey = new Map()   // key → bytes on disk
  #lastAccess = new Map()  // key → ms timestamp
  #totalSize = 0
  #initialized = false

  constructor ({ dir, capacity = Infinity }) {
    super()
    if (!dir) throw new Error('DiskTier: `dir` is required')
    this.#dir = dir
    this.#capacity = capacity
  }

  /**
   * Populate size cache from existing files. Call once before use.
   * Idempotent; subsequent calls are no-op.
   */
  async init () {
    if (this.#initialized) return
    await mkdir(this.#dir, { recursive: true })
    try {
      const files = await readdir(this.#dir)
      for (const f of files) {
        if (!f.endsWith('.bin')) continue
        const key = f.slice(0, -4)
        const stats = await stat(join(this.#dir, f))
        this.#sizeByKey.set(key, stats.size)
        this.#totalSize += stats.size
        // Use file mtime as initial last-access; will be overwritten on first real access.
        this.#lastAccess.set(key, stats.mtimeMs)
      }
    } catch (_e) {
      // Dir doesn't exist (or unreadable); we'll create on first append.
    }
    this.#initialized = true
  }

  has (key) {
    return this.#sizeByKey.has(key)
  }

  async read (key) {
    if (!this.#sizeByKey.has(key)) return null
    this.recordAccess(key)
    return new Uint8Array(await readFile(join(this.#dir, `${key}.bin`)))
  }

  async append (key, bytes) {
    if (this.#totalSize + bytes.length > this.#capacity) {
      throw new Error(`DiskTier.append: would exceed capacity (${this.#totalSize + bytes.length} > ${this.#capacity})`)
    }
    await mkdir(this.#dir, { recursive: true })
    const fd = await open(join(this.#dir, `${key}.bin`), 'a')
    try {
      await fd.write(bytes)
    } finally {
      await fd.close()
    }
    const prev = this.#sizeByKey.get(key) ?? 0
    this.#sizeByKey.set(key, prev + bytes.length)
    this.#totalSize += bytes.length
    this.recordAccess(key)
  }

  async evict (key) {
    if (!this.#sizeByKey.has(key)) return null
    const filePath = join(this.#dir, `${key}.bin`)
    const bytes = new Uint8Array(await readFile(filePath))
    await unlink(filePath)
    this.#totalSize -= this.#sizeByKey.get(key)
    this.#sizeByKey.delete(key)
    this.#lastAccess.delete(key)
    return bytes
  }

  get size () { return this.#totalSize }
  get capacity () { return this.#capacity }

  pickToEvict () {
    if (this.#sizeByKey.size === 0) return null
    let oldestKey = null
    let oldestTime = Infinity
    for (const [k, t] of this.#lastAccess) {
      if (t < oldestTime) {
        oldestTime = t
        oldestKey = k
      }
    }
    return oldestKey
  }

  recordAccess (key) {
    this.#lastAccess.set(key, Date.now())
  }
}
