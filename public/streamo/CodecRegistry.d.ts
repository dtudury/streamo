/**
 * Extends Addressifier with a codec system.
 *
 * Each stored value is a Uint8Array whose last byte (the footer) identifies
 * its codec. Footers are assigned sequentially as codecs are registered.
 * Multi-part codecs multiply their option counts to produce a footer range
 * (mixed-radix offset from baseFooter).
 *
 * Codecs are built by makeCodecs() in codecs.js and wired in here. Each
 * codec's encode/decode takes `r` as a leading argument; this class
 * builds two `r` flavors and dispatches the right one per entry point.
 */
export class CodecRegistry extends Addressifier {
    /** @type {Array} footer → codec */
    footerToCodec: any[];
    /**
     * Decode any JS value from a code (Uint8Array) or an address (number).
     * @param {Uint8Array|number} codeOrAddress
     * @param {boolean|boolean[]} [asRefs=false]
     * @returns {any}
     */
    decode(codeOrAddress: Uint8Array | number, asRefs?: boolean | boolean[]): any;
    encode(value: any, asRefs: any): number;
    /**
     * Return the immediate children of the value at `address` as addresses
     * rather than decoded values:
     *   Object → { key: valueAddress }  (names stay as strings)
     *   Array  → [ addr0, addr1, … ]
     *   Other  → address itself
     *
     * Useful for structural comparison without fully deserialising large trees.
     *
     * Every part is an address, so this never has to store anything to answer.
     * It took a `materialize` flag until 2026-10-06: an inline child had no
     * separate address, and the only way to hand one back was to append it
     * mid-read. With inline parts gone both arms of that branch had become the
     * same expression, so the flag was deciding nothing.
     *
     * @param {number} address
     * @returns {Object|Array|number}
     */
    asRefs(address: number): any | any[] | number;
    /**
     * Decode the value at `address`, descending lazily into composite children
     * along `path`. Only the chunks the path actually touches are decoded;
     * sibling subtrees are skipped entirely. O(depth) instead of O(record).
     *
     * The walk uses `asRefs(address)` at each step to follow addressed
     * children without materializing them as JS values. When a path element
     * lands on an **inline** child (asRefs can't give a separate address —
     * the bytes are embedded in the parent chunk), this falls back to a full
     * `decode(address)` at that level and walks the remainder of the path
     * through the resulting JS value. Correctness preserved; the fallback
     * is rare for records at any scale because the encoder addresses any
     * child whose code is longer than a varint of the next address.
     *
     * No reactive bookkeeping happens here — this is the pure codec layer.
     * Callers (Streamo.get / StreamoRecord.get) register their own deps.
     *
     * @param {number} address  Starting address. Must be >= 0.
     * @param {...(string|number)} path  Keys to descend through.
     * @returns {any}
     */
    decodeAt(address: number, ...path: (string | number)[]): any;
    /**
     * Copy the value at `sourceAddress` out of `source` into this registry, and
     * return its address here. Bit-identical to encoding the same value fresh,
     * which is what makes the result canonical and dedup-able.
     *
     * Descends the CHUNK GRAPH, not the decoded value. Each chunk's parts are
     * read with `decodeParts`; a part is either an address (recurse into it) or
     * literal data embedded in this chunk (WORD/UINT7/OPAQUE payloads), which
     * cannot be copied piecewise.
     *
     * `asRefs` is the wrong instrument here, and it is worth saying why because
     * it looks right: it returns SEMANTIC children, so a DUPLE tree comes back
     * flattened and re-encoding rebuilds the tree in a different order than the
     * one that produced it. Tried 2026-10-07 — 91 of 107 bit-identity cases,
     * failing at N=1 and at every 2^k+1 above 32, where the tree is most
     * lopsided.
     *
     * `sharedThrough` is the last address this registry and `source` are known
     * to agree on. At or below it an address means the same thing in both, so it
     * carries over untouched and whole unchanged subtrees cost nothing — which
     * is the entire point of copyFrom over decode-then-re-encode.
     *
     * @param {CodecRegistry} source
     * @param {number} sourceAddress
     * @param {number} [sharedThrough=-1]
     * @returns {number} the address in THIS registry
     */
    copyFrom(source: CodecRegistry, sourceAddress: number, sharedThrough?: number): number;
    /**
     * Appends a compound code by splitting into constituent subcodes
     * (back-to-front, footer-determined widths) and appending each
     * independently. Returns the address of the outermost subcode.
     *
     */
    append(code: any): number;
    #private;
}
import { Addressifier } from './Addressifier.js';
