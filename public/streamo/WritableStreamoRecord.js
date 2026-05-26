/**
 * @file WritableStreamoRecord — a StreamoRecord you can author into.
 *
 * **Subclass for author capability.** A plain `StreamoRecord` is the
 * read-only definitional minimum: a Streamo whose bytes interpret as a
 * signed chain. It can be read, traversed, verified — but it can't be
 * written to. WritableStreamoRecord adds the author surface: attachSigner,
 * set, setRefs, commit, checkout, merge, update, sign.
 *
 * **Why subclass for author, not compose:** authorability is type-level
 * (knowable at construction). The explorer holds StreamoRecord (peer
 * Records it subscribed to and can't sign for). The chat app holds
 * WritableStreamoRecord for the user's own identity Record. Different
 * intents, different types — the API refuses misuse loudly instead of
 * surfacing it as a runtime `attachSigner-was-never-called` surprise.
 *
 * **Co-located with the locallyAuthoredOffset mark.** Every author
 * method here calls `_markAuthoredAtOffset(byteLengthBeforeAppend)`,
 * which lowers the Streamo's low-water mark to the first byte this
 * process authored. Outbound readers (registrySync's push path) filter
 * by that mark, so a non-authoring observer (e.g. a watch.js loading a
 * Record over the wire) doesn't re-push received bytes — the substrate
 * has a word now for "I authored this" vs "I received this." See
 * Streamo.js's `#locallyAuthoredOffset` docs.
 *
 * **During the 11.0 migration window:** the author methods still live
 * on StreamoRecord (with the mark calls in place). WritableStreamoRecord
 * inherits them. The next phase moves the methods into this file
 * directly, leaving StreamoRecord slim.
 */
import { StreamoRecord } from './StreamoRecord.js'

export class WritableStreamoRecord extends StreamoRecord {
}
