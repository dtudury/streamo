/**
 * A Streamo whose values are commit records.
 *
 * Every byte on the chain is either a COMMIT, a child chunk referenced
 * by a commit's dataAddress, or a SIGNATURE anchoring everything before
 * it. `get()` and `getRefs()` are overridden to read from the last
 * commit's dataAddress transparently — callers don't have to know
 * about the commit envelope.
 *
 * To author, use the `WritableStreamoRecord` subclass.
 */
export class StreamoRecord extends Streamo {
    /**
     * Hex-encoded pubkey this Record was materialized under. Populated by
     * `StreamoRecordRegistry._materialize` immediately after construction.
     * Undefined for Records created without going through a registry.
     * @type {string | undefined}
     */
    publicKeyHex: string | undefined;
    /**
     * The signed commit batches at or after `offset`, in order, each shaped
     * the way `StreamoRecordSerializer.submit` wants: `{ chunks, sig }`.
     *
     * This is the author side of what `ConnectionAccumulator` does for the
     * wire. The accumulator exists to turn length-prefixed BYTES into these
     * batches; an author already holds the chunks, so it needs the batching
     * and not the framing. Going through the wire adapter in-process meant
     * serializing a Record and parsing it straight back — on a small mixed
     * record the 4-byte prefixes alone are 136% of the content.
     *
     * A trailing run of chunks with no SIG after them is deliberately
     * omitted: unsigned bytes are not a submittable commit, and `submit`
     * would reject them as malformed. Callers that must not race a pending
     * signature await `signedLength === byteLength` first.
     *
     * @param {number} [offset=0]  skip chunks starting before this byte
     * @returns {Array<{ chunks: Uint8Array[], sig: Uint8Array }>}
     */
    commitBatchesFrom(offset?: number): Array<{
        chunks: Uint8Array[];
        sig: Uint8Array;
    }>;
    /**
     * Byte length covered by the most recent SIGNATURE chunk. Derived from
     * the bytes — no cached state. Returns 0 if no SIG has been appended.
     */
    get signedLength(): number;
    /**
     * The 32-byte chainHash committed by the most recent SIGNATURE chunk.
     * Derived from the bytes: the first 32 bytes of that 97-byte chunk.
     * Returns 32 zeros (the chain seed) if no SIG has been appended.
     */
    get committedChainHash(): Uint8Array<ArrayBuffer>;
    /**
     * The latest commit record, or null if nothing has been committed yet.
     * Registers a reactive dependency on the commit log length.
     * @returns {{ message: string, date: Date, dataAddress: number, parent: number|undefined, remoteParent?: { host: string, repo: string, dataAddress: number } }|null}
     */
    get lastCommit(): {
        message: string;
        date: Date;
        dataAddress: number;
        parent: number | undefined;
        remoteParent?: {
            host: string;
            repo: string;
            dataAddress: number;
        };
    } | null;
    /**
     * Decode the value at a path, reading from the last commit's dataAddress.
     * Falls back to Streamo.get() if no commits exist yet.
     *
     * Registers reactive dependencies so watchers re-run when new commits land.
     */
    get(...args: any[]): any;
    /**
     * Like Streamo.getRefs() but reads from the last commit's dataAddress.
     */
    getRefs(...path: any[]): any;
    /**
     * Eager-decoded value at the last commit's dataAddress.
     * Returns undefined if nothing has been committed yet.
     *
     * NB: the name is historical — this returns the WHOLE value; the
     * files map (if there is one) is at `.files` of the return. Reach
     * for `get()` with no path when you want the same thing lazily.
     */
    get files(): any;
    /**
     * Iterate commits from newest to oldest. Lazy — decodes as it walks.
     */
    history(): Generator<{
        message: string;
        date: Date;
        dataAddress: number;
        parent: number | undefined;
        remoteParent?: {
            host: string;
            repo: string;
            dataAddress: number;
        };
    }, void, unknown>;
    /**
     * The commit before the head, or null if the head has no parent (initial
     * commit / no commits at all). Positional accessor for the common case
     * where you want "the previous one" without materializing history().
     */
    get parent(): any;
    /**
     * The commit `n` steps back from the head. `n === 0` returns the head
     * (same as `lastCommit`); `n === 1` is `parent`; etc. Returns null if
     * `n` exceeds the chain length. Walks history() lazily — cost is O(n).
     */
    ancestor(n: any): {
        message: string;
        date: Date;
        dataAddress: number;
        parent: number | undefined;
        remoteParent?: {
            host: string;
            repo: string;
            dataAddress: number;
        };
    };
    /**
     * Stateless crypto-check: is `sig` a valid signature over `sig.chainHash`
     * by `publicKey`? Doesn't re-verify chain consistency — that's the
     * StreamoRecordSerializer's job at the relay (chain check happens there
     * before any incoming batch lands).
     */
    verify(sig: any, publicKey: any): Promise<boolean>;
    /**
     * Reactive: true once makeRelayInboundStream has rejected an incoming
     * batch because our local store has content past the last shared sig
     * (a push-in-flight race: we wrote locally, the relay sent down other
     * bytes before knowing about our push, our push will likely be
     * rejected). This is a *conflict*, not a fork.
     */
    /**
     * Back-reference to the session that subscribed this StreamoRecord. Set
     * by `session.subscribe`; `WritableStreamoRecord.update()` reads it
     * (via `_session`) to request a session-level resync after a rejected
     * push. Null on Records that aren't attached to a wire (server-side
     * archive-only, tests, etc.).
     */
    _attachSession(session: any): void;
    /**
     * The attached session, or null. Exposed via `_` accessor so subclasses
     * (specifically WritableStreamoRecord.update) can reach it across the
     * private-field boundary.
     */
    get _session(): any;
    /**
     * Reactive: true once an upstream relay session has been attached.
     * Stays true for the lifetime of this StreamoRecord — auto-reconnect
     * (8.5.0) keeps the session object stable across blips.
     */
    get hasRelay(): boolean;
    /**
     * Can this store be authored to? Always false here; WritableStreamoRecord
     * overrides. Declared on the base so `isAuthorable` means the same thing
     * on a Record, a WritableRecord and a Mirror — callers holding "some
     * byte-store" can ask without knowing which they got.
     */
    get isAuthorable(): boolean;
    #private;
}
import { Streamo } from './Streamo.js';
