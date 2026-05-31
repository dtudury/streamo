/**
 * @file Cascade — walks a tier list with eviction/spill semantics.
 *
 * Wraps a `StorageTier[]` (hottest to coldest, last tier canonical) and
 * provides write/read/evict that coordinate across tiers. See
 * [[2026-05-31-storage-tier-abstraction-sketch]] for the design intent
 * and the literature on **hierarchical storage management** (Hennessy &
 * Patterson on memory hierarchy; LSM trees for write-heavy variants).
 *
 * Specific design choices (vs alternatives in the literature):
 *   - **Exclusive cascade**: each key lives in exactly one tier at a
 *     time (excluding the brief mid-promotion window). Not *inclusive*
 *     (where higher tiers cache copies of lower-tier data).
 *   - **Write-back with eager pre-spill**: writes hit tier 0; if tier 0
 *     would overflow, evict from tier 0 BEFORE the new append (eager,
 *     not lazy). Cascade spills evicted bytes to tier 1, recursing.
 *   - **Per-tier LRU**: each tier picks its own victim via
 *     `pickToEvict()`. Strategy is tier-local; could differ per tier.
 *   - **Read-promote optional**: configurable. Default on — promotes
 *     accessed bytes to tier 0. Cost: each read potentially triggers a
 *     small cascade. Benefit: hot data stays hot without manual hinting.
 *
 * NOT addressed in v1 (deferred per design sketch):
 *   - Concurrent access safety (single-author Records, low contention
 *     assumed — JS async-await gives no atomicity across awaits)
 *   - Partial-write recovery after crash mid-cascade
 *   - Bloom filters / per-key location index for O(1) read-tier-lookup
 *     (currently O(tiers) walk on read miss)
 *   - Write-rate measurement / backpressure
 */
export class Cascade {
  #tiers
  #readPromote

  /**
   * @param {object} options
   * @param {import('./StorageTier.js').StorageTier[]} options.tiers
   *   Ordered hottest-to-coldest. Last tier should have `Infinity`
   *   capacity (canonical); we don't enforce this but eviction from
   *   the last tier means bytes are dropped from the system.
   * @param {boolean} [options.readPromote=true] Whether reads promote
   *   bytes back to tier 0 (LRU-style hot-data-stays-hot).
   */
  constructor ({ tiers, readPromote = true }) {
    if (!tiers || tiers.length === 0) {
      throw new Error('Cascade: at least one tier required')
    }
    this.#tiers = tiers
    this.#readPromote = readPromote
  }

  /**
   * Write `bytes` for `key` to tier 0. If tier 0 would overflow,
   * evict-and-spill BEFORE appending. Cascades down as needed.
   *
   * Throws if `bytes.length > tier.capacity` for the SMALLEST tier (no
   * room for it anywhere in the front). Callers should respect the
   * per-Record cap (10MB) to avoid this.
   */
  async write (key, bytes) {
    await this.#makeRoomIn(0, bytes.length)
    await this.#tiers[0].append(key, bytes)
  }

  /**
   * Ensure tier `tierIndex` has at least `needed` bytes of headroom.
   * If not, evict from this tier and spill to the next, recursing as
   * needed. If we hit a tier with no eviction candidate (empty + still
   * over), give up — append will throw at the caller.
   */
  async #makeRoomIn (tierIndex, needed) {
    const tier = this.#tiers[tierIndex]
    while (tier.size + needed > tier.capacity) {
      const victimKey = tier.pickToEvict()
      if (victimKey == null) return  // nothing to evict; caller will throw
      const victimBytes = await tier.evict(victimKey)
      if (victimBytes == null) continue  // race: gone already
      await this.#spillDown(tierIndex, victimKey, victimBytes)
    }
  }

  /**
   * Move evicted bytes from tier `fromIndex` to the next tier down.
   * Makes room in the destination tier first (recursive cascade).
   * If `fromIndex` is the last tier, bytes are dropped.
   */
  async #spillDown (fromIndex, key, bytes) {
    const nextIndex = fromIndex + 1
    if (nextIndex >= this.#tiers.length) return  // dropped — canonical reached
    await this.#makeRoomIn(nextIndex, bytes.length)
    await this.#tiers[nextIndex].append(key, bytes)
  }

  /**
   * Read all bytes for `key`. Walks tiers hot-to-cold; first hit wins.
   * If `readPromote`, the bytes get moved to tier 0 (eviction-cascade
   * happens to make room). Returns null if no tier has the key.
   */
  async read (key) {
    for (let i = 0; i < this.#tiers.length; i++) {
      const tier = this.#tiers[i]
      if (!tier.has(key)) continue
      const bytes = await tier.read(key)
      if (bytes == null) continue  // race: gone since we checked
      if (this.#readPromote && i > 0) {
        await this.#promoteToHot(key, bytes, i)
      }
      return bytes
    }
    return null
  }

  /**
   * Move `key`'s bytes from tier `fromIndex` up to tier 0.
   * Implementation: evict from source, then write to tier 0 (which
   * handles its own eviction cascade if full).
   */
  async #promoteToHot (key, bytes, fromIndex) {
    await this.#tiers[fromIndex].evict(key)
    await this.write(key, bytes)
  }

  /**
   * Remove `key` from the system entirely (no spill; bytes dropped).
   * Walks all tiers and evicts wherever it's found. With the exclusive
   * invariant, only one tier should have it — but we walk all defensively.
   * @returns {Promise<Uint8Array | null>}  The bytes removed (from the
   *   first tier they were found in), or null if not present anywhere.
   */
  async remove (key) {
    let removed = null
    for (const tier of this.#tiers) {
      if (!tier.has(key)) continue
      const bytes = await tier.evict(key)
      if (removed === null) removed = bytes
    }
    return removed
  }

  /** Check if any tier has `key`. */
  async has (key) {
    for (const tier of this.#tiers) {
      if (tier.has(key)) return true
    }
    return false
  }

  /** Total bytes across all tiers. */
  get size () {
    return this.#tiers.reduce((sum, t) => sum + t.size, 0)
  }

  /** Per-tier sizes — useful for introspection and tests. */
  get sizesByTier () {
    return this.#tiers.map(t => t.size)
  }

  /** Number of tiers in the cascade. */
  get depth () {
    return this.#tiers.length
  }

  /**
   * The tier list (shallow getter — same array reference). Callers that
   * need to init disk tiers before use (DiskTier.init() walks the dir to
   * populate the size cache) iterate this getter. Mutating the returned
   * array is undefined behavior; treat as read-only.
   */
  get tiers () {
    return this.#tiers
  }
}
