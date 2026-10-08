// Public API.
//
//   import { StreamoRecord, Signer, Hub } from '@dtudury/streamo'
//
// Subpath imports also work:
//
//   import { Recaller } from '@dtudury/streamo/utils/Recaller.js'
//
// v1 — the registry/sync/serving layer and the h/mount app framework — was
// deleted on 2026-10-08. It is preserved in full on the `v1-archive` branch
// and the `v1-complete` tag. Nothing here re-exports it.

export { Streamo, changedPaths } from './public/streamo/Streamo.js'
export { StreamoRecord } from './public/streamo/StreamoRecord.js'
export { WritableStreamoRecord } from './public/streamo/WritableStreamoRecord.js'
export { Signer, verifySignature } from './public/streamo/Signer.js'
export { Signature } from './public/streamo/Signature.js'
export { Opaque } from './public/streamo/Opaque.js'
export { StreamoRecordSerializer } from './public/streamo/StreamoRecordSerializer.js'
export { Recaller } from './public/streamo/utils/Recaller.js'
export { bytesToHex, hexToBytes } from './public/streamo/utils.js'
export { h, handle, memo, HElement, HText } from './public/streamo/h.js'

// v2
export { Hub } from './public/streamo/v2/Hub.js'
export { Upstream } from './public/streamo/v2/Upstream.js'
export { Downstream } from './public/streamo/v2/Downstream.js'
export { loopback } from './public/streamo/v2/loopback.js'
