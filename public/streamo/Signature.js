/**
 * A secp256k1 signature over a streamo's chain hash.
 *
 * `chainHash` is the 32-byte hash of the chain at the moment of signing:
 *   chainHash_n = sha256(chainHash_{n-1} || sha256(newBytes))
 * where newBytes is everything appended since the previous SIGNATURE.
 * Two sha256 calls per sig — independent of how many chunks newBytes
 * contains. The chain seed is a 32-byte zero buffer if there is no
 * previous sig.
 *
 * The signature attests to that single 32-byte value, so a stateless
 * relay can verify the next append knowing only the most-recent
 * chainHash — it does not need to retain prior bytes.
 *
 * `compactRawBytes` is the 64-byte compact secp256k1 signature.
 */
export class Signature {
  /**
   * @param {Uint8Array} chainHash         32-byte chain-hash at this sig
   * @param {Uint8Array} compactRawBytes   64-byte compact signature
   */
  constructor (chainHash, compactRawBytes) {
    this.chainHash = chainHash
    this.compactRawBytes = compactRawBytes
  }
}
