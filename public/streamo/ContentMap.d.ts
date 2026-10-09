/**
 * A content-addressable trie mapping Uint8Array → address (number).
 * Two Uint8Arrays with identical bytes will always resolve to the same entry.
 * Lookup and insert are O(n) in the number of matching prefix bits, not O(n²).
 */
export class ContentMap {
    constructor(offset?: number, code?: any, address?: number);
    /**
     * Returns the address stored for this code, or undefined if not found.
     * @param {Uint8Array} code
     * @returns {number|undefined}
     */
    get(code: Uint8Array): number | undefined;
    /**
     * Store a code → address mapping.
     * @param {Uint8Array} code
     * @param {number} address
     */
    set(code: Uint8Array, address: number): any;
    /**
     * Clone the map, including only entries with address ≤ maxAddress.
     * @param {number} maxAddress
     * @returns {ContentMap}
     */
    clone(maxAddress: number): ContentMap;
    #private;
}
