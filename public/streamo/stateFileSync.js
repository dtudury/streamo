import { writeFile } from 'fs/promises'

/**
 * Watch a stream and write its current state as JSON to filePath on every change.
 * The file is written whenever a new value is committed (or set on a plain Stream).
 *
 * @param {import('./Stream.js').Stream} stream
 * @param {string} filePath
 */
export function stateFileSync (stream, filePath) {
  stream.recaller.watch('state-file-sync', () => {
    const state = stream.get()
    if (state != null) {
      writeFile(filePath, JSON.stringify(state, null, 2) + '\n').catch(console.error)
    }
  })
}
