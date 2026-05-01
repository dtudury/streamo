/**
 * A content-addressable trie mapping Uint8Array → address (number).
 * Two Uint8Arrays with identical bytes will always resolve to the same entry.
 * Lookup and insert are O(n) in the number of matching prefix bits, not O(n²).
 */
export class ContentMap {
  #offset
  #code
  #address
  #branches = []

  constructor (offset = 0, code, address = -1) {
    this.#offset = offset
    this.#code = code
    this.#address = address
  }

  /**
   * Returns the address stored for this code, or undefined if not found.
   * @param {Uint8Array} code
   * @returns {number|undefined}
   */
  get (code) {
    if (this.#code === undefined || this.#address === -1) return undefined
    const { match, matchingBits } = this.#compare(code)
    if (match) return this.#address
    return this.#branches[matchingBits]?.get(code)
  }

  /**
   * Store a code → address mapping.
   * @param {Uint8Array} code
   * @param {number} address
   */
  set (code, address) {
    if (this.#code === undefined || this.#address === -1) {
      this.#code = code
      this.#address = address
      return
    }
    const { match, matchingBits, matchingBytes } = this.#compare(code)
    if (match) throw new Error('code already exists in ContentMap')
    if (this.#branches[matchingBits]) return this.#branches[matchingBits].set(code, address)
    this.#branches[matchingBits] = new ContentMap(matchingBytes, code, address)
  }

  /**
   * Clone the map, including only entries with address ≤ maxAddress.
   * @param {number} maxAddress
   * @returns {ContentMap}
   */
  clone (maxAddress) {
    if (this.#address > maxAddress) throw new Error('clone address is before branch')
    const copy = new ContentMap(this.#offset, this.#code, this.#address)
    for (const i in this.#branches) {
      const branch = this.#branches[i]
      if (branch.#address <= maxAddress) copy.#branches[i] = branch.clone(maxAddress)
    }
    return copy
  }

  #compare (code) {
    const matchingBits = countMatchingBits(code.subarray(this.#offset), this.#code.subarray(this.#offset))
    const matchingBytes = this.#offset + Math.floor(matchingBits / 8)
    const match = matchingBytes === code.length && matchingBytes === this.#code.length
    return { match, matchingBits, matchingBytes }
  }
}

function countMatchingBits (a, b) {
  let bits = 0
  for (let i = 0; i < a.length && i < b.length; i++) {
    let j = 0
    while ((a[i] >> j) !== (b[i] >> j)) j++
    bits += 8 - j
    if (j) break
  }
  return bits
}
