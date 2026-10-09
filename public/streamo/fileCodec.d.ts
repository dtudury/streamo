/**
 * Decode file bytes: UTF-8 text → string, binary → Uint8Array.
 * @param {Buffer} bytes
 * @returns {string|Uint8Array}
 */
export function decodeBytes(bytes: Buffer): string | Uint8Array;
/**
 * Decode a file's value for storage: JSON files become parsed objects, JSONL
 * files become arrays of records, everything else stays as-is. Anything that
 * fails to parse stays a string.
 *
 * `.jsonl` only takes the parsed path when the round-trip back through
 * `encodeFile` is provably byte-exact — no trailing newline, a blank line, or
 * an unparseable line all fall through to the string. Structure is worth
 * having but not worth silently rewriting somebody's file to get.
 *
 * @param {string} rel  relative path
 * @param {string|Uint8Array} value
 * @returns {object|Array|string|Uint8Array}
 */
export function decodeFile(rel: string, value: string | Uint8Array): object | any[] | string | Uint8Array;
/**
 * Encode a file value for writing to disk. Strict shape contract:
 *   - `.json` files: value must be a plain object or array → JSON-encoded
 *   - other files:   value must be a string or Uint8Array → written as bytes
 * Any other combination throws. The earlier null-return + silent-skip
 * behavior hid contract violations; throwing surfaces them at the write
 * site where they can be debugged.
 *
 * @param {string} rel
 * @param {any} value
 * @returns {string|Uint8Array}
 */
export function encodeFile(rel: string, value: any): string | Uint8Array;
/**
 * Rough equality check for a files object (handles Uint8Array values).
 * @param {Object} a
 * @param {Object} b
 * @returns {boolean}
 */
export function filesEqual(a: any, b: any): boolean;
