// Public API. Most users want named imports from here:
//
//   import { Repo, Signer, registrySync } from '@dtudury/streamo'
//
// For advanced/internal use, subpath imports also work:
//
//   import { Recaller } from '@dtudury/streamo/utils/Recaller.js'
//
// StreamoComponent is intentionally NOT re-exported here: it extends
// HTMLElement at module-load time and cannot be imported in Node. Browser
// consumers should subpath-import it directly:
//
//   import { StreamoComponent, defineComponent } from '@dtudury/streamo/StreamoComponent.js'

export { Streamo, ConflictError, changedPaths } from './public/streamo/Streamo.js'
export { Repo } from './public/streamo/Repo.js'
export { Signer, verifySignature } from './public/streamo/Signer.js'
export { Signature } from './public/streamo/Signature.js'
export { RepoRegistry } from './public/streamo/RepoRegistry.js'
export { registrySync, handleRegistryPeer } from './public/streamo/registrySync.js'
export { archiveSync } from './public/streamo/archiveSync.js'
export { fileSync } from './public/streamo/fileSync.js'
export { originSync } from './public/streamo/originSync.js'
export { outletSync, attachStreamSync } from './public/streamo/outletSync.js'
export { s3Sync } from './public/streamo/s3Sync.js'
export { stateFileSync } from './public/streamo/stateFileSync.js'
export { webSync } from './public/streamo/webSync.js'
export { StreamoServer } from './public/streamo/StreamoServer.js'
export { h, HElement, HText } from './public/streamo/h.js'
export { mount, dismount } from './public/streamo/mount.js'
export { Recaller } from './public/streamo/utils/Recaller.js'
export { bytesToHex, hexToBytes } from './public/streamo/utils.js'
