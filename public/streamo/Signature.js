/**
 * A secp256k1 signature over a streamo's running accumulator.
 *
 * `accumulator` is the 32-byte hash-chain value at the moment of signing:
 *   accumulator_n = sha256(accumulator_{n-1} || sha256(chunk_n))
 * folded over every chunk appended since the previous SIGNATURE (or from
 * a 32-byte zero seed if there is none).
 *
 * The signature attests to that single 32-byte value, so a stateless
 * relay can verify the next append knowing only the most-recent
 * accumulator — it does not need to retain prior bytes.
 *
 * `compactRawBytes` is the 64-byte compact secp256k1 signature.
 */
export class Signature {
  /**
   * @param {Uint8Array} accumulator       32-byte hash-chain value
   * @param {Uint8Array} compactRawBytes   64-byte compact signature
   */
  constructor (accumulator, compactRawBytes) {
    this.accumulator = accumulator
    this.compactRawBytes = compactRawBytes
  }
}
