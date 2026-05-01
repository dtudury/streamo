/**
 * A secp256k1 signature over a range of stream bytes.
 * `address` is the first byte of the signed range.
 * `compactRawBytes` is the 64-byte compact signature.
 */
export class Signature {
  /**
   * @param {number} address
   * @param {Uint8Array} compactRawBytes
   */
  constructor (address, compactRawBytes) {
    this.address = address
    this.compactRawBytes = compactRawBytes
  }
}
