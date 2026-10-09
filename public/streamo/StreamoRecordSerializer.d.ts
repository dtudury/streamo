export class StreamoRecordSerializer {
    /** @param {import('./StreamoRecord.js').StreamoRecord} repo
     *  @param {Uint8Array} publicKey  the repo's signer pubkey */
    constructor(repo: import("./StreamoRecord.js").StreamoRecord, publicKey: Uint8Array);
    repo: import("./StreamoRecord.js").StreamoRecord;
    publicKey: Uint8Array<ArrayBufferLike>;
    /** @type {Promise<any>} */
    _lock: Promise<any>;
    /**
     * Submit a batch (chunks + covering SIG) for atomic chain extension.
     * Resolves with `{ accepted: true }` on success, or
     * `{ accepted: false, reason }` on rejection. Reasons:
     *   - 'chain-mismatch'        — sig.chainHash doesn't extend the top
     *   - 'verification-failed'   — sig.compactRawBytes didn't crypto-verify
     *   - 'malformed'             — sig chunk wasn't a SIGNATURE codec, or
     *                               batch otherwise didn't parse
     *
     * @param {{ chunks: Uint8Array[], sig: Uint8Array }} batch
     * @returns {Promise<{ accepted: boolean, reason?: string }>}
     */
    submit(batch: {
        chunks: Uint8Array[];
        sig: Uint8Array;
    }): Promise<{
        accepted: boolean;
        reason?: string;
    }>;
    _tryApply(batch: any): Promise<{
        accepted: boolean;
        reason: string;
    } | {
        accepted: boolean;
        reason?: undefined;
    }>;
}
/**
 * Per-(connection, repo) batch accumulator. Parses length-prefixed wire
 * frames into chunks; accumulates until a SIGNATURE chunk arrives; submits
 * the completed batch (chunks + sig) to the repo's serializer.
 *
 * Used at the relay only. Each WS connection has its own accumulator per
 * subscribed repo; all of those accumulators feed the same serializer for
 * a given repo.
 */
export class ConnectionAccumulator {
    /** @param {StreamoRecordSerializer} serializer
     *  @param {(result: { accepted: boolean, reason?: string }) => void} onBatchResult
     *    callback invoked with the serializer's result after each batch submit;
     *    use it to send accept/reject control messages back to the connection. */
    constructor(serializer: StreamoRecordSerializer, onBatchResult?: (result: {
        accepted: boolean;
        reason?: string;
    }) => void);
    serializer: StreamoRecordSerializer;
    onBatchResult: (result: {
        accepted: boolean;
        reason?: string;
    }) => void;
    repo: import("./StreamoRecord.js").StreamoRecord;
    buf: Uint8Array<ArrayBuffer>;
    bufOffset: number;
    chunks: any[];
    maxFrameSize: number;
    write(incoming: any): Promise<void>;
}
