/**
 * @file tieredArchiveSync — drop-in replacement for archiveSync that
 * uses a Cascade (tier list) instead of a single directory.
 *
 * Mirrors archiveSync's contract: load existing bytes, sync stream
 * writes back to persistent storage, return {close} for clean shutdown.
 * See [[2026-05-31-tieredArchiveSync-design-notes-for-morning-me]] for
 * the adaptation table archiveSync-concept → Cascade-equivalent.
 *
 * Differences from archiveSync (semantic, not just plumbing):
 *   - No file handle. The Cascade is always open across calls.
 *   - Truncate-vs-append: same logic, but truncate = `cascade.remove(key)`
 *     before the writer loop starts. Cascade.write always appends to
 *     tier 0; "truncate" semantically means "wipe the key everywhere".
 *   - The wireByteLength sanity check is preserved verbatim — it's
 *     catching real bugs (process-racing-on-same-archive). See
 *     [[preserve-sanity-checks]] for why this matters.
 *
 * @param {import('./Streamo.js').Streamo} stream
 * @param {import('./Cascade.js').Cascade} cascade
 * @param {string} publicKeyHex
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export async function tieredArchiveSync (stream, cascade, publicKeyHex) {
  // Load existing bytes (if any) into the stream.
  let storedSize = 0
  let loadWriter = null
  try {
    const bytes = await cascade.read(publicKeyHex)
    if (bytes && bytes.length > 0) {
      loadWriter = stream.makeWritableStream().getWriter()
      await loadWriter.write(bytes)
      storedSize = bytes.length
    }
  } finally {
    if (loadWriter) {
      try { loadWriter.releaseLock() } catch {}
    }
  }

  // Compact plain Streamos: discard accumulated history and keep only
  // the current value. Skipped for StreamoRecord subclasses — see
  // archiveSync.js for the full reasoning (commit records embed
  // dataAddress pointers that compaction would invalidate).
  let intentionallyCompacted = false
  if (stream.byteLength > 0 && !('lastCommit' in stream)) {
    try {
      const value = stream.get()
      if (value !== undefined) {
        stream._reset()
        stream.set(value)
        intentionallyCompacted = true
      }
    } catch { /* not compactable */ }
  }

  // Defense-in-depth sanity. Same protection as archiveSync.js line 96.
  // Catches: another process racing on the same key, in-memory state
  // mutated between load and check, future bugs we haven't seen yet.
  // Loud crash > silent corruption.
  if (!intentionallyCompacted && stream.wireByteLength !== storedSize) {
    // Order matters here. This message used to lead with "another process is
    // racing," which sent a debugging session looking for a second process
    // that didn't exist (2026-08-03). The far more common cause is this
    // process's own previous run dying mid-append — a crash or a SIGTERM
    // between the write starting and finishing leaves the cascade a few
    // bytes longer than anything that can be loaded back, and then every
    // subsequent start fails HERE rather than where the original crash was.
    // The stale entry outlives the bug that made it and masks it.
    const delta = storedSize - stream.wireByteLength
    throw new Error(
      `tieredArchiveSync refusing to overwrite ${publicKeyHex}: in-memory ` +
      `stream is ${stream.wireByteLength} wire-bytes after load but cascade ` +
      `has ${storedSize} (${delta > 0 ? `${delta} more on disk` : `${-delta} more in memory`}). ` +
      `Most often the previous run of THIS process died mid-append — a crash ` +
      `or a kill between starting and finishing a write — so the cascade ` +
      `holds a partial trailing record. Check whether an earlier run crashed ` +
      `before assuming contention; if two processes really do share this ` +
      `data-dir, that is the other cause. Recover with ` +
      `cascade.remove('${publicKeyHex}'), or move the .bin aside — the ` +
      `Record re-syncs from the relay and local files.`
    )
  }

  // Append-vs-truncate decision (in wire-format units, matching what
  // makeReadableStream emits and what's stored). When wireByteLength
  // === storedSize, the in-memory chain produces the same bytes the
  // cascade already holds → append from there. Otherwise (compaction
  // shrunk the chain), wipe the cascade entry and rewrite from byte 0.
  const append = stream.wireByteLength === storedSize
  const startOffset = append ? stream.byteLength : 0

  if (!append) {
    // Truncate-equivalent: drop the existing bytes from the cascade.
    // Subsequent writes start fresh.
    await cascade.remove(publicKeyHex)
  }

  // Writer loop. Drains chunks from the reader and appends to the
  // cascade. Exits when the reader signals done (after stream.close()
  // propagates through the readable stream's source). The IIAFE's
  // Promise is captured so close() can await it.
  const reader = stream.makeReadableStream({ fromOffset: startOffset }).getReader()
  const writerDone = (async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      await cascade.write(publicKeyHex, value)
    }
  })()

  return {
    async close () {
      stream.close()
      await writerDone
    }
  }
}
