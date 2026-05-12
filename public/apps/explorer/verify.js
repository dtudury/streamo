// Signature-verification helpers and visual primitives.
//
// `makeVerifier(onChange)` builds a closure-cached `verifyStatus(repo,
// keyHex, sig, sigAddress)` — synchronous return ('pending' on first
// touch) with async hydration ('valid' / 'invalid' / {error}) that calls
// `onChange` so reactive watchers re-run and the badge flips.
//
// `kindBanner`, `verifyLabel`, `verifyBadge` are pure h-emitting renders
// over a status value — no Repo, no async, no state.

import { h } from '../../streamo/h.js'
import { hexToBytes } from '../../streamo/utils.js'

// repo.verify(sig, publicKey) is async. Slots render synchronously, so we
// cache results keyed by (keyHex, sigChunkAddress) and kick off the async
// verify on first encounter. When it resolves, onChange() fires so the
// reactive slot re-runs and the badge flips from "verifying…" to ✓ / ✗.
//
// One verify per signature per page load (~sub-ms each for secp256k1).
export function makeVerifier (onChange) {
  const cache = new Map()  // `${keyHex}:${addr}` → 'pending' | 'valid' | 'invalid' | { error }
  return function verifyStatus (repo, keyHex, sig, sigAddress) {
    const cacheKey = `${keyHex}:${sigAddress}`
    if (cache.has(cacheKey)) return cache.get(cacheKey)
    cache.set(cacheKey, 'pending')
    repo.verify(sig, hexToBytes(keyHex))
      .then(valid => { cache.set(cacheKey, valid ? 'valid' : 'invalid'); onChange() })
      .catch(e => { cache.set(cacheKey, { error: e.message }); onChange() })
    return 'pending'
  }
}

// Consistent "what this is" banner at the top of every value-tab branch.
// label is the short codec/role name (e.g. "signed commit", "object",
// "duple"); content is whatever else goes in the banner (verify badge +
// label, field count, etc.); variant tints the surface — 'verified' for
// commits/sigs with a covering signature, 'unsigned' for commits awaiting
// one, undefined for everything else.
export function kindBanner (label, content, variant) {
  return h`
    <div class=${['kind-banner', variant || null]}>
      <span class="kind-label">${label}</span>
      ${content || null}
    </div>
  `
}

export function verifyLabel (status) {
  if (status === 'valid')   return 'verified — bytes match this repo’s public key'
  if (status === 'invalid') return 'NOT VERIFIED — bytes do not match the repo key'
  if (status === 'pending') return 'verifying…'
  return `error: ${status?.error ?? 'unknown'}`
}

export function verifyBadge (status) {
  if (status === 'valid')   return h`<span class="verify-badge valid"   title="signature verified against repo's public key">✓</span>`
  if (status === 'invalid') return h`<span class="verify-badge invalid" title="signature does NOT match repo's public key">✗</span>`
  if (status === 'pending') return h`<span class="verify-badge pending" title="verifying…">…</span>`
  return h`<span class="verify-badge error" title=${status?.error || 'verification error'}>⚠</span>`
}
