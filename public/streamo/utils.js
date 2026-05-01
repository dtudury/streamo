/**
 * Encode a Uint8Array as a lowercase hex string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex (bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Decode a hex string to a Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToBytes (hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/**
 * Encode a non-negative integer as a little-endian byte array.
 * The number of bytes needed is the minimum to represent the value.
 * @param {number} n
 * @returns {Uint8Array}
 */
export function numberToVar (n) {
  if (n < 0) throw new Error('n must be non-negative')
  if (!n) return new Uint8Array([0])
  const bytes = []
  while (n) {
    bytes.push(n & 0xff)
    n >>>= 8
  }
  return new Uint8Array(bytes)
}

/**
 * Decode a little-endian byte array back to a number.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function varToNumber (bytes) {
  let n = 0
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n * 256 + bytes[i]) >>> 0
  }
  return n
}

/**
 * @param {number} length
 * @returns {Array.<number>}
 */
export function range (length) {
  return Array.from({ length }, (_, i) => i)
}
