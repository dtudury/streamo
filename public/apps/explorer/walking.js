// Repo-walking helpers — read a Repo's byte stream and yield/return
// structured data. No DOM, no h. Each function takes a Repo as its
// first arg and uses only Repo's public surface (resolve, decode,
// asRefs, directReferences, footerToCodec, byteLength).

import { truncHex } from './format.js'
import { isCommitShape } from './shapes.js'

// Given a signature chunk at `sigAddr` (last byte) with length `sigLen`,
// return the address of the first byte this sig covers — walking back
// through non-sig chunks until we hit another signature (in which case
// signedFrom is one past that sig's last byte) or run off the start
// (signedFrom is 0).  Under the hash-chain model a signature attests to
// every chunk appended since the previous signature, so this range is
// implicit in the chunk graph rather than carried in the sig record.
export function computeSignedFrom (repo, sigAddr, sigLen) {
  let walk = sigAddr - sigLen
  while (walk >= 0) {
    const code = repo.resolve(walk)
    if (!code || !code.length) break
    if (repo.footerToCodec[code.at(-1)]?.type === 'SIGNATURE') return walk + 1
    walk -= code.length
  }
  return 0
}

// Walk every chunk newest-first, yielding one entry per commit (with
// its covering signature attached) and one 'other' entry per non-commit
// non-sig chunk. A signature is part of *how* a commit is verified, not
// a thing of its own — so the user-level unit is the commit. Walking
// newest-first, we encounter each sig before the commits it covers
// (sig has higher address than the bytes it signed); we track the
// most-recently-seen sig and attach it to subsequent commits as their
// 'covering'. Commits encountered before any sig are uncovered (sign
// in flight or none yet) — those have covering: null.
export function * commitsNewestFirst (repo) {
  const len = repo.byteLength
  if (len <= 0) return
  let addr = len - 1
  let covering = null  // most-recent sig encountered in this walk
  while (addr >= 0) {
    const code = repo.resolve(addr)
    if (!code || !code.length) break
    const type = repo.footerToCodec[code.at(-1)]?.type
    if (type === 'SIGNATURE') {
      let sig
      try { sig = repo.decode(addr) } catch { sig = null }
      if (sig) {
        covering = {
          sigAddress: addr,
          signedFrom: computeSignedFrom(repo, addr, code.length),
          signedTo: addr - code.length,
          sigHex: truncHex(sig.compactRawBytes, 12)
        }
      }
      yield { kind: 'sig', address: addr, codecType: type }
    } else if (type === 'OBJECT') {
      let value
      try { value = repo.decode(addr) } catch { value = null }
      if (isCommitShape(value)) {
        yield {
          kind: 'commit',
          address: addr,
          message: value.message,
          date: value.date,
          dataAddress: value.dataAddress,
          parent: value.parent,
          covering
        }
      } else {
        yield { kind: 'other', address: addr, codecType: type }
      }
    } else {
      yield { kind: 'other', address: addr, codecType: type }
    }
    addr -= code.length
  }
}

// Find the covering signature for a commit — the first signature chunk
// newer than the commit whose [signedFrom, signedTo] range includes its
// address. Returns { sigAddress, signedFrom, signedTo, decoded } or null
// if the commit is uncovered (sign in flight or pending).
export function findCoveringSig (repo, commitAddr) {
  let scan = repo.byteLength - 1
  while (scan > commitAddr) {
    const code = repo.resolve(scan)
    if (!code || !code.length) break
    if (repo.footerToCodec[code.at(-1)]?.type === 'SIGNATURE') {
      let sig
      try { sig = repo.decode(scan) } catch { sig = null }
      if (sig) {
        const signedFrom = computeSignedFrom(repo, scan, code.length)
        const signedTo = scan - code.length
        if (signedFrom <= commitAddr && signedTo >= commitAddr) {
          return { sigAddress: scan, signedFrom, signedTo, decoded: sig }
        }
      }
    }
    scan -= code.length
  }
  return null
}

// Find the commits (newest-first) covered by a particular signature. Used
// by the at-view's SIGNATURE branch to assemble the "this is what you were
// looking for" polished view from a sig address alone.
export function commitsCoveredBySignature (repo, signedFrom, signedTo) {
  const commits = []
  let addr = signedTo
  while (addr >= signedFrom) {
    const code = repo.resolve(addr)
    if (!code || !code.length) break
    const type = repo.footerToCodec[code.at(-1)]?.type
    if (type === 'OBJECT') {
      let value
      try { value = repo.decode(addr) } catch { value = null }
      if (isCommitShape(value)) {
        commits.push({
          address: addr,
          message: value.message,
          date: value.date,
          dataAddress: value.dataAddress,
          parent: value.parent
        })
      }
    }
    addr -= code.length
  }
  return commits
}

// Decode the value at an address but treat object/array as REFS (children
// are addresses, not decoded recursively). For primitives, returns the
// decoded value directly.
export function valueAndChildren (repo, address) {
  const code = repo.resolve(address)
  const codecType = repo.footerToCodec[code.at(-1)]?.type
  const refs = repo.asRefs(address)
  return { codecType, refs, decoded: repo.decode(address) }
}

// Resolve the symbolic HEAD address to the most-recent COMMIT chunk's
// address — not the most-recent signature. The user-level unit is the
// commit; sigs are how it's verified, but HEAD-as-a-commit is what
// people mean by "the latest." Returns undefined if there are no commits.
export function resolveHead (repo) {
  let walk = repo.byteLength - 1
  while (walk >= 0) {
    const code = repo.resolve(walk)
    if (!code || !code.length) break
    if (repo.footerToCodec[code.at(-1)]?.type === 'OBJECT') {
      let value
      try { value = repo.decode(walk) } catch { value = null }
      if (isCommitShape(value)) return walk
    }
    walk -= code.length
  }
  return undefined
}

export function safeGet (f) { try { return f() } catch { return undefined } }

// Build a child→parents index over the chunk graph in one pass, so we
// can answer "who references address X?" in O(1) per query and walk
// up parent chains without re-scanning. Walks `directReferences` (not
// `asRefs`), so internal Duples are preserved as their own rows —
// mirroring what storageTree does going DOWN.
export function buildDirectReferrerIndex (repo) {
  const index = new Map() // childAddr → [{ address, codecType }]
  let addr = repo.byteLength - 1
  while (addr >= 0) {
    const code = repo.resolve(addr)
    if (!code || !code.length) break
    let refs = []
    try { refs = repo.directReferences(addr) ?? [] } catch {}
    if (refs.length) {
      const codec = repo.footerToCodec[code.at(-1)]
      const entry = { address: addr, codecType: codec?.type }
      for (const child of refs) {
        if (!index.has(child)) index.set(child, [])
        index.get(child).push(entry)
      }
    }
    addr -= code.length
  }
  return index
}
