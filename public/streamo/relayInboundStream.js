/**
 * @file relayInboundStream — the factory that turns incoming wire bytes
 * into trust+append on a StreamoRecord.
 *
 * **The relay's verb for receiving bytes.** A client that's subscribed
 * to a relay-served Record gets bytes streamed down to it; this factory
 * builds the WritableStream that consumes those bytes, validates the
 * chain-hash alignment at each SIG arrival, and appends the chunks to
 * the local StreamoRecord.
 *
 * **Lives here, not on the Record class,** because the trust+append shape
 * is something the relay *does TO* a Record — it isn't part of the
 * Record's identity. The Record itself is a chain-interpretation lens
 * over a Streamo (see EXPLORATION-streamorecord-slimming.md). The Record
 * exposes a tiny instance-method delegate to this factory for callers
 * who reach for `repo.makeRelayInboundStream()`.
 *
 * **What it trusts and what it checks:**
 * - **Trusts** that the bytes coming down from an authoritative relay are
 *   crypto-valid (the relay's per-Record `StreamoRecordSerializer` has
 *   already chain-checked and sig-verified before broadcast). So this
 *   path skips both the chain check (for non-SIG chunks) and the sig
 *   verify (for SIG chunks) that a from-scratch verifier would do.
 * - **Checks** chain-hash equality at SIG arrivals — the alignment
 *   check that catches the push-in-flight race. If the wire is about
 *   to extend the chain past `pendingChainHash` (its previous SIG's
 *   chainHash) but our local `committedChainHash` doesn't equal it
 *   too, we have local commits the wire doesn't know about — the
 *   staged chunks would land on top of them at wrong addresses. Raise
 *   `conflictDetected` and throw to close the connection cleanly.
 *
 * **Reactive surfacing:**
 * - On each SIG arrival, calls
 *   `record._session.setRelayChainHash(record.publicKeyHex, hash)` so
 *   Draft's `_awaitChainHash` and `fileSync`'s gate can await round-trip
 *   confirmation. (Item 6 of Mirror-and-Draft migration; state lives on
 *   the session per-connection, no longer on the record.)
 * - On alignment failure, calls `record._setConflictDetected(...)` so
 *   apps can react and offer recovery UX. (Not yet migrated to session.)
 */
import { turtleLocal } from './utils/turtleLog.js'

const arraysEqual = (a, b) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Build the writable stream that consumes relay-inbound bytes on behalf of
 * `record`. The returned stream parses the on-the-wire framing (length-
 * prefixed chunks via the same shape as `archiveSync`), stages non-SIG
 * chunks until a covering SIG arrives, performs the alignment check, and
 * appends the batch to `record`.
 *
 * If the local chain has diverged from the incoming chain (a
 * `pushRejected` is the typical cause), the write rejects and the
 * connection should be torn down. `repo.conflictDetected` becomes
 * non-null, surfacing the situation for recovery UX.
 *
 * @param {import('./StreamoRecord.js').StreamoRecord} record  the target
 *   StreamoRecord to append into and whose reactive flags to mutate
 * @param {number} [maxFrameSize=64*1024*1024]  defensive cap so a
 *   malformed length prefix can't allocate unbounded memory
 * @returns {WritableStream}
 */
export function makeRelayInboundStream (record, maxFrameSize = 64 * 1024 * 1024) {
  let buf = new Uint8Array(0)
  let bufOffset = 0
  let staged = []                                  // not-already-present chunks awaiting a covering SIG
  // Anchor on local state — the sender (relay) knows our offset/chainHash from
  // the subscribe handshake and is sending bytes from there. So our wire-side
  // pendingChainHash starts equal to our local committedChainHash; each sig
  // arriving from the wire advances both in lockstep. Local writes (e.g. the
  // user signs a commit) advance committedChainHash without touching
  // pendingChainHash, which is exactly when the alignment check should fire.
  let pendingChainHash = record.committedChainHash
  return new WritableStream({
    async write (incoming) {
      // Compact leftover + incoming into a fresh buf, reset offset.
      // Hot loop uses subarray (a view, not a copy) so each chunk
      // extraction is O(1) — the previous `buf = buf.slice(rest)`
      // pattern was O(N) per chunk, O(N²) per batched frame.
      const leftover = buf.length - bufOffset
      if (leftover === 0) buf = incoming
      else {
        const next = new Uint8Array(leftover + incoming.length)
        next.set(buf.subarray(bufOffset), 0)
        next.set(incoming, leftover)
        buf = next
      }
      bufOffset = 0
      while (buf.length - bufOffset >= 4) {
        const view = new DataView(buf.buffer, buf.byteOffset + bufOffset, 4)
        const len = view.getUint32(0, true)
        if (len === 0) throw new Error('malformed frame: zero-length chunk')
        if (len > maxFrameSize) throw new Error(`malformed frame: length ${len} exceeds ${maxFrameSize}`)
        if (buf.length - bufOffset < 4 + len) break
        const code = buf.subarray(bufOffset + 4, bufOffset + 4 + len)
        bufOffset += 4 + len

        const alreadyHave = record.addressOf(code) !== undefined
        const codec = record.footerToCodec[code.at(-1)]

        if (codec?.type === 'SIGNATURE') {
          // Alignment check (chain-hash equality): only matters when we'd
          // actually append new chunks. If staged is empty, this sig
          // closes an alreadyHave batch (a resync echo) — safe to skip.
          //
          // When the wire is about to extend the chain past pendingChainHash
          // (its previous sig's chainHash), our local committedChainHash
          // must equal pendingChainHash too — otherwise we have local
          // commits the wire doesn't know about and the staged chunks
          // would land on top of them at wrong addresses.
          if (staged.length > 0) {
            if (!arraysEqual(pendingChainHash, record.committedChainHash)) {
              // Dual-write during migration (Mirror-and-Draft item 6 task 3):
              // Record's field still exists; session's map is the target.
              // Both surfaces stay in sync; callers can migrate one at a time.
              // Step 3g removes the Record-side field + setter.
              const conflictInfo = { dataAddress: record.lastCommit?.dataAddress }
              record._setConflictDetected(conflictInfo)
              record._session?.setConflictDetected?.(record.publicKeyHex, conflictInfo)
              turtleLocal('conflict', record.publicKeyHex, { dataAddress: record.lastCommit?.dataAddress })
              throw new Error(
                'local store diverged from incoming chain: ' +
                'our most recent sig\'s chainHash does not equal the wire\'s previous sig\'s chainHash ' +
                '(local content past the last shared sig — push in flight or push got beaten)'
              )
            }
          }
          for (const c of staged) record.append(c)
          staged = []
          if (!alreadyHave) record.append(code)
          // Advance: the SIG chunk's first 32 bytes are its chainHash.
          // No decode needed — read the bytes directly. Surface to the
          // StreamoRecord as `relayChainHash` so `merge()` can await round-trip
          // confirmation of pushed bytes (the broadcast-back lands a
          // SIG here whose chainHash matches our just-signed local SIG).
          pendingChainHash = code.slice(0, 32)
          // Session owns relayChainHash state (per-connection, per-pubkey).
          // Optional-chain handles the no-session case — server-side
          // archive-only paths and tests that construct a record without
          // attaching a session simply skip the wire-state update.
          // See docs/EXPLORATION-mirror-and-draft-migration.md.
          record._session?.setRelayChainHash(record.publicKeyHex, pendingChainHash)
          turtleLocal('sig', record.publicKeyHex, { chainHash: pendingChainHash })
        } else if (!alreadyHave) {
          staged.push(code)
        }
      }
    }
  })
}
