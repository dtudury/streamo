/**
 * Yield every path where addrA and addrB differ, including the root.
 * Compares by address so unchanged subtrees are skipped in O(1).
 *
 * Uses streamo.asRefs (mutation-impossible) rather than decode(_, true)
 * so the comparison cannot append chunks. Without this, calling
 * changedPaths during Streamo.set could materialize inline children as
 * separate chunks AFTER the new commit, moving valueAddress past the
 * commit and corrupting StreamoRecord.lastCommit.
 *
 * Tradeoff: asRefs returns `undefined` for inline children's addresses,
 * so changedPaths can't see differences that happen entirely inside
 * inline-only subtrees. The parent path still fires, which is enough
 * for any watcher that doesn't read at a depth past where the structure
 * goes inline.
 */
export function changedPaths(streamo: any, addrA: any, addrB: any, path?: any[]): any;
/**
 * A Streamo is a reactive, content-addressable codec.
 *
 * It combines:
 *   - CodecRegistry: encode/decode any JS value to/from bytes
 *   - Recaller: fine-grained reactive dependency tracking (watch/get/set)
 *
 * Signing, verification, and chain bookkeeping live on StreamoRecord — Streamo
 * is intentionally identity-blind.
 */
export class Streamo extends CodecRegistry {
    /**
     * @param {{recaller?: Recaller, name?: string}} [options]
     */
    constructor({ recaller, name }?: {
        recaller?: Recaller;
        name?: string;
    });
    get recaller(): Recaller;
    /**
     * Append code and notify reactive watchers. The new chunk's address
     * becomes valueAddress.
     *
     * @param {Uint8Array} code
     * @returns {number}
     */
    append(code: Uint8Array): number;
    /**
     * Declare an ALREADY-STORED address as this record's newest value, and
     * notify watchers. `append` is this plus the store.
     *
     * This exists because `encode` appends and returns an address without
     * declaring anything — storing bytes and declaring the current value are
     * two jobs, and `set` wants only the first (it manages valueAddress itself
     * and emits path-level mutations instead of a blunt 'length'). An author
     * that encodes a commit or a signature directly wants both, so it calls
     * this with what encode returned.
     *
     * Before 2026-10-06 this was reached by accident: `encode` handed back an
     * unmaterialized Variable and `variable.materialize(r)` called `r.append`,
     * so passing the record as `r` quietly routed through the reactive append.
     * Omitting it left watchers silent — which is how that got caught.
     *
     * @param {number} address
     * @returns {number}
     */
    publish(address: number): number;
    /**
     * Decode the value at a path within the most-recently-appended value,
     * registering reactive dependencies so watchers re-run on changes.
     *
     * If the first argument is a number it is treated as an explicit address
     * (no dependency registered). Otherwise byteLength is accessed (dependency
     * registered) and all arguments are treated as a path into the decoded value.
     *
     * @param {...(number|string)} args
     * @returns {any}
     */
    get(...args: (number | string)[]): any;
    /**
     * Encode and append a new value, optionally updating at a path within the
     * current top-level decoded value. Notifies reactive watchers of which paths
     * changed.
     *
     * Signature: set([address,] ...path, value)
     * - If first arg is a number, use it as the base address.
     * - The last argument is always the value to set.
     * - Intermediate arguments are the path to update.
     *
     * @param {...(number|string|any)} args
     * @returns {number} address of the newly appended code
     */
    set(...args: (number | string | any)[]): number;
    /**
     * Navigate a path and return refs (addresses instead of decoded values).
     * With no path, returns root refs. Returns a plain number if the target is
     * a leaf (non-object/array), or undefined if the path doesn't exist.
     *
     * @param {...string} path
     * @returns {Object|number|undefined}
     */
    getRefs(...path: string[]): any | number | undefined;
    /**
     * Like set(), but the last argument is an address (number) rather than a
     * decoded value. Rebuilds only the changed path bottom-up, reusing sibling
     * addresses — same as set() but skips the leaf-encoding step.
     *
     * Requires at least one path key and an existing object at that path.
     *
     * @param {...(string|number)} args  ...path, address
     * @returns {number} address of the newly appended code
     */
    setRefs(...args: (string | number)[]): number;
    /**
     * Snapshot this streamo up to (and including) `address`.
     * The returned Streamo shares no mutable state with the original.
     * @param {number} address
     * @param {{ recaller?: Recaller, name?: string }} [options]
     * @returns {Streamo}
     */
    clone(address: number, { recaller, name }?: {
        recaller?: Recaller;
        name?: string;
    }): Streamo;
    /**
     * Address of the most-recently-appended chunk (the "top value"). The
     * explicit pointer is set by set/setRefs/append; if uninitialized (a
     * fresh or cloned streamo), falls back to byteLength-1.
     *
     * Streamo is SIG-blind — if the last chunk happens to be a SIGNATURE,
     * valueAddress points at it. Subclasses (StreamoRecord) that track signed chains
     * override this to walk past trailing SIGs.
     */
    get valueAddress(): number;
    #private;
}
import { CodecRegistry } from './CodecRegistry.js';
import { Recaller } from './utils/Recaller.js';
