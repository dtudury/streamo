/**
 * Does this byte-store carry the author surface? Ask wherever a
 * `Mirror.local` is about to be written to: `local` is typed
 * `StreamoRecord | WritableStreamoRecord` and the read-only case is real,
 * not a typechecker artifact — a registry factory decides per key, and
 * `todomvc/main.js` documents the exact way it goes wrong.
 *
 * A predicate rather than a bare boolean so the check that throws is the
 * check that narrows, and the two can't drift.
 *
 * @param {any} x
 * @returns {x is WritableStreamoRecord}
 */
export function hasAuthorSurface(x: any): x is WritableStreamoRecord;
export class WritableStreamoRecord extends StreamoRecord {
    /**
     * Default commit message attached to every commit made via set() / setRefs().
     * Empty by default — clients opt in to set this for attribution. The chat web
     * client sets 'web' so commits are visibly distinguishable from a CLI
     * client's. Not enforced; explicit commit(working, msg) wins.
     */
    defaultMessage: string;
    /**
     * Reactive: the low-water mark of bytes this process authored locally.
     * `Infinity` means "nothing authored yet" (the default; what archive
     * replay and wire-inbound leave it at). Otherwise, the smallest byte
     * offset at which an author method appended.
     */
    get locallyAuthoredOffset(): number;
    /**
     * Lower the mark to `offset` if it's currently higher. Idempotent and
     * monotonic-downward. Called by the author methods with the
     * byteLength captured BEFORE the author append. Internal —
     * leading underscore by convention.
     */
    _markAuthoredAtOffset(offset: any): void;
    /**
     * Attach a signer so every commit is automatically signed.
     * Concurrent commits are batched: if a sign is in flight when another
     * commit lands, one more sign runs after the current one finishes,
     * covering all accumulated commits in a single signature.
     *
     * @param {import('./Signer.js').Signer} signer
     * @param {string} name  stream name passed to signer.keysFor()
     */
    attachSigner(signer: import("./Signer.js").Signer, name: string): void;
    /**
     * Whether a signer has been attached. Used by callers (like Draft) that
     * need to know before awaiting a sign — without a signer, waits for
     * `signedLength === byteLength` never complete.
     */
    get hasSigner(): boolean;
    /**
     * Write a value by creating a new commit: checkout → set → commit.
     *
     * Signature: set([address,] ...path, value)  — same as Streamo.set().
     * Path-level reactive mutations are fired after commit so watchers only
     * watching specific paths get precise notifications.
     */
    set(...args: any[]): any;
    /**
     * Like Streamo.setRefs() but auto-commits via checkout → setRefs → commit.
     */
    setRefs(...args: any[]): number;
    /**
     * Clone the repository at the last commit's data address.
     * The returned Streamo's get() immediately returns the last committed value.
     * Returns an empty Streamo if nothing has been committed yet.
     * @returns {Streamo}
     */
    checkout(): Streamo;
    /**
     * Copy the current value of workingStreamo into the repository and append
     * a commit record referencing it by address.
     *
     * When `options.remoteParent` is set, the commit cites another author's
     * value: `{ host, repo, dataAddress }`. The local commit is still signed
     * by us and append-only on our chain — `remoteParent` is a footnote, not
     * a merge. Anyone holding the cited stream can verify the citation by
     * decoding the value at `remoteParent.dataAddress` in that stream.
     *
     * `options.date` overrides the default "now" — useful when replaying
     * pre-existing history (e.g. seeding a streamo from git log).
     */
    commit(workingStreamo: any, message?: string, options?: {}): number;
    /**
     * Incorporate a slice of `source`'s value into this repo as a single
     * signed commit, with `remoteParent` set to cite the source.
     *
     * **Mode**: this version supports only `policy: 'replace'` — source's
     * value at `from` REPLACES our value at `into`. Sibling keys at
     * `into`'s parent are preserved.
     *
     * **Two shapes fall out naturally:**
     *   - *Fork*  — merge into an empty repo → no local parent + remoteParent
     *   - *Pull-overwrite* — merge into an existing chain → both set
     */
    merge(source: any, options?: {}): Promise<number>;
    /**
     * Sign every byte appended since the last SIG (or from the start).
     * Computes `chainHash = sha256(committedChainHash || sha256(newBytes))`,
     * signs it, and appends a SIGNATURE chunk carrying the chainHash + the
     * signature bytes.
     */
    sign(signer: any, streamoName: any): Promise<Signature>;
    #private;
}
import { StreamoRecord } from './StreamoRecord.js';
import { Streamo } from './Streamo.js';
import { Signature } from './Signature.js';
