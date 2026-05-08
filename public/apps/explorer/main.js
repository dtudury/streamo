// streamo explorer — read-only registry / repo / address browser.
//
// Three views, navigated by URL hash:
//   #/                              — registry list
//   #/repo/<keyHex>                 — chunks (commits + signatures) in a repo
//   #/repo/<keyHex>/at/<address>    — the value at any address
//
// State lives in plain JS variables; reactivity is bridged from each Repo's
// internal Recaller into the app-level Recaller via the `signal` pattern
// (see chat/main.js for the same approach).

import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { changedPaths } from '../../streamo/Streamo.js'
import { hexToBytes } from '../../streamo/utils.js'

// ── Connect ───────────────────────────────────────────────────────────────

const registry = new RepoRegistry()
const port = +location.port || 80
const connEl = document.getElementById('conn')

try {
  await registrySync(registry, location.hostname, port)
  connEl.textContent = `connected · ${location.hostname}:${port}`
  connEl.classList.add('ok')
} catch (e) {
  connEl.textContent = `connection failed: ${e.message}`
  connEl.classList.add('err')
  throw e
}

// ── App-level reactivity ──────────────────────────────────────────────────

const recaller = new Recaller('explorer')
const signal = {}
const dep = () => recaller.reportKeyAccess(signal, 'data')

const schedule = typeof requestAnimationFrame !== 'undefined'
  ? fn => requestAnimationFrame(fn)
  : fn => queueMicrotask(fn)
let scheduled = false
function fire () {
  if (scheduled) return
  scheduled = true
  schedule(() => { scheduled = false; recaller.reportKeyMutation(signal, 'data') })
}

const watched = new Set()
function watchRepo (key, repo) {
  if (watched.has(key)) return
  watched.add(key)
  repo.watch(`explorer:${key}`, () => {
    repo.byteLength
    fire()
  })
}
for (const [k, r] of registry) watchRepo(k, r)
registry.onOpen((k, r) => { watchRepo(k, r); fire() })

// ── Hash routing ──────────────────────────────────────────────────────────

function viewFromHash () {
  const m = (location.hash || '#/').match(/^#\/repo\/([0-9a-f]+)(?:\/at\/(\d+))?\/?$/i)
  if (!m) return { kind: 'registry' }
  if (m[2] != null) return { kind: 'at', keyHex: m[1], address: +m[2] }
  return { kind: 'repo', keyHex: m[1] }
}

function hashFromView (v) {
  switch (v.kind) {
    case 'repo': return `#/repo/${v.keyHex}`
    case 'at':   return `#/repo/${v.keyHex}/at/${v.address}`
    default:     return '#/'
  }
}

let view = viewFromHash()
function go (next) {
  view = next
  const target = hashFromView(next)
  if (location.hash !== target) location.hash = target
  fire()
}
window.addEventListener('hashchange', () => {
  const next = viewFromHash()
  if (next.kind === view.kind && next.keyHex === view.keyHex && next.address === view.address) return
  view = next
  fire()
})

// ── Helpers ───────────────────────────────────────────────────────────────

const truncKey = k => k.slice(0, 12) + '…'
const truncHex = (b, n = 16) => Array.from(b.subarray(0, n)).map(x => x.toString(16).padStart(2, '0')).join('') + (b.length > n ? '…' : '')
const fmtDate  = d => d ? d.toLocaleString() : ''

function isCommitShape (v) {
  return v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.message === 'string' && v.date instanceof Date &&
    typeof v.dataAddress === 'number'
}

function safeJSON (value) {
  return JSON.stringify(value, (_, v) => {
    if (v instanceof Uint8Array) return `Uint8Array(${v.length})`
    if (v instanceof Date) return v.toISOString()
    return v
  }, 2)
}

// Walk every chunk newest-to-oldest. Each chunk's address is the index of
// its last byte; the next chunk back ends at addr - chunk.length.
//
// `kind` distinguishes commits and signatures (the things you usually
// browse) from "other" chunks (Duples, raw OBJECTs, ARRAYs, STRINGs, etc.
// — the storage-level building blocks). The repo view shows all three
// in separate sections.
function * repoEntries (repo) {
  const len = repo.byteLength
  if (len <= 0) return
  let addr = len - 1
  while (addr >= 0) {
    const code = repo.resolve(addr)
    if (!code || !code.length) return
    const type = repo.footerToCodec[code.at(-1)]?.type
    if (type === 'SIGNATURE') {
      let sig
      try { sig = repo.decode(addr) } catch { sig = null }
      if (sig) {
        yield {
          kind: 'signature',
          address: addr,
          signedFrom: sig.address,
          signedTo: addr - code.length,
          chunkStart: addr - code.length + 1,
          hex: truncHex(sig.compactRawBytes, 12),
          codecType: type
        }
      }
    } else if (type === 'OBJECT') {
      let value
      try { value = repo.decode(addr) } catch { value = null }
      if (isCommitShape(value)) {
        yield { kind: 'commit', address: addr, message: value.message, date: value.date, dataAddress: value.dataAddress, parent: value.parent, codecType: type }
      } else {
        yield { kind: 'other', address: addr, codecType: type }
      }
    } else {
      // Anything else — Duples, ARRAYs, STRINGs, etc. — is "other": part of
      // the storage tree but not a thing a user normally browses.
      yield { kind: 'other', address: addr, codecType: type }
    }
    addr -= code.length
  }
}

// Decode the value at an address but treat object/array as REFS (children
// are addresses, not decoded recursively). For primitives, returns the
// decoded value directly.
function valueAndChildren (repo, address) {
  const code = repo.resolve(address)
  const codecType = repo.footerToCodec[code.at(-1)]?.type
  const refs = repo.asRefs(address)
  // refs is either an object/array of addresses or just the address itself for primitives
  return { codecType, refs, decoded: repo.decode(address) }
}

// ── Views ─────────────────────────────────────────────────────────────────

function RegistryView () {
  return h`
    <h2>repos <span class="dim">${() => { dep(); return `(${[...registry].length})` }}</span></h2>
    ${() => {
      dep()
      const rows = []
      for (const [keyHex, repo] of registry) {
        const last = repo.lastCommit
        rows.push(h`
          <div class="row" data-key=${keyHex} data-action="open-repo">
            <span class="mono">${truncKey(keyHex)}</span>
            <span class="when">${last ? fmtDate(last.date) : '(no commits)'}</span>
            <span class="msg dim">${last?.message || ''}</span>
          </div>
        `)
      }
      return rows.length ? rows : h`<div class="empty">waiting for repos…</div>`
    }}
  `
}

function RepoView ({ keyHex }) {
  return h`
    <a class="back" data-action="back-registry">← all repos</a>
    <div class="keyfull"><span class="mono">${keyHex}</span></div>
    ${() => {
      dep()
      const repo = registry.get(keyHex)
      if (!repo) return h`<div class="empty">opening…</div>`
      const entries = [...repoEntries(repo)]
      if (!entries.length) {
        return h`
          <h2>chunks <span class="dim">(0)</span></h2>
          <div class="empty">no signed commits yet</div>
        `
      }
      const commits = entries.filter(e => e.kind === 'commit')
      const sigs = entries.filter(e => e.kind === 'signature')
      const others = entries.filter(e => e.kind === 'other')
      return h`
        <h2>chunks <span class="dim">(${commits.length} commit${commits.length === 1 ? '' : 's'} · ${sigs.length} sig${sigs.length === 1 ? '' : 's'} · ${others.length} other)</span></h2>
        ${[...commits, ...sigs].map(e => e.kind === 'commit'
          ? h`
            <div class="row commit" data-key=${`c${e.address}`} data-action="open-at"
                 data-keyhex=${keyHex} data-addr=${e.address}>
              <span class="kind">commit</span>
              <span class="msg">${e.message || h`<span class="dim">(no message)</span>`}</span>
              <span class="when">${fmtDate(e.date)}</span>
              <span class="mono dim">@${e.address}</span>
            </div>`
          : h`
            <div class="row signature" data-key=${`s${e.address}`} data-action="open-at"
                 data-keyhex=${keyHex} data-addr=${e.address}>
              <span class="kind">sig ${() => { dep(); return verifyBadge(verifyStatus(repo, keyHex, repo.decode(e.address), e.address)) }}</span>
              <span class="mono dim">covers @${e.signedFrom}…@${e.signedTo}</span>
              <span class="mono dim">${e.hex}</span>
              <span class="mono dim">@${e.address}</span>
            </div>`
        )}
        ${others.length ? h`
          <h3>storage tree <span class="dim">(${others.length})</span></h3>
          <div class="dim" style="margin-bottom: 0.5rem;">the chunks underneath — Duples balance the tree, OBJECTs/ARRAYs/STRINGs hold the leaves. click to inspect.</div>
          <table class="kv clickable">
            <tbody>
              ${others.map(e => h`
                <tr data-key=${`o${e.address}`} data-action="open-at"
                    data-keyhex=${keyHex} data-addr=${e.address}>
                  <td class="mono dim">${e.codecType}</td>
                  <td>${(() => { try { return previewValue(repo.decode(e.address)) } catch { return '' } })()}</td>
                  <td class="mono dim">@${e.address}</td>
                </tr>
              `)}
            </tbody>
          </table>
        ` : null}
      `
    }}
  `
}

function AtView ({ keyHex, address }) {
  return h`
    <a class="back" data-action="back-registry">← all repos</a>
    <div class="keyfull">
      <a class="repo-link" data-action="back-repo" data-keyhex=${keyHex}>${truncKey(keyHex)}</a>
      <span class="dim"> @ ${address}</span>
    </div>
    ${() => {
      dep()
      const repo = registry.get(keyHex)
      if (!repo) return h`<div class="empty">opening…</div>`
      if (address >= repo.byteLength) return h`<div class="empty">loading…</div>`

      let info
      try { info = valueAndChildren(repo, address) }
      catch (e) { return h`<pre class="value">decode error: ${e.message}</pre>` }

      const { codecType, refs, decoded } = info
      const isCommit = isCommitShape(decoded)

      // For commits, render the rich commit panel + changed paths.
      if (isCommit) {
        const parentDataAddr = decoded.parent !== undefined
          ? safeGet(() => repo.decode(decoded.parent)?.dataAddress)
          : undefined
        const changes = parentDataAddr !== undefined
          ? [...changedPaths(repo, parentDataAddr, decoded.dataAddress)]
          : null
        return h`
          <div class="dim">codec: ${codecType} · this is a commit</div>
          <table class="kv">
            <tbody>
              <tr><td>message</td><td>${decoded.message || h`<span class="dim">(empty)</span>`}</td></tr>
              <tr><td>date</td><td>${fmtDate(decoded.date)}</td></tr>
              <tr>
                <td>dataAddress</td>
                <td><a class="addr-link" data-action="open-at"
                       data-keyhex=${keyHex} data-addr=${decoded.dataAddress}
                       >@${decoded.dataAddress}</a></td>
              </tr>
              <tr>
                <td>parent</td>
                <td>${decoded.parent === undefined
                  ? h`<span class="dim">(none — first commit)</span>`
                  : h`<a class="addr-link" data-action="open-at"
                         data-keyhex=${keyHex} data-addr=${decoded.parent}
                         >@${decoded.parent}</a>`}</td>
              </tr>
            </tbody>
          </table>
          ${changes
            ? h`
              <h3>changed paths <span class="dim">(${changes.length})</span></h3>
              ${changes.length
                ? h`<ul class="paths">${changes.map(p => h`<li class="mono">${p.length === 0 ? '/' : p.join('.')}</li>`)}</ul>`
                : h`<div class="dim">(no path-level changes — same dataAddress)</div>`}
            `
            : null}
          <h3>rehydrated</h3>
          <pre class="value">${safeJSON(decoded)}</pre>
          ${rawChunkSection(repo, address)}
          ${() => { dep(); return referrersSection(repo, keyHex, address) }}
        `
      }

      // Duple: explain what this tree-node IS, then show its two children.
      if (codecType === 'DUPLE') {
        return h`
          <div class="dim">codec: DUPLE</div>
          <p class="explainer">
            A <strong>Duple</strong> is a 2-tuple — the building block streamo uses
            to balance binary trees of OBJECT entries and ARRAY elements. Each Duple
            holds two slots; the slots are either values (a leaf) or other Duples
            (an interior tree node). They're how content-addressing scales to
            larger objects/arrays without rewriting the whole structure on every
            small change — siblings keep their addresses, and dedup happens at
            every level of the tree.
          </p>
          <table class="kv">
            <tbody>
              <tr><td class="mono">v[0]</td><td>${previewValue(decoded.v[0])}</td></tr>
              <tr><td class="mono">v[1]</td><td>${previewValue(decoded.v[1])}</td></tr>
            </tbody>
          </table>
          ${rawChunkSection(repo, address)}
          ${() => { dep(); return referrersSection(repo, keyHex, address) }}
        `
      }

      // Signature: dedicated layout.
      if (codecType === 'SIGNATURE') {
        const chunk = repo.resolve(address)
        const chunkLen = chunk.length
        const signedTo = address - chunkLen          // last byte covered (inclusive)
        const sigChunkStart = address - chunkLen + 1 // first byte of the sig chunk
        return h`
          <div class="dim">codec: ${codecType}</div>
          <table class="kv">
            <tbody>
              <tr>
                <td>verification</td>
                <td>${() => {
                  dep()  // wake up when fire() runs after async verify resolves
                  const status = verifyStatus(repo, keyHex, decoded, address)
                  const label = status === 'valid'   ? 'valid signature for this repo’s public key'
                              : status === 'invalid' ? 'signature does NOT match this repo’s public key'
                              : status === 'pending' ? 'verifying…'
                              : `error: ${status?.error ?? 'unknown'}`
                  return h`${verifyBadge(status)} <span>${label}</span>`
                }}</td>
              </tr>
              <tr>
                <td>covers</td>
                <td><a class="addr-link" data-action="open-at"
                       data-keyhex=${keyHex} data-addr=${decoded.address}
                       >@${decoded.address}</a> through @${signedTo} (${signedTo - decoded.address + 1} bytes)</td>
              </tr>
              <tr>
                <td>sig chunk</td>
                <td class="mono">@${sigChunkStart}…@${address} (${chunkLen} bytes)</td>
              </tr>
              <tr><td>bytes</td><td class="mono">${truncHex(decoded.compactRawBytes, 32)}</td></tr>
            </tbody>
          </table>
          ${rawChunkSection(repo, address)}
          ${() => { dep(); return referrersSection(repo, keyHex, address) }}
        `
      }

      // Object/array: clickable children with their addresses.
      if (refs && typeof refs === 'object') {
        const isArray = Array.isArray(refs)
        const entries = isArray
          ? refs.map((addr, i) => [String(i), addr])
          : Object.entries(refs)
        if (entries.length === 0) {
          return h`
            <div class="dim">codec: ${codecType}</div>
            <div class="empty">${isArray ? '[]' : '{}'}</div>
            ${rawChunkSection(repo, address)}
          `
        }
        return h`
          <div class="dim">codec: ${codecType}${isArray ? ` · length ${entries.length}` : ''}</div>
          <table class="kv clickable">
            <tbody>
              ${entries.map(([k, childAddr]) => {
                // asRefs is mutation-impossible, so it returns undefined for
                // inline children that don't have a separate chunk address.
                // Show those non-clickably with the decoded value pulled from
                // the parent.
                if (childAddr === undefined) {
                  const inlineValue = isArray ? decoded[+k] : decoded[k]
                  return h`
                    <tr>
                      <td class="mono">${k}</td>
                      <td>${previewValue(inlineValue)}</td>
                      <td class="dim">(inline)</td>
                    </tr>
                  `
                }
                let preview = ''
                try { preview = previewValue(repo.decode(childAddr)) }
                catch { preview = '(error)' }
                return h`
                  <tr data-key=${k} data-action="open-at"
                      data-keyhex=${keyHex} data-addr=${childAddr}>
                    <td class="mono">${k}</td>
                    <td>${preview}</td>
                    <td class="mono dim">@${childAddr}</td>
                  </tr>
                `
              })}
            </tbody>
          </table>
          <h3>rehydrated</h3>
          <pre class="value">${safeJSON(decoded)}</pre>
          ${rawChunkSection(repo, address)}
          ${() => { dep(); return referrersSection(repo, keyHex, address) }}
        `
      }

      // Primitive: just show it.
      return h`
        <div class="dim">codec: ${codecType}</div>
        <pre class="value">${safeJSON(decoded)}</pre>
        ${rawChunkSection(repo, address)}
        ${() => { dep(); return referrersSection(repo, keyHex, address) }}
      `
    }}
  `
}

// Hex dump of the chunk at this address — the actual bytes that live in the
// streamo for this value. For commits we also include this so you can see
// the literal commit-record bytes.
function rawChunkSection (repo, address) {
  let bytes
  try { bytes = repo.resolve(address) }
  catch { return null }
  if (!bytes || !bytes.length) return null
  return h`
    <h3>chunk bytes <span class="dim">(${bytes.length} bytes ending @${address})</span></h3>
    <pre class="value mono">${hexDump(bytes)}</pre>
  `
}

// "Referenced by" — walks up the Duple tree-scaffolding to find the chunks
// that USE this address in a user-meaningful sense (OBJECT, ARRAY, VARIABLE,
// SIGNATURE, etc.). Internal Duples are skipped — they're how the codec
// builds balanced trees, not where the user thinks about the data living.
//
// Each row shows: codec, a one-line preview of the value, the address, and
// — if more than one Duple path leads to the same ancestor — a path count.
function referrersSection (repo, keyHex, address) {
  const index = buildReferrerIndex(repo)
  const refs = findUserReferrers(repo, address, index)
  if (!refs.length) {
    return h`
      <h3>referenced by <span class="dim">(0)</span></h3>
      <div class="dim">no chunks in this repo reference this value</div>
    `
  }
  return h`
    <h3>referenced by <span class="dim">(${refs.length} ${refs.length === 1 ? 'place' : 'places'})</span></h3>
    <table class="kv clickable">
      <tbody>
        ${refs.map(r => {
          let preview = ''
          try { preview = previewValue(repo.decode(r.address)) }
          catch { preview = '(error)' }
          return h`
            <tr data-key=${`r${r.address}`} data-action="open-at"
                data-keyhex=${keyHex} data-addr=${r.address}>
              <td class="mono dim">${r.codecType || '?'}${r.count > 1 ? ` ×${r.count}` : ''}</td>
              <td>${preview}</td>
              <td class="mono dim">@${r.address}</td>
            </tr>
          `
        })}
      </tbody>
    </table>
  `
}

// Detect a Duple instance — codecs.js doesn't export the class so we have to
// duck-type. A Duple is an object whose only own property is `v`, a length-2
// array. (Used so we can render Duples as `[a, b]` rather than `{…} (1)`.)
function isDuple (v) {
  return v && typeof v === 'object' && Array.isArray(v.v) && v.v.length === 2 && Object.keys(v).length === 1
}

function previewValue (v, depth = 0) {
  if (v == null) return String(v)
  if (typeof v === 'string') return v.length > 60 ? JSON.stringify(v.slice(0, 60)) + '…' : JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`
  if (isDuple(v)) {
    if (depth > 2) return 'Duple(…)'
    return `Duple(${previewValue(v.v[0], depth + 1)}, ${previewValue(v.v[1], depth + 1)})`
  }
  if (Array.isArray(v)) return `[…] (${v.length})`
  if (typeof v === 'object') return `{…} (${Object.keys(v).length})`
  return String(v)
}

function safeGet (f) { try { return f() } catch { return undefined } }

// Build a child→parents index for the entire repo in one pass, so we can
// answer "who references address X?" in O(1) per query and walk up parent
// chains without re-scanning. Each entry maps a chunk's address to all the
// chunks that have it as a DIRECT child (via asRefs).
function buildReferrerIndex (repo) {
  const index = new Map() // childAddr → [{ address, codecType }]
  let addr = repo.byteLength - 1
  while (addr >= 0) {
    const code = repo.resolve(addr)
    if (!code || !code.length) break
    let refs
    try { refs = repo.asRefs(addr) } catch { refs = null }
    let childAddrs = []
    if (Array.isArray(refs)) {
      childAddrs = refs.filter(x => typeof x === 'number')
    } else if (refs && typeof refs === 'object') {
      if (Array.isArray(refs.v)) childAddrs = refs.v.filter(x => typeof x === 'number')
      else childAddrs = Object.values(refs).filter(x => typeof x === 'number')
    }
    if (childAddrs.length) {
      const codec = repo.footerToCodec[code.at(-1)]
      const entry = { address: addr, codecType: codec?.type }
      for (const child of childAddrs) {
        if (!index.has(child)) index.set(child, [])
        index.get(child).push(entry)
      }
    }
    addr -= code.length
  }
  return index
}

// Walk up parent chains via the index. Internal Duple nodes are tree
// scaffolding — the user-meaningful containers are OBJECT / ARRAY /
// VARIABLE / SIGNATURE / etc. For each path that hits a non-Duple
// ancestor, accumulate that ancestor with a count of how many paths
// reach it. (Same value referenced from N different places yields N
// distinct user-level ancestors.)
function findUserReferrers (repo, targetAddr, index) {
  const result = new Map() // ancestorAddr → { address, codecType, count }
  function walkUp (from) {
    const refs = index.get(from) ?? []
    for (const r of refs) {
      if (r.codecType === 'DUPLE') {
        walkUp(r.address)
      } else {
        const existing = result.get(r.address)
        if (existing) existing.count++
        else result.set(r.address, { ...r, count: 1 })
      }
    }
  }
  walkUp(targetAddr)
  return [...result.values()].sort((a, b) => b.address - a.address) // newest first
}

// Backwards-compat: if anyone wanted the raw direct referrers (Duples and
// all), this still works.
function findReferrers (repo, targetAddr) {
  return buildReferrerIndex(repo).get(targetAddr) ?? []
}

// ── Signature verification cache ──────────────────────────────────────────
//
// repo.verify(sig, publicKey) is async. Slots render synchronously, so we
// cache results keyed by (keyHex, sigChunkAddress) and kick off the async
// verify on first encounter. When it resolves, fire() so the slot re-runs
// and the badge flips from "verifying…" to ✓ / ✗.
//
// One verify per signature per page load (~sub-ms each for secp256k1).

const verifyCache = new Map()  // `${keyHex}:${addr}` → 'pending' | 'valid' | 'invalid' | { error }

function verifyStatus (repo, keyHex, sig, sigAddress) {
  const cacheKey = `${keyHex}:${sigAddress}`
  if (verifyCache.has(cacheKey)) return verifyCache.get(cacheKey)
  verifyCache.set(cacheKey, 'pending')
  repo.verify(sig, hexToBytes(keyHex))
    .then(valid => { verifyCache.set(cacheKey, valid ? 'valid' : 'invalid'); fire() })
    .catch(e => { verifyCache.set(cacheKey, { error: e.message }); fire() })
  return 'pending'
}

function verifyBadge (status) {
  if (status === 'valid')   return h`<span class="verify-badge valid"   title="signature verified against repo's public key">✓</span>`
  if (status === 'invalid') return h`<span class="verify-badge invalid" title="signature does NOT match repo's public key">✗</span>`
  if (status === 'pending') return h`<span class="verify-badge pending" title="verifying…">…</span>`
  return h`<span class="verify-badge error" title=${status?.error || 'verification error'}>⚠</span>`
}

// Hex dump of a chunk's raw bytes. Truncates at maxLen so a giant value
// chunk doesn't blow up the page.
function hexDump (bytes, maxLen = 256) {
  const lines = []
  const len = Math.min(bytes.length, maxLen)
  for (let i = 0; i < len; i += 16) {
    const offset = i.toString(16).padStart(4, '0')
    const slice = bytes.subarray(i, Math.min(i + 16, len))
    const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(slice).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '·').join('')
    lines.push(`${offset}  ${hex.padEnd(48)}  ${ascii}`)
  }
  if (bytes.length > maxLen) lines.push(`…  (${bytes.length - maxLen} more bytes)`)
  return lines.join('\n')
}

// ── Mount ─────────────────────────────────────────────────────────────────

const appEl = document.getElementById('app')

mount(h`${() => {
  dep()
  switch (view.kind) {
    case 'registry': return RegistryView()
    case 'repo':     return RepoView({ keyHex: view.keyHex })
    case 'at':       return AtView({ keyHex: view.keyHex, address: view.address })
    default:         return h`<div class="empty">?</div>`
  }
}}`, appEl, recaller)

// ── Click delegation ──────────────────────────────────────────────────────

appEl.addEventListener('click', e => {
  const el = e.target.closest('[data-action]')
  if (!el) return
  switch (el.dataset.action) {
    case 'open-repo':     return go({ kind: 'repo', keyHex: el.dataset.key })
    case 'open-at':       return go({ kind: 'at', keyHex: el.dataset.keyhex, address: +el.dataset.addr })
    case 'back-registry': return go({ kind: 'registry' })
    case 'back-repo':     return go({ kind: 'repo', keyHex: el.dataset.keyhex })
  }
})
