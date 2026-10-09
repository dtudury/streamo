export class Addressifier {
    /**
     * @type {Array.<{uint8Array: Uint8Array, offset: number}>}
     */
    _chunks: Array<{
        uint8Array: Uint8Array;
        offset: number;
    }>;
    get byteLength(): number;
    get wireByteLength(): number;
    /**
     * @param {number} address
     * @returns {Uint8Array}
     */
    resolve(address: number): Uint8Array;
    /**
     * @param {Uint8Array} code
     * @param {number} address
     * @returns {void}
     */
    _index(code: Uint8Array, address: number): void;
    /**
     * @param {Uint8Array} code
     * @returns {number|undefined}
     */
    addressOf(code: Uint8Array): number | undefined;
    /**
     * @param {Uint8Array} code
     * @returns {number}
     */
    append(code: Uint8Array): number;
    close(): void;
    get isClosed(): boolean;
    _reset(): void;
    /**
     * @param {number} address
     * @returns {Addressifier}
     */
    clone(address: number): Addressifier;
    /**
     * @template {Addressifier} T @param {T} target @returns {T}
     */
    _applyView<T extends Addressifier>(target: T): T;
    /**
     * @template {Addressifier} T
     * @param {T} target
     * @param {number} address
     * @returns {T}
     */
    _applyClone<T extends Addressifier>(target: T, address: number): T;
    /**
     * @param {number} [start=0]
     * @param {number} [end=this.byteLength]
     * @returns {Uint8Array<ArrayBuffer>}  narrower than `Uint8Array` on
     */
    slice(start?: number, end?: number): Uint8Array<ArrayBuffer>;
    /**
     * @param {number} byteIndex
     * @returns {number|undefined}
     */
    byteAt(byteIndex: number): number | undefined;
    /**
     * @param {{ fromOffset?: number, maxBatch?: number }} [options]
     * @returns {ReadableStream}
     */
    makeReadableStream({ fromOffset, maxBatch }?: {
        fromOffset?: number;
        maxBatch?: number;
    }): ReadableStream;
    /**
     * @param {number} [maxFrameSize=64*1024*1024]  reject frames larger than this
     * @returns {WritableStream}
     */
    makeWritableStream(maxFrameSize?: number): WritableStream;
    #private;
}
