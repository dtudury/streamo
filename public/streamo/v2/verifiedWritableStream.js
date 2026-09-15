import { ConnectionAccumulator, StreamoRecordSerializer } from '../StreamoRecordSerializer.js'

export function makeVerifiedWritableStream (record, publicKey) {
  const accumulator = new ConnectionAccumulator(
    new StreamoRecordSerializer(record, publicKey),
    result => {
      if (!result.accepted) throw new Error(`makeVerifiedWritableStream: rejected batch (${result.reason})`)
    }
  )
  return new WritableStream({ write: frame => accumulator.write(frame) })
}
