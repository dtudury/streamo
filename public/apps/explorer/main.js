// streamo explorer — read-only registry / address browser.
//
// Two view kinds, navigated by URL hash:
//   #/                                — registry list
//   #/repo/<keyHex>                   — at HEAD, the most-recent sig
//                                       (symbolic, like git's HEAD ref).
//                                       Shorthand for /at/HEAD.
//   #/repo/<keyHex>/at/HEAD           — same thing, explicit form.
//   #/repo/<keyHex>/at/<address>      — pinned to a specific byte address.
//
// When the resolved chunk is a SIGNATURE, the page is the polished
// signed-commit view (selector dropdown at top, polished detail below,
// storage chunks tucked into a <details>). Otherwise it's storage
// drilling — value/storage tabs for that chunk, no selector.
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
  schedule(() => {
    scheduled = false
    recaller.reportKeyMutation(signal, 'data')
    // After mount has updated the DOM, sync byte-strip viewport indicators
    // and (if appropriate) keep them pinned to HEAD on live updates.
    syncByteStrips()
  })
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
  const m = (location.hash || '#/').match(/^#\/repo\/([0-9a-f]+)(?:\/at\/(HEAD|\d+))?\/?$/i)
  if (!m) return { kind: 'registry' }
  // Bare `/repo/<hex>` is shorthand for `/at/HEAD` — the symbolic pointer
  // to the most recent signed commit (like git's HEAD).
  const raw = m[2]
  const address = raw == null || raw.toUpperCase() === 'HEAD' ? 'HEAD' : +raw
  return { kind: 'at', keyHex: m[1], address }
}

function hashFromView (v) {
  if (v.kind !== 'at') return '#/'
  // Canonical form for HEAD is the bare URL — concise and analogous to
  // tools that imply HEAD when no ref is given.
  if (v.address === 'HEAD') return `#/repo/${v.keyHex}`
  return `#/repo/${v.keyHex}/at/${v.address}`
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

// At-view tab state — persists across at-view navigations so a user who
// wants to keep a "storage" lens on doesn't have to re-click after every
// drill-down. Reset to default on registry/repo views (set in go()).
let atTab = 'value'

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

// Walk every chunk newest-to-oldest, bundling each signature with the
// commit(s) it covers into one "signed commit" entry. A signed commit is
// the natural unit of authored history — the sig is what makes the bytes
// provably yours, and the commit gives those bytes meaning, so they read
// as one thing. Concurrent commits batched into one sign produce a single
// entry whose .commits is multi-element.
//
// Commits more recent than the latest sig (sign in flight, or none yet)
// surface as 'unsignedCommit'. Everything else — Duples, OBJECTs that
// aren't commits, ARRAYs, STRINGs, etc. — is 'other' and lives in the
// storage section.
function * signedCommits (repo) {
  const len = repo.byteLength
  if (len <= 0) return
  let addr = len - 1
  let pendingSig = null   // most-recent sig still gathering its commits
  let pendingCommits = [] // commits since the last yielded sig (newest first)

  const flush = () => {
    if (pendingSig) return [{ kind: 'signedCommit', ...pendingSig, commits: pendingCommits }]
    return pendingCommits.map(c => ({ kind: 'unsignedCommit', ...c }))
  }

  while (addr >= 0) {
    const code = repo.resolve(addr)
    if (!code || !code.length) break
    const type = repo.footerToCodec[code.at(-1)]?.type

    if (type === 'SIGNATURE') {
      for (const e of flush()) yield e
      let sig
      try { sig = repo.decode(addr) } catch { sig = null }
      pendingSig = sig
        ? {
            sigAddress: addr,
            signedFrom: sig.address,
            signedTo: addr - code.length,
            sigHex: truncHex(sig.compactRawBytes, 12)
          }
        : null
      pendingCommits = []
    } else if (type === 'OBJECT') {
      let value
      try { value = repo.decode(addr) } catch { value = null }
      if (isCommitShape(value)) {
        pendingCommits.push({
          address: addr,
          message: value.message,
          date: value.date,
          dataAddress: value.dataAddress,
          parent: value.parent
        })
      } else {
        yield { kind: 'other', address: addr, codecType: type }
      }
    } else {
      yield { kind: 'other', address: addr, codecType: type }
    }
    addr -= code.length
  }
  for (const e of flush()) yield e
}

// The polished "signed commit" detail view — the verify banner, the
// covered message(s), and the rehydrated value at HEAD. Shared between
// the repo view (rendered for the currently-selected commit, below the
// commit selector) and the at-view's SIGNATURE branch (when you've
// drilled into a sig directly).
function signedCommitDetail (repo, keyHex, sigAddress) {
  let decoded
  try { decoded = repo.decode(sigAddress) } catch { return h`<div class="empty">decode error</div>` }
  const chunk = repo.resolve(sigAddress)
  const chunkLen = chunk.length
  const signedTo = sigAddress - chunkLen
  const sigChunkStart = sigAddress - chunkLen + 1
  const covered = commitsCoveredBySignature(repo, decoded.address, signedTo)
  const head = covered[0]
  return h`
    <div class="signed-commit-banner">
      <span class="signed-label">signed commit</span>
      ${() => {
        dep()
        const status = verifyStatus(repo, keyHex, decoded, sigAddress)
        const label = status === 'valid'   ? 'verified — bytes match this repo’s public key'
                    : status === 'invalid' ? 'NOT VERIFIED — bytes do not match the repo key'
                    : status === 'pending' ? 'verifying…'
                    : `error: ${status?.error ?? 'unknown'}`
        return h`${verifyBadge(status)} <span class="dim">${label}</span>`
      }}
    </div>
    ${covered.length === 0
      ? h`<div class="empty">this signature covers no commits (would only happen if a sign produced over a non-commit range)</div>`
      : h`
        <h3>${covered.length === 1 ? 'message' : `${covered.length} messages (batched into one signature)`}</h3>
        ${covered.map(c => h`
          <div class="commit-card" data-key=${`cc${c.address}`}>
            <div class="commit-msg">${c.message || h`<span class="dim">(no message)</span>`}</div>
            <div class="commit-meta dim">
              <span>${fmtDate(c.date)}</span>
              <span> · commit chunk <a class="addr-link" data-action="open-at" data-keyhex=${keyHex} data-addr=${c.address}>@${c.address}</a></span>
              <span> · value <a class="addr-link" data-action="open-at" data-keyhex=${keyHex} data-addr=${c.dataAddress}>@${c.dataAddress}</a></span>
            </div>
          </div>
        `)}
        ${head ? (() => {
          let value
          try { value = repo.decode(head.dataAddress) } catch { value = undefined }
          return h`
            <h3>value at this point</h3>
            <pre class="value">${value === undefined ? '(decode error)' : safeJSON(value)}</pre>
          `
        })() : null}
      `}
    <h3>signature</h3>
    <table class="kv">
      <tbody>
        <tr>
          <td>covers</td>
          <td><a class="addr-link" data-action="open-at"
                 data-keyhex=${keyHex} data-addr=${decoded.address}
                 >@${decoded.address}</a> through @${signedTo} (${signedTo - decoded.address + 1} bytes)</td>
        </tr>
        <tr>
          <td>sig chunk</td>
          <td class="mono">@${sigChunkStart}…@${sigAddress} (${chunkLen} bytes)</td>
        </tr>
        <tr><td>bytes</td><td class="mono">${truncHex(decoded.compactRawBytes, 32)}</td></tr>
      </tbody>
    </table>
  `
}

// Find the commits (newest-first) covered by a particular signature. Used
// by the at-view's SIGNATURE branch to assemble the "this is what you were
// looking for" polished view from a sig address alone.
function commitsCoveredBySignature (repo, signedFrom, signedTo) {
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

// Resolve the symbolic HEAD address to the most-recent sig chunk's
// address. Returns undefined if the repo has no signatures yet.
function resolveHead (repo) {
  let walk = repo.byteLength - 1
  while (walk >= 0) {
    const code = repo.resolve(walk)
    if (!code || !code.length) break
    if (repo.footerToCodec[code.at(-1)]?.type === 'SIGNATURE') return walk
    walk -= code.length
  }
  return undefined
}

// Commit selector dropdown — used at the top of any sig at-view. The
// summary is the currently-selected (= currently-viewed) signed commit
// styled as a head-card; the body lists every signed commit with the
// current one marked. Picking a different one (data-action=select-commit)
// navigates to /at/<sigAddress> via the URL.
function commitSelectorSection (repo, keyHex, currentSigAddr) {
  const entries = [...signedCommits(repo)].filter(e => e.kind === 'signedCommit')
  if (!entries.length) return null
  const tagFor = i => i === 0 ? 'HEAD' : `HEAD-${i}`
  const signedRow = (e, tag, { asSummary = false, isSelected = false } = {}) => {
    const c0 = e.commits[0]
    const headline = e.commits.length === 0
      ? h`<span class="dim">(sig with no covered commits)</span>`
      : e.commits.length === 1
        ? (c0.message || h`<span class="dim">(no message)</span>`)
        : h`<span class="dim">${e.commits.length}× </span>${c0?.message || ''}`
    const cls = ['row', 'signed-commit',
      asSummary ? 'head-card' : null,
      isSelected ? 'selected' : null]
    const action = asSummary ? null : 'select-commit'
    return h`
      <div class=${cls}
           data-key=${`sc${e.sigAddress}`}
           data-action=${action}
           data-keyhex=${keyHex} data-addr=${e.sigAddress}>
        <span class="kind">${tag} ${() => { dep(); return verifyBadge(verifyStatus(repo, keyHex, repo.decode(e.sigAddress), e.sigAddress)) }}</span>
        <span class="msg">${headline}</span>
        <span class="when">${c0 ? fmtDate(c0.date) : ''}</span>
        <span class="mono dim">@${e.sigAddress}</span>
      </div>`
  }
  const selectedIdx = entries.findIndex(e => e.sigAddress === currentSigAddr)
  const selected = selectedIdx >= 0 ? entries[selectedIdx] : entries[0]
  return h`
    <details class="commit-selector" data-key=${`selector-${keyHex}`}>
      <summary>${signedRow(selected, tagFor(selectedIdx >= 0 ? selectedIdx : 0), { asSummary: true })}</summary>
      ${entries.length > 1 ? h`
        <div class="dropdown-body">
          ${entries.map((e, i) => signedRow(e, tagFor(i), { isSelected: e === selected }))}
        </div>
      ` : null}
    </details>
  `
}

// Unsigned commits + the repo-wide "other storage chunks" list. Shown
// below the polished detail on sig at-views and on the no-HEAD page,
// so the repo's full inventory is always one click away.
function repoExtras (repo, keyHex) {
  const entries = [...signedCommits(repo)]
  const unsigned = entries.filter(e => e.kind === 'unsignedCommit')
  const others = entries.filter(e => e.kind === 'other')
  return h`
    ${unsigned.length ? h`
      <h3>unsigned <span class="dim">(${unsigned.length} — sign in flight or pending)</span></h3>
      ${unsigned.map(e => h`
        <div class="row unsigned-commit" data-key=${`u${e.address}`} data-action="open-at"
             data-keyhex=${keyHex} data-addr=${e.address}>
          <span class="kind">unsigned</span>
          <span class="msg">${e.message || h`<span class="dim">(no message)</span>`}</span>
          <span class="when">${fmtDate(e.date)}</span>
          <span class="mono dim">@${e.address}</span>
        </div>
      `)}
    ` : null}
    ${others.length ? h`
      <details class="other-storage">
        <summary>storage chunks <span class="dim">(${others.length}) — the chunks underneath</span></summary>
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
      </details>
    ` : null}
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

      // Resolve HEAD (symbolic) to the most-recent sig address. If the
      // repo has no sigs yet, render a useful "no HEAD" page that still
      // surfaces unsigned commits and storage chunks.
      let resolvedAddr = address
      if (address === 'HEAD') {
        resolvedAddr = resolveHead(repo)
        if (resolvedAddr === undefined) {
          return h`
            <h2>at HEAD <span class="dim">(no signed commits yet)</span></h2>
            <div class="empty">this repo hasn't signed anything yet — once it does, HEAD will point to the most-recent signed commit and you'll land here automatically.</div>
            ${repoExtras(repo, keyHex)}
          `
        }
      }
      if (resolvedAddr >= repo.byteLength) return h`<div class="empty">loading…</div>`

      let info
      try { info = valueAndChildren(repo, resolvedAddr) }
      catch (e) { return h`<pre class="value">decode error: ${e.message}</pre>` }

      const { codecType, refs, decoded } = info
      const isCommit = isCommitShape(decoded)
      const isSig = codecType === 'SIGNATURE'

      // Tabs are part of the page content (not the static header) so a
      // sig at-view can render the commit selector ABOVE the tabs.
      const tabs = h`
        <nav class="tabs">
          <a class=${() => { dep(); return ['tab', atTab === 'value' ? 'active' : null] }}
             data-action="set-tab" data-tab="value">value</a>
          <a class=${() => { dep(); return ['tab', atTab === 'storage' ? 'active' : null] }}
             data-action="set-tab" data-tab="storage">storage</a>
        </nav>
      `
      const selector = isSig ? commitSelectorSection(repo, keyHex, resolvedAddr) : null

      // Storage tab: spatial view of where this chunk lives in the byte
      // stream + outgoing references + this chunk's bytes + incoming
      // referrers. The chunk graph from this chunk's perspective.
      if (atTab === 'storage') {
        return h`
          ${selector}
          ${tabs}
          ${byteStreamSection(repo, keyHex, resolvedAddr)}
          ${outgoingReferencesSection(repo, keyHex, resolvedAddr)}
          ${rawChunkSection(repo, resolvedAddr)}
          ${referrersSection(repo, keyHex, resolvedAddr)}
        `
      }

      // Value tab — branches by codec.
      if (isCommit) {
        const parentDataAddr = decoded.parent !== undefined
          ? safeGet(() => repo.decode(decoded.parent)?.dataAddress)
          : undefined
        const changes = parentDataAddr !== undefined
          ? [...changedPaths(repo, parentDataAddr, decoded.dataAddress)]
          : null
        return h`
          ${tabs}
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
        `
      }

      // Duple: explain what this tree-node IS, then show its two children.
      if (codecType === 'DUPLE') {
        return h`
          ${tabs}
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
        `
      }

      // Signature: the polished "signed commit" view + the unsigned/storage
      // listing below. Shared with the storage tab's chunk-detail view.
      if (isSig) {
        return h`
          ${selector}
          ${tabs}
          ${signedCommitDetail(repo, keyHex, resolvedAddr)}
          ${repoExtras(repo, keyHex)}
          <div class="dim" style="margin-top: 0.5rem;">switch to the <strong>storage</strong> tab above to see the raw chunk bytes, outgoing references, and what else points at this address.</div>
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
            ${tabs}
            <div class="dim">codec: ${codecType}</div>
            <div class="empty">${isArray ? '[]' : '{}'}</div>
          `
        }
        return h`
          ${tabs}
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
        `
      }

      // Primitive: just show it.
      return h`
        ${tabs}
        <div class="dim">codec: ${codecType}</div>
        <pre class="value">${safeJSON(decoded)}</pre>
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

// Map a codec type to a visual category. Many distinct codecs map to a
// shared category so the byte-stream stripe stays readable: commits (the
// narrative anchors), signatures (attestations), composite values, the
// Duple tree-scaffolding, strings, bytes, numbers, etc.
function codecCategory (type) {
  switch (type) {
    case 'SIGNATURE': return 'sig'
    case 'OBJECT': case 'EMPTY_OBJECT': case 'ARRAY': case 'EMPTY_ARRAY': return 'composite'
    case 'DUPLE': return 'duple'
    case 'STRING': case 'EMPTY_STRING': return 'string'
    case 'WORD': case 'UINT8ARRAY': case 'EMPTY_UINT8ARRAY': return 'bytes'
    case 'DATE': case 'FLOAT64': case 'UINT7': return 'num'
    case 'VARIABLE': return 'var'
    default: return 'other'
  }
}

// Byte stream as a color-coded SVG strip — every chunk is a rect, color
// coded by codec category. Modestly zoomed so even 1-byte chunks have a
// clickable width; horizontally scrollable, click-drag-to-pan inside the
// strip (cursor: grab/grabbing). First render auto-scrolls to HEAD (the
// newest content, at the right) and stays pinned there if you haven't
// dragged off it — so a live stream "follows" the newest activity. The
// signed-commits dropdown above is for jumping to a known commit; this
// strip is for poking around between them.
function byteStreamSection (repo, keyHex, currentAddress) {
  const chunks = []
  let addr = repo.byteLength - 1
  while (addr >= 0) {
    const code = repo.resolve(addr)
    if (!code || !code.length) break
    const codec = repo.footerToCodec[code.at(-1)]
    chunks.unshift({
      address: addr,
      start: addr - code.length + 1,
      length: code.length,
      codecType: codec?.type || '?'
    })
    addr -= code.length
  }
  if (!chunks.length) return null

  // Mark commit addresses by walking history once — cheap, lets commits
  // appear as their own visual category instead of getting lumped in with
  // generic OBJECTs.
  const commitAddrs = new Set()
  let walkAddr = repo.valueAddress
  while (walkAddr !== undefined && walkAddr >= 0) {
    let commit
    try { commit = repo.decode(walkAddr) } catch { break }
    if (!commit || typeof commit.message !== 'string' || !(commit.date instanceof Date)) break
    commitAddrs.add(walkAddr)
    walkAddr = commit.parent
  }

  const total = repo.byteLength
  // Each chunk gets max(MIN_PX, proportional zoomed width). At ZOOM=2 the
  // strip is roughly 2x viewport-wide for typical repos — enough to
  // scroll/drag through without losing spatial sense, and MIN_PX keeps
  // even 1-byte chunks clickable.
  const ZOOM = 2
  const MIN_PX = 8
  const H = 36
  const zoomedW = 1200 * ZOOM
  let cursorX = 0
  const layout = chunks.map(c => {
    const propW = (c.length / total) * zoomedW
    const w = Math.max(MIN_PX, propW)
    const item = { ...c, x: cursorX, w }
    cursorX += w
    return item
  })
  const stripW = cursorX
  return h`
    <h3>byte stream <span class="dim">(${total} bytes · ${chunks.length} chunks)</span></h3>
    <div class="byte-map-legend">
      <span class="cat-commit">commit</span>
      <span class="cat-sig">sig</span>
      <span class="cat-composite">object/array</span>
      <span class="cat-duple">duple</span>
      <span class="cat-string">string</span>
      <span class="cat-bytes">bytes</span>
      <span class="cat-num">num</span>
      <span class="cat-var">var</span>
    </div>
    <div class="byte-strip-container" data-key=${`strip-${keyHex}`}>
      <svg class="byte-map byte-strip" width=${stripW} height=${H} viewBox=${`0 0 ${stripW} ${H}`}>
        ${layout.map(c => {
          const cat = commitAddrs.has(c.address) ? 'commit' : codecCategory(c.codecType)
          const cls = ['chunk', `cat-${cat}`, c.address === currentAddress ? 'current' : null]
          return h`<rect
            class=${cls}
            x=${c.x} y="0" width=${c.w} height=${H}
            data-action="open-at"
            data-keyhex=${keyHex}
            data-addr=${c.address}
          ><title>${c.codecType} @${c.address} (${c.length} bytes)</title></rect>`
        })}
      </svg>
    </div>
  `
}

// Outgoing references — what THIS chunk points to in the chunk graph (as
// opposed to "referenced by", which is what points to this chunk). Walks
// the codec's parts via repo.directReferences. Codec-by-codec — exposes
// the storage chain so e.g. STRING → UINT8ARRAY → DUPLE → DUPLE → … → WORD
// is browsable one click at a time.
function outgoingReferencesSection (repo, keyHex, address) {
  const refs = repo.directReferences(address)
  if (!refs.length) return null
  return h`
    <h3>references <span class="dim">(${refs.length})</span></h3>
    <table class="kv clickable">
      <tbody>
        ${refs.map((childAddr, i) => {
          let codecType = '?'
          let preview = ''
          try {
            const childCode = repo.resolve(childAddr)
            codecType = repo.footerToCodec[childCode.at(-1)]?.type || '?'
            preview = previewValue(repo.decode(childAddr))
          } catch { preview = '(error)' }
          return h`
            <tr data-key=${`out${i}@${childAddr}`} data-action="open-at"
                data-keyhex=${keyHex} data-addr=${childAddr}>
              <td class="mono dim">${codecType}</td>
              <td>${preview}</td>
              <td class="mono dim">@${childAddr}</td>
            </tr>
          `
        })}
      </tbody>
    </table>
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

// Wrap each view in a data-keyed <section> so mount's tag-pool recycling
// doesn't pull stale elements from one view into another. Without this,
// switching from registry to an at-view would recycle the registry's
// <h2> and keep its old text children (patchElement only updates attrs).
// The data-key changes whenever the view's identity changes (kind + the
// params that affect rendering), forcing a fresh mount.
mount(h`${() => {
  dep()
  switch (view.kind) {
    case 'registry': return h`<section class="view" data-key="view-registry">${RegistryView()}</section>`
    case 'at':       return h`<section class="view" data-key=${`view-at-${view.keyHex}-${view.address}`}>${AtView({ keyHex: view.keyHex, address: view.address })}</section>`
    default:         return h`<div class="empty">?</div>`
  }
}}`, appEl, recaller)

// ── Click delegation ──────────────────────────────────────────────────────

let suppressClickUntil = 0
appEl.addEventListener('click', e => {
  // Suppress the click that fires at the end of a drag-to-pan, so dragging
  // doesn't accidentally navigate to a chunk under the pointer when the
  // user releases.
  if (Date.now() < suppressClickUntil) return
  const el = e.target.closest('[data-action]')
  if (!el) return
  switch (el.dataset.action) {
    case 'open-repo':     return go({ kind: 'at', keyHex: el.dataset.key, address: 'HEAD' })
    case 'open-at':       return go({ kind: 'at', keyHex: el.dataset.keyhex, address: +el.dataset.addr })
    case 'back-registry': return go({ kind: 'registry' })
    case 'back-repo':     return go({ kind: 'at', keyHex: el.dataset.keyhex, address: 'HEAD' })
    case 'set-tab':       atTab = el.dataset.tab; return fire()
    case 'select-commit': {
      // Picking a commit is just navigation — go to /at/<sigAddress>.
      // Close the dropdown imperatively so the new view renders with
      // the selector collapsed (matches native <select> behavior).
      el.closest('details.commit-selector')?.removeAttribute('open')
      return go({ kind: 'at', keyHex: el.dataset.keyhex, address: +el.dataset.addr })
    }
  }
})

// ── Byte-strip drag-to-pan + auto-scroll-to-HEAD ─────────────────────────

// On first render of a strip, scroll to the right edge (HEAD = newest
// content). On subsequent renders, only re-pin if the user is already at
// or near the right edge — so a live stream "follows" without dragging
// you back if you've scrolled into history.
function syncByteStrips () {
  for (const container of appEl.querySelectorAll('.byte-strip-container')) {
    const visible = container.clientWidth || 1
    const atRight = container.scrollLeft + visible >= container.scrollWidth - 8
    if (!container.dataset.pinned || atRight) {
      container.dataset.pinned = '1'
      container.scrollLeft = container.scrollWidth
    }
  }
}

// Click-drag-to-pan inside the detail strip. Threshold of 4px before
// treating a pointerdown as a drag — under that, fall through to the
// regular click handler so chunk-clicks still navigate.
let dragState = null
appEl.addEventListener('pointerdown', e => {
  if (e.button !== undefined && e.button !== 0) return
  const container = e.target?.closest?.('.byte-strip-container')
  if (!container) return
  dragState = {
    container,
    pointerId: e.pointerId,
    startX: e.clientX,
    startScroll: container.scrollLeft,
    dragging: false
  }
})
appEl.addEventListener('pointermove', e => {
  if (!dragState || e.pointerId !== dragState.pointerId) return
  const dx = e.clientX - dragState.startX
  if (!dragState.dragging) {
    if (Math.abs(dx) < 4) return
    dragState.dragging = true
    dragState.container.classList.add('dragging')
    try { dragState.container.setPointerCapture(e.pointerId) } catch {}
  }
  dragState.container.scrollLeft = dragState.startScroll - dx
  e.preventDefault()
})
function endDrag () {
  if (!dragState) return
  if (dragState.dragging) {
    dragState.container.classList.remove('dragging')
    try { dragState.container.releasePointerCapture?.(dragState.pointerId) } catch {}
    suppressClickUntil = Date.now() + 100
  }
  dragState = null
}
appEl.addEventListener('pointerup', endDrag)
appEl.addEventListener('pointercancel', endDrag)

// Cross-highlight: hovering any element with data-addr highlights the
// matching chunk in the byte-map. References and referrers light up the
// chunk's position in the stream so you can SEE where it lives. If the
// hover came from somewhere other than the strip itself, smooth-scroll
// the matching chunk into view inside any byte-strip-container —
// otherwise hover-elsewhere can highlight chunks that are off-screen.
appEl.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-addr]')
  if (!el) return
  const addr = el.dataset.addr
  const matches = appEl.querySelectorAll(`.byte-map .chunk[data-addr="${addr}"]`)
  matches.forEach(c => c.classList.add('hovered'))
  if (!el.closest('.byte-strip-container')) {
    matches.forEach(c => {
      if (c.closest('.byte-strip-container')) {
        c.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
      }
    })
  }
})
appEl.addEventListener('mouseout', e => {
  const el = e.target.closest('[data-addr]')
  if (!el) return
  appEl.querySelectorAll('.byte-map .chunk.hovered')
    .forEach(c => c.classList.remove('hovered'))
})
