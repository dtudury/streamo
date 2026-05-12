// Signature-verification helpers and visual primitives.
//
// `makeVerifier(recaller)` builds a closure-cached `verifyStatus(repo,
// keyHex, sig, sigAddress)` over a LiveSource — synchronous return
// ('pending' on first touch), async hydration via `cache.set` that
// fires the cache key. Slots that called `verifyStatus(...)` (and
// therefore `cache.get(cacheKey)`) auto-subscribe to their own
// cacheKey and re-run when the async resolves; no separate fire
// mechanism, no `dep()` call needed at the call site.
//
// `kindBanner`, `verifyLabel`, `verifyBadge` are pure h-emitting renders
// over a status value — no Repo, no async, no state.

import { h } from '../../streamo/h.js'
import { hexToBytes } from '../../streamo/utils.js'
import { liveObject } from '../../streamo/LiveSource.js'

// One verify per signature per page load (~sub-ms each for secp256k1).
// The cache target is the LiveSource's plain object; keys are
// `${keyHex}:${addr}` → 'valid' | 'invalid' | { error } (set once async
// resolves). An `inFlight` Set holds keys whose verify is kicked off
// but not yet resolved — outside the LiveSource so the kick-off
// doesn't fire the key in the same flush as the slot's first read
// (which would queue a wasted "pending → pending" re-run).
export function makeVerifier (recaller) {
  const cache = liveObject({}, { recaller, name: 'verify' })
  const inFlight = new Set()
  return function verifyStatus (repo, keyHex, sig, sigAddress) {
    const cacheKey = `${keyHex}:${sigAddress}`
    const existing = cache.get(cacheKey)
    if (existing !== undefined) return existing
    if (inFlight.has(cacheKey)) return 'pending'
    inFlight.add(cacheKey)
    repo.verify(sig, hexToBytes(keyHex))
      .then(valid => { inFlight.delete(cacheKey); cache.set(cacheKey, valid ? 'valid' : 'invalid') })
      .catch(e     => { inFlight.delete(cacheKey); cache.set(cacheKey, { error: e.message }) })
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
