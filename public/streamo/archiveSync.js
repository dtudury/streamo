import { mkdir, open, readFile } from 'fs/promises'
import { join } from 'path'

/**
 * Load a stream from disk and keep it in sync as new chunks arrive.
 *
 * On startup, reads `<dir>/<publicKeyHex>.bin` (wire format: 4-byte LE
 * length prefix per chunk) and feeds it into the stream via
 * `makeWritableStream()`.
 *
 * Then opens the file for writing and pipes `makeReadableStream()` into
 * it. Two paths:
 *
 *   - **Append** (StreamoRecords, and fresh starts where the in-memory wire
 *     bytes match the file size). We open with `'a'` and start the
 *     reader at `fromOffset = byteLength` — only NEW chunks get written,
 *     the existing on-disk bytes stay untouched. Mirrors how
 *     `registrySync` skips already-known bytes on the wire.
 *
 *   - **Truncate-and-rewrite** (plain Streams whose load step compacted
 *     the byte chain shorter than the file). We open with `'w'`, reader
 *     from byte 0, rewrite cleanly.
 *
 * Returns `{ close }` so one-shot scripts can wrap up before exiting.
 * `close()` calls `stream.close()` (which tells the readable stream to
 * drain and end) and awaits the writer loop. After it resolves, every
 * byte the streamo had is in the kernel and the file handle is closed
 * — safe to `process.exit()` without losing tail data.
 *
 * Long-lived processes (the relay) never call close(); the writer loop
 * runs for the lifetime of the process, exactly as before.
 *
 * @param {import('./Streamo.js').Streamo} stream
 * @param {string} dir
 * @param {string} publicKeyHex
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export async function archiveSync (stream, dir, publicKeyHex) {
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${publicKeyHex}.bin`)

  // Load existing bytes into the stream.
  let fileSize = 0
  let loadWriter = null
  try {
    const bytes = await readFile(filePath)
    if (bytes.length > 0) {
      loadWriter = stream.makeWritableStream().getWriter()
      await loadWriter.write(bytes)
    }
    fileSize = bytes.length
  } catch {
    // No existing archive — start fresh.
  } finally {
    // Release the load writer's lock so the underlying writable stream
    // doesn't keep the process alive. Important on the throw path
    // (the refuse-to-truncate sanity below); benign on the happy path.
    if (loadWriter) {
      try { loadWriter.releaseLock() } catch {}
    }
  }

  // Compact plain Streamos: discard accumulated history and keep only
  // the current value. Skipped for StreamoRecord subclasses (slim AND
  // Writable) because their commit records embed dataAddress pointers
  // that would become invalid under compaction.
  //
  // Duck-type by `lastCommit` (defined on StreamoRecord, absent from
  // plain Streamo). Pre-11.0 this check was `typeof stream.commit !==
  // 'function'`, which worked when every Record had commit — but
  // post-11.0 slim StreamoRecord lost commit (moved to Writable), and
  // the old check silently misfired: it'd `_reset()` a slim Record
  // then TypeError on `set(value)`, leaving the stream empty and the
  // archive about to be truncated to 0 bytes. The current check is
  // record-shape-aware regardless of authorability.
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

  // Defense-in-depth sanity: after load (and the optional compact
  // above), in-memory state should match disk size — UNLESS we just
  // intentionally compacted. Any other cause of divergence (stale
  // process racing this one on the same archive, in-memory state
  // mutated between load and write, a future bug we haven't seen
  // yet) would be silently propagated to disk by the truncate path.
  // Refuse instead. The operator gets a loud crash with a diagnostic
  // pointing at what to investigate.
  if (!intentionallyCompacted && stream.wireByteLength !== fileSize) {
    throw new Error(
      `archiveSync refusing to overwrite ${filePath}: in-memory stream ` +
      `is ${stream.wireByteLength} wire-bytes after load but disk has ` +
      `${fileSize}. Usually means another process is racing this one on ` +
      `the same archive directory, or in-memory state was mutated between ` +
      `the load and this check. Investigate before retrying. (If you ` +
      `really need to replace the archive with the in-memory state, ` +
      `delete ${filePath} first.)`
    )
  }

  // Append-vs-truncate decision in wire-format units (matches what's
  // on disk and what the writer emits). When `stream.wireByteLength`
  // equals `fileSize`, the chain that's in memory produces the same
  // bytes the file already holds → append. Otherwise (compaction
  // shrunk the chain), truncate and rewrite.
  const append = stream.wireByteLength === fileSize
  const startOffset = append ? stream.byteLength : 0   // content-bytes for fromOffset

  const fileHandle = await open(filePath, append ? 'a' : 'w')
  const reader = stream.makeReadableStream({ fromOffset: startOffset }).getReader()

  // Writer loop. Drains chunks from the reader and writes them to the
  // file. Exits when the reader signals done (which happens after
  // `stream.close()` propagates through the readable stream's source).
  // The IIAFE's Promise is captured so close() can await it.
  const writerDone = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        await fileHandle.write(value)
      }
    } finally {
      await fileHandle.close()
    }
  })()

  return {
    async close () {
      stream.close()
      await writerDone
    }
  }
}
