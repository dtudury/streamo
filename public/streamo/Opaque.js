/**
 * Bytes the codec should store whole rather than decompose.
 *
 * A Uint8Array alone does not say what you meant by it. The default path
 * (UINT8ARRAY) walks bytes into a Duple tree of 4-byte leaves, which makes
 * later edits cheap: appending to a 23KB file costs 80 bytes, because every
 * untouched subtree is reused. Wrapping the same bytes in Opaque says "this is
 * noise — sharing will not pay" and stores one chunk instead of nine thousand.
 *
 * Measured on README.md (23191 bytes):
 *
 *                      stored once     append at end     prepend at start
 *   Duple tree           45799 B            80 B             41400 B
 *   Opaque               23210 B         23220 B             23220 B
 *
 * Same shape as Signature and Duple: a value type the codec matches on, so
 * intent travels inside the structure being encoded rather than as an argument
 * at the call site — which matters because set() encodes a whole tree at once.
 * decode returns an Opaque too, so reading and rewriting cannot silently flip
 * a value back to the other codec.
 */
export class Opaque {
  /** @param {Uint8Array} value */
  constructor (value) {
    if (!(value instanceof Uint8Array)) throw new TypeError('Opaque: expects a Uint8Array')
    this.value = value
  }
}
