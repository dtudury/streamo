/**
 * Byte-array equality (length + element-by-element). Trivially small
 * helper that had been duplicated in 5 files (relayInboundStream,
 * WritableStreamoRecord, registrySync, StreamoRecordSerializer,
 * Draft) until 2026-07-24; consolidated here so a single source of
 * truth exists.
 * @param {Uint8Array | number[]} a
 * @param {Uint8Array | number[]} b
 * @returns {boolean}
 */
export function arraysEqual(a: Uint8Array | number[], b: Uint8Array | number[]): boolean;
/**
 * SHA-256 digest of `bytes`. Returns a 32-byte Uint8Array.
 * Consolidated from local copies in WritableStreamoRecord.js and
 * StreamoRecordSerializer.js on 2026-07-24.
 * @param {Uint8Array<ArrayBuffer>} bytes  narrower than plain `Uint8Array`
 *   (which is `Uint8Array<ArrayBufferLike>`) because WebCrypto's `digest`
 *   refuses a view that might sit on a `SharedArrayBuffer`.
 * @returns {Promise<Uint8Array>}
 */
export function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
/**
 * The streamo chain-hash primitive:
 * `chainHash_n = sha256(chainHash_{n-1} || sha256(newBytes))`
 *
 * Two sha256 calls per link — independent of how many chunks `newBytes`
 * contains. See design.md §5 (Streamo — Signing) for the mechanism.
 *
 * Consolidated from local copies in WritableStreamoRecord.js (sign
 * side) and StreamoRecordSerializer.js (validate side) on 2026-07-24.
 * Any future divergence in these two copies would have been a real
 * silent-error class (validator + signer would disagree on what's
 * valid); the single source of truth eliminates that failure mode.
 *
 * @param {Uint8Array} prev  the previous chainHash (32 zeros for the seed)
 * @param {Uint8Array<ArrayBuffer>} newBytes  the bytes appended since the previous SIG
 * @returns {Promise<Uint8Array>}  the new 32-byte chainHash
 */
export function chainHashOf(prev: Uint8Array, newBytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
/**
 * Encode a Uint8Array as a lowercase hex string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes: Uint8Array): string;
/**
 * Decode a hex string to a Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToBytes(hex: string): Uint8Array;
/**
 * Encode a non-negative integer as a little-endian byte array.
 * The number of bytes needed is the minimum to represent the value.
 * @param {number} n
 * @returns {Uint8Array}
 */
export function numberToVar(n: number): Uint8Array;
/**
 * Decode a little-endian byte array back to a number.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function varToNumber(bytes: Uint8Array): number;
/**
 * @param {number} length
 * @returns {Array.<number>}
 */
export function range(length: number): Array<number>;
/**
 * Parse a host specifier into { host, port, protocol }. Accepts
 *   `ws://host[:port]`, `wss://host[:port]`, or bare `host[:port]`.
 * Bare-spec protocol resolution:
 *   - In a browser (globalThis.location exists), match the page's protocol
 *     (https → wss, http → ws). Matches the SOP the browser would impose
 *     on the WebSocket constructor anyway.
 *   - Outside the browser, port 443 (or unspecified) → wss; else ws.
 *     The unspecified case defaults to wss because TLS-on-443 is the
 *     production shape; ws-on-80 has to be asked for.
 *
 * Single source of truth across registrySync, originSync, and
 * StreamoServer; previously each had its own normalization.
 */
export function parseOrigin(hostPort: any): {
    host: any;
    port: number;
    protocol: string;
};
