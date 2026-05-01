import { mkdir, open, readFile } from 'fs/promises'
import { join } from 'path'

/**
 * Load a stream from disk and keep it in sync as new chunks arrive.
 *
 * On startup, reads `<dir>/<publicKeyHex>.bin` (wire format: 4-byte LE length
 * prefix per chunk) and feeds it into the stream via makeWritableStream().
 *
 * Then opens the file for writing and drains makeReadableStream() into it —
 * re-emitting all loaded chunks first, then appending new ones as they arrive.
 * This means the file is always a complete, valid wire-format snapshot.
 *
 * @param {import('./Stream.js').Stream} stream
 * @param {string} dir  directory to store archive files in
 * @param {string} publicKeyHex  hex-encoded public key, used as filename
 */
export async function archiveSync (stream, dir, publicKeyHex) {
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${publicKeyHex}.bin`)

  // Load existing data
  try {
    const bytes = await readFile(filePath)
    if (bytes.length > 0) {
      const writer = stream.makeWritableStream().getWriter()
      await writer.write(bytes)
    }
  } catch {
    // No existing archive — start fresh
  }

  // Compact plain Streams: discard accumulated history and keep only the
  // current value. Skipped for Repository subclasses whose commit records
  // embed dataAddress pointers that would become invalid after a reset.
  if (stream.byteLength > 0 && typeof stream.commit !== 'function') {
    try {
      const value = stream.get()
      if (value !== undefined) {
        stream._reset()
        stream.set(value)
      }
    } catch { /* not compactable */ }
  }

  // Rewrite file from chunk 0 and keep appending as new chunks arrive.
  // makeReadableStream() emits all existing chunks then waits indefinitely,
  // so this loop runs for the lifetime of the process.
  const fileHandle = await open(filePath, 'w')
  const reader = stream.makeReadableStream().getReader();
  (async () => {
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
}
