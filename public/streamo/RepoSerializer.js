/**
 * @file RepoSerializer — the chain authority for a repo at the relay layer.
 *
 * At the relay there is *one* serializer per repo, shared across every
 * client that's connected to that repo's key. Clients accumulate their
 * pushes into batches (chunks + a covering SIG); they submit batches to
 * the serializer, which processes them sequentially against the repo's
 * current `committedChainHash`. Acceptance extends the top; rejection
 * is reported back to the submitter.
 *
 * "What goes up: goes up until it reaches the top" — this class is the
 * top. The asymmetry matters: clients receiving bytes from the relay
 * trust them (they came from the top, they're correct). Clients pushing
 * upward go through the serializer's gate.
 *
 * Pending = simple. A submit waits for the previous submit's promise
 * before running. JS's event loop serializes; no separate queue object,
 * no early-rejection state. If two clients submit racing batches, both
 * get processed in arrival order; the second one (chained off the now-
 * stale top) gets rejected with `chain-mismatch`. Slow on contention,
 * simple to reason about.
 */
import { Signature } from './Signature.js'
import { verifySignature } from './Signer.js'

// ── chain-hash helpers (mirror Repo's private helpers) ─────────────────
const cryptoSubtle = typeof crypto !== 'undefined' ? crypto.subtle : (await import('crypto')).webcrypto.subtle
async function sha256 (bytes) {
  return new Uint8Array(await cryptoSubtle.digest('SHA-256', bytes))
}
function arraysEqual (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
async function chainHashOf (prev, newBytes) {
  const newBytesHash = await sha256(newBytes)
  const combined = new Uint8Array(64)
  combined.set(prev, 0)
  combined.set(newBytesHash, 32)
  return await sha256(combined)
}

export class RepoSerializer {
  /** @param {import('./Repo.js').Repo} repo
   *  @param {Uint8Array} publicKey  the repo's signer pubkey */
  constructor (repo, publicKey) {
    this.repo = repo
    this.publicKey = publicKey
    // The promise chain that serializes incoming submissions. Every
    // submit() awaits this before running, then replaces it with its own
    // promise. JS single-threaded event-loop does the rest.
    this._lock = Promise.resolve()
  }

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
  submit (batch) {
    const next = this._lock.then(() => this._tryApply(batch))
    // Don't let a rejection in _tryApply break the chain for future submits.
    this._lock = next.catch(() => {})
    return next
  }

  async _tryApply (batch) {
    const { chunks, sig } = batch
    const codec = this.repo.footerToCodec[sig.at(-1)]
    if (codec?.type !== 'SIGNATURE') {
      return { accepted: false, reason: 'malformed' }
    }
    let sigDecoded
    try {
      sigDecoded = this.repo.decode(sig)
    } catch {
      return { accepted: false, reason: 'malformed' }
    }
    if (!(sigDecoded instanceof Signature)) {
      return { accepted: false, reason: 'malformed' }
    }

    // Hash all batch bytes (every chunk, regardless of alreadyHave —
    // the chain commits to the bytes, not the storage decision).
    const newBytesLen = chunks.reduce((sum, c) => sum + c.length, 0)
    const newBytes = new Uint8Array(newBytesLen)
    let pos = 0
    for (const c of chunks) { newBytes.set(c, pos); pos += c.length }

    const expected = await chainHashOf(this.repo.committedChainHash, newBytes)
    if (!arraysEqual(sigDecoded.chainHash, expected)) {
      return { accepted: false, reason: 'chain-mismatch' }
    }
    const valid = await verifySignature(this.publicKey, sigDecoded.chainHash, sigDecoded.compactRawBytes)
    if (!valid) {
      return { accepted: false, reason: 'verification-failed' }
    }

    // Atomic apply: append chunks (skip alreadyHave) then the SIG.
    for (const c of chunks) {
      if (this.repo.addressOf(c) === undefined) this.repo.append(c)
    }
    if (this.repo.addressOf(sig) === undefined) this.repo.append(sig)
    return { accepted: true }
  }
}
