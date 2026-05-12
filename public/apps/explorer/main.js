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
// Reactivity is bridged from each Repo's internal Recaller into the
// app-level Recaller via bridgeRegistry — see design.md §6 for why
// each Repo has its own Recaller and how the bridge connects them.

import { h } from '../../streamo/h.js'
import { mount } from '../../streamo/mount.js'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { RepoRegistry } from '../../streamo/RepoRegistry.js'
import { registrySync } from '../../streamo/registrySync.js'
import { bridgeRegistry } from '../../streamo/bridgeRegistry.js'
import { changedPaths } from '../../streamo/Streamo.js'
import { hexToBytes } from '../../streamo/utils.js'

// ── Connect ───────────────────────────────────────────────────────────────

const registry = new RepoRegistry()
const port = +location.port || 80

// Connection status captured into locals; the mount call below
// interpolates them into the conn div. Connection failure no longer
// throws — the explorer shell still mounts, so the user sees the
// error message in-page instead of a blank screen.
let connText = 'connecting…'
let connClass = ''
try {
  await registrySync(registry, location.hostname, port)
  connText = `connected · ${location.hostname}:${port}`
  connClass = 'ok'
} catch (e) {
  connText = `connection failed: ${e.message}`
  connClass = 'err'
}

// ── App-level reactivity ──────────────────────────────────────────────────

const recaller = new Recaller('explorer')
const { dep, fire: bridgeFire } = bridgeRegistry(registry, recaller, 'explorer')

// Wrap bridgeFire to also schedule the byte-strip pin-to-HEAD side effect
// after the next render. Reactive mutation is synchronous (so the slot
// re-runs at next tick); only the post-render DOM peek goes through rAF.
let stripSyncScheduled = false
function fire () {
  bridgeFire()
  if (stripSyncScheduled) return
  stripSyncScheduled = true
  requestAnimationFrame(() => { stripSyncScheduled = false; syncByteStrips() })
}

// Hover-only signal — separate from the bridge. Hover events that
// only set hoveredAddress fire hoverSignal exclusively; slots that
// read hoverDep() re-run, slots that don't are left alone. This is
// what keeps hovering the strip from re-rendering the strip itself.
const hoverSignal = {}
const hoverDep = () => recaller.reportKeyAccess(hoverSignal, 'data')
const hoverFire = () => recaller.reportKeyMutation(hoverSignal, 'data')

// View-shape signal — fires only when view.kind or view.keyHex
// changes. The outer mount slot watches this (NOT bridge), so
// intra-repo navigation (address changes within an at-view) does
// NOT re-run the outer slot, does NOT recreate AtView's inner slots,
// does NOT fresh-mount the byte-strip-container. Inner slots watch
// bridge — they re-run on address change, chunk arrivals, tab clicks,
// async results — and recursive-reconcile preserves the strip's DOM
// (scrollLeft, focus, keyed children) across those re-runs.
//
// Together with hoverSignal, this is the full signal decomposition:
//   viewKindSignal — kind/keyHex (registry ↔ at-view, repo switch)
//   bridge         — chunks, address, tab, async (everything else)
//   hoverSignal    — strip hover preview
const viewKindSignal = {}
const viewKindDep = () => recaller.reportKeyAccess(viewKindSignal, 'data')
const viewKindFire = () => recaller.reportKeyMutation(viewKindSignal, 'data')

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
  const kindChanged = next.kind !== view.kind || next.keyHex !== view.keyHex
  view = next
  const target = hashFromView(next)
  if (location.hash !== target) location.hash = target
  if (kindChanged) viewKindFire()
  fire()
}
window.addEventListener('hashchange', () => {
  const next = viewFromHash()
  if (next.kind === view.kind && next.keyHex === view.keyHex && next.address === view.address) return
  const kindChanged = next.kind !== view.kind || next.keyHex !== view.keyHex
  view = next
  if (kindChanged) viewKindFire()
  fire()
})

// At-view tab state — persists across at-view navigations so a user who
// wants to keep a "storage" lens on doesn't have to re-click after every
// drill-down. Reset to default on registry/repo views (set in go()).
let atTab = 'value'

// Live-hover-preview state. When the user hovers a chunk on the byte
// strip, the page content below the tabs renders that chunk's value/
// storage instead of the URL's. Click to actually navigate. The header
// (selector + strip + tabs) keeps showing where you ARE; only the
// content area peeks ahead. Set by the mouseover handler when on a
// strip; cleared on mouseout. Module-level so AtView reads it inside
// the slot's reactive cell.
let hoveredAddress = null

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

// Walk every chunk newest-first, yielding one entry per commit (with
// its covering signature attached) and one 'other' entry per non-commit
// non-sig chunk. A signature is part of *how* a commit is verified, not
// a thing of its own — so the user-level unit is the commit. Walking
// newest-first, we encounter each sig before the commits it covers
// (sig has higher address than the bytes it signed); we track the
// most-recently-seen sig and attach it to subsequent commits as their
// 'covering'. Commits encountered before any sig are uncovered (sign
// in flight or none yet) — those have covering: null.
function * commitsNewestFirst (repo) {
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
          signedFrom: sig.address,
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
function findCoveringSig (repo, commitAddr) {
  let scan = repo.byteLength - 1
  while (scan > commitAddr) {
    const code = repo.resolve(scan)
    if (!code || !code.length) break
    if (repo.footerToCodec[code.at(-1)]?.type === 'SIGNATURE') {
      let sig
      try { sig = repo.decode(scan) } catch { sig = null }
      if (sig && sig.address <= commitAddr && (scan - code.length) >= commitAddr) {
        return { sigAddress: scan, signedFrom: sig.address, signedTo: scan - code.length, decoded: sig }
      }
    }
    scan -= code.length
  }
  return null
}

// Sig-detail view — when you're at a sig chunk directly (e.g., from
// drilling through storage). Sigs are auxiliary in the new model — the
// user-level unit is the commit — so this page shows the sig's content
// without trying to be the "polished signed commit" page. The kindBanner
// is rendered by the caller (AtView) so its variant matches the rest of
// the value-tab branches.
function sigDetailBody (repo, keyHex, sigAddress, decoded) {
  const chunk = repo.resolve(sigAddress)
  const chunkLen = chunk.length
  const signedTo = sigAddress - chunkLen
  const sigChunkStart = sigAddress - chunkLen + 1
  const covered = commitsCoveredBySignature(repo, decoded.address, signedTo)
  return h`
    <table class="kv">
      <tbody>
        <tr>
          <td>covers</td>
          <td>@${decoded.address} through @${signedTo} (${signedTo - decoded.address + 1} bytes)</td>
        </tr>
        <tr>
          <td>sig chunk</td>
          <td class="mono">@${sigChunkStart}…@${sigAddress} (${chunkLen} bytes)</td>
        </tr>
        <tr><td>bytes</td><td class="mono">${truncHex(decoded.compactRawBytes, 32)}</td></tr>
      </tbody>
    </table>
    ${covered.length ? h`
      <h3>commits in this signature ${covered.length > 1 ? h`<span class="dim">(${covered.length}, batched in one sign)</span>` : null}</h3>
      ${covered.map(c => h`
        <div class="commit-card" data-key=${`cc${c.address}`} data-action="open-at"
             data-keyhex=${keyHex} data-addr=${c.address}>
          <div class="commit-msg">${c.message || h`<span class="dim">(no message)</span>`}</div>
          <div class="commit-meta dim">
            <span>${fmtDate(c.date)}</span>
            <span> · @${c.address}</span>
          </div>
        </div>
      `)}
    ` : null}
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
        // No claims about state we can't verify — show the date when we
        // resolve a commit, otherwise show the byte count. byteLength
        // is honest: it's what we actually have on hand. The watcher
        // fires as more chunks land and the row settles to a date once
        // the commit chunk resolves at the end of the stream.
        const last = repo.lastCommit
        const len = repo.byteLength
        const when = last ? fmtDate(last.date) : `${len} b`
        rows.push(h`
          <div class="row" data-key=${keyHex} data-action="open-repo">
            <span class="mono">${truncKey(keyHex)}</span>
            <span class=${['when', last ? null : 'dim']}>${when}</span>
            <span class="msg dim">${last?.message || ''}</span>
          </div>
        `)
      }
      return rows.length ? rows : h`<div class="empty">waiting for repos…</div>`
    }}
  `
}

// Resolve the symbolic HEAD address to the most-recent COMMIT chunk's
// address — not the most-recent signature. The user-level unit is the
// commit; sigs are how it's verified, but HEAD-as-a-commit is what
// people mean by "the latest." Returns undefined if there are no commits.
function resolveHead (repo) {
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

// Commit selector dropdown — always rendered at the top of an at-view
// when the repo has any commits. The dropdown enumerates COMMITS (not
// sigs), since the commit is the user-level unit. Each entry's verify
// badge comes from its covering sig; uncovered commits show a "pending"
// badge. When the current address is a commit, that row is the summary;
// otherwise the summary is a "detached" card (you're at a sig chunk, a
// Duple, raw bytes, etc. — drill state, not a named ref).
function commitSelectorSection (repo, keyHex, currentAddr) {
  const entries = [...commitsNewestFirst(repo)].filter(e => e.kind === 'commit')
  if (!entries.length) return null
  const tagFor = i => i === 0 ? 'HEAD' : `HEAD-${i}`
  const commitRow = (c, tag, { asSummary = false, isSelected = false } = {}) => {
    const cls = ['row', 'signed-commit',
      asSummary ? 'head-card' : null,
      isSelected ? 'selected' : null,
      c.covering ? null : 'unsigned']
    const action = asSummary ? null : 'select-commit'
    const badge = () => {
      dep()
      if (!c.covering) return h`<span class="verify-badge pending" title="not yet signed">…</span>`
      return verifyBadge(verifyStatus(repo, keyHex, c.covering.decoded || repo.decode(c.covering.sigAddress), c.covering.sigAddress))
    }
    return h`
      <div class=${cls}
           data-key=${`c${c.address}`}
           data-action=${action}
           data-keyhex=${keyHex} data-addr=${c.address}>
        <span class="kind">${tag} ${badge}</span>
        <span class="msg">${c.message || h`<span class="dim">(no message)</span>`}</span>
        <span class="when">${fmtDate(c.date)}</span>
        <span class="mono dim">@${c.address}</span>
      </div>`
  }
  const selectedIdx = entries.findIndex(e => e.address === currentAddr)
  const isDetached = selectedIdx < 0
  const detachedSummary = (() => {
    let codec = ''
    try { codec = repo.footerToCodec[repo.resolve(currentAddr).at(-1)]?.type || '' } catch {}
    return h`
      <div class="row signed-commit detached-card" data-key="detached">
        <span class="kind">detached</span>
        <span class="msg dim">exploring raw memory${codec ? ` · ${codec}` : ''}</span>
        <span class="when"></span>
        <span class="mono dim">@${currentAddr}</span>
      </div>`
  })()
  const summary = isDetached
    ? detachedSummary
    : commitRow(entries[selectedIdx], tagFor(selectedIdx), { asSummary: true })
  return h`
    <details class="commit-selector" data-key=${`selector-${keyHex}`}>
      <summary>${summary}</summary>
      <div class="dropdown-body">
        ${entries.map((e, i) => commitRow(e, tagFor(i), { isSelected: !isDetached && i === selectedIdx }))}
      </div>
    </details>
  `
}

// Repo-wide "other storage chunks" list — Duples, raw OBJECTs, ARRAYs,
// STRINGs, etc. The chunks underneath the commit graph. Tucked into a
// closed <details> so it doesn't compete with primary content. Unsigned
// commits already appear in the selector dropdown (with a pending badge),
// so they don't need a second listing here.
function repoExtras (repo, keyHex) {
  const others = [...commitsNewestFirst(repo)].filter(e => e.kind === 'other')
  if (!others.length) return null
  return h`
    <details class="other-storage">
      <summary>storage chunks <span class="dim">(${others.length}) — the chunks underneath</span></summary>
      <table class="kv clickable">
        <tbody>
          ${others.map(e => h`
            <tr data-key=${`o${e.address}`} data-action="open-at"
                data-keyhex=${keyHex} data-addr=${e.address}>
              <td class="mono dim">${e.codecType}</td>
              <td>${(() => { try { return typedValue(repo.decode(e.address)) } catch { return '' } })()}</td>
              <td class="mono dim">@${e.address}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </details>
  `
}

function AtView ({ keyHex }) {
  // AtView's body is built once per repo (the outer mount slot only
  // re-runs on view.kind / view.keyHex changes — see viewKindSignal).
  // Anything that depends on view.address must read it fresh inside a
  // reactive cell, NOT capture it in closure here. Same for resolved
  // chunk lookups: each slot calls resolveContext(repo) on every run.
  const resolveContext = (repo) => {
    let resolvedAddr = view.address
    if (view.address === 'HEAD') {
      resolvedAddr = resolveHead(repo)
      if (resolvedAddr === undefined) return { state: 'no-head' }
    }
    if (resolvedAddr >= repo.byteLength) return { state: 'loading' }
    return { state: 'ok', resolvedAddr }
  }

  return h`
    <a class="back" data-action="back-registry">← all repos</a>
    <div class="keyfull">
      <a class="repo-link" data-action="back-repo" data-keyhex=${keyHex}>${truncKey(keyHex)}</a>
      <span class="dim"> @ ${() => { dep(); return view.address }}</span>
    </div>

    ${() => {
      // HEADER slot — bridge only. Re-runs on chunk arrivals, navigation,
      // tab clicks, and async results. Does NOT re-run on hover (which
      // fires hoverSignal exclusively), so hovering the strip leaves the
      // selector + strip itself + tabs untouched. This is the whole
      // reason the hover signal exists as a separate channel.
      dep()
      const repo = registry.get(keyHex)
      if (!repo) return null
      const ctx = resolveContext(repo)
      if (ctx.state !== 'ok') return null
      const tabs = h`
        <nav class="tabs">
          <a class=${() => { dep(); return ['tab', atTab === 'value' ? 'active' : null] }}
             data-action="set-tab" data-tab="value">value</a>
          <a class=${() => { dep(); return ['tab', atTab === 'storage' ? 'active' : null] }}
             data-action="set-tab" data-tab="storage">storage</a>
          <a class=${() => { dep(); return ['tab', atTab === 'refs' ? 'active' : null] }}
             data-action="set-tab" data-tab="refs">refs</a>
        </nav>
      `
      const selector = commitSelectorSection(repo, keyHex, ctx.resolvedAddr)
      const bytes = byteStreamSection(repo, keyHex, ctx.resolvedAddr)
      return h`<div class="atview-header">${selector}${bytes}${tabs}</div>`
    }}

    ${() => {
      // CONTENT slot — bridge + hover. Re-runs on hover (so the page
      // content peeks at the hovered chunk) AND on bridge fires (for
      // chunk arrivals, tab clicks, async results). Renders the tab
      // body for contentAddr — the hovered address if peeking, else the
      // URL's address.
      dep()
      hoverDep()
      const repo = registry.get(keyHex)
      if (!repo) return h`<div class="empty">opening…</div>`
      const ctx = resolveContext(repo)
      if (ctx.state === 'no-head') {
        return h`
          <h2>at HEAD <span class="dim">(no commits yet)</span></h2>
          <div class="empty">this repo doesn't have any commits yet — HEAD will resolve to the most-recent commit once one lands.</div>
          ${repoExtras(repo, keyHex)}
        `
      }
      if (ctx.state === 'loading') return h`<div class="empty">loading…</div>`
      const resolvedAddr = ctx.resolvedAddr

      // Live hover preview: contentAddr peeks at the hovered chunk;
      // header still shows resolvedAddr (the URL position). Click to
      // navigate.
      const contentAddr = hoveredAddress != null && hoveredAddress < repo.byteLength
        ? hoveredAddress
        : resolvedAddr

      let info
      try { info = valueAndChildren(repo, contentAddr) }
      catch (e) { return h`<pre class="value">decode error: ${e.message}</pre>` }

      const { codecType, refs, decoded } = info
      const isCommit = isCommitShape(decoded)
      const isSig = codecType === 'SIGNATURE'

      // Per-value economics — a small dim footer block for every
      // value-tab page. Reports the chunk's subtree size (this chunk
      // + asRefs dependencies), how many commits reference it, and
      // the resulting naive/streamo cost story. Honest about graph
      // roots (uses=0): "no reuse possible by construction." Honest
      // about no-reuse-yet (uses=1): "1.00× — no reuse yet." Only
      // when uses>1 does the savings narrative kick in.
      const valueReuse = repoReuseStats(repo)
      const econ = valueEconomics(repo, contentAddr, valueReuse.uses)
      const econHead = econ.dependenciesBytes > 0
        ? h`<span class="num">${econ.chunkBytes}</span> bytes (this chunk) + <span class="num">${econ.dependenciesBytes}</span> in dependencies = <span class="num">${econ.subtreeBytes}</span> total. `
        : h`<span class="num">${econ.chunkBytes}</span> bytes (this chunk, no asRefs subtree). `
      const econTail = econ.uses === 0
        ? h`Not referenced from any commit's data tree — <span class="dim">graph root</span>.`
        : econ.uses === 1
          ? h`Used in <span class="num">1</span> commit · <span class="num leverage">1.00×</span> via reuse (no reuse yet).`
          : h`Used in <span class="num">${econ.uses}</span> commits → naive cost <span class="num">${econ.naiveCost}</span> bytes (<span class="num">${econ.subtreeBytes}</span> × <span class="num">${econ.uses}</span>), saved <span class="num">${econ.savings}</span>. <span class="num leverage">${econ.leverage.toFixed(2)}×</span> via reuse.`
      const economicsBlock = h`<div class="value-economics">${econHead}${econTail}</div>`

      // Storage tab: this chunk's makeup — the chunk-graph tree going
      // DOWN through directReferences (duples surfaced), then the raw
      // bytes of THIS chunk. The previous reachable-from and
      // referenced-by sections were partial earlier versions of what
      // the refs tab now does in full; dropped here so storage and
      // refs are clean mirror images.
      if (atTab === 'storage') {
        return h`
          <h3>chunk graph <span class="dim">storage tree rooted here</span></h3>
          <div class="storage-tree">${storageTree(repo, keyHex, contentAddr)}</div>
          ${rawChunkSection(repo, contentAddr)}
        `
      }

      // Refs tab: the inverse of storage. Walks UP through the chunk
      // graph until it hits graph roots (commits / signatures), each
      // row visually identical to a storage-tab row.
      if (atTab === 'refs') {
        return h`
          <h3>references <span class="dim">walks up the chunk graph from here</span></h3>
          <div class="storage-tree">${referenceTree(repo, keyHex, contentAddr)}</div>
        `
      }

      // Value tab — branches by codec.
      // Helper: render the kv-table of decoded fields for any Object/Array
      // (including commits, which are just OBJECTs with a known shape).
      // Inline children render their value directly; addressable children
      // get a clickable @addr link in the third column.
      const refsTable = () => {
        if (!refs || typeof refs !== 'object') return null
        const isArray = Array.isArray(refs)
        const fieldEntries = isArray
          ? refs.map((addr, i) => [String(i), addr])
          : Object.entries(refs)
        if (fieldEntries.length === 0) return h`<div class="empty">${isArray ? '[]' : '{}'}</div>`
        return h`
          <table class="kv clickable">
            <tbody>
              ${fieldEntries.map(([k, childAddr]) => {
                if (childAddr === undefined) {
                  const inlineValue = isArray ? decoded[+k] : decoded[k]
                  return h`
                    <tr>
                      <td class="mono">${k}</td>
                      <td>${typedValue(inlineValue)}</td>
                      <td class="dim">(inline)</td>
                    </tr>
                  `
                }
                let preview = ''
                try { preview = typedValue(repo.decode(childAddr)) }
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
        `
      }

      // Commit: same direct kv-table format as Object (it *is* an OBJECT —
      // user requested the "dumber" version that names every field rather
      // than packing them into a polished headline). Banner shows the
      // verify state from the covering sig; the verification table at the
      // bottom links to that sig and shows its bytes.
      if (isCommit) {
        const covering = findCoveringSig(repo, contentAddr)
        const parentDataAddr = decoded.parent !== undefined
          ? safeGet(() => repo.decode(decoded.parent)?.dataAddress)
          : undefined
        const changes = parentDataAddr !== undefined
          ? [...changedPaths(repo, parentDataAddr, decoded.dataAddress)]
          : null
        const banner = kindBanner(
          covering ? 'signed commit' : 'commit (unsigned)',
          covering
            ? () => {
                dep()
                const status = verifyStatus(repo, keyHex, covering.decoded, covering.sigAddress)
                return h`${verifyBadge(status)} <span class="dim">${verifyLabel(status)}</span>`
              }
            : h`<span class="verify-badge pending">…</span><span class="dim">not yet signed — sign in flight or pending</span>`,
          covering ? 'verified' : 'unsigned'
        )
        // Commit fields render with two semantic specials: dataAddress and
        // parent are *byte-address pointers* (their numeric value IS a
        // navigation target), so they're clickable address pills directly
        // — the chunk holding the FLOAT64 value is incidental and we
        // skip the chunk-address column for those rows.
        // dataAddress and parent are byte-address pointers held as
        // FLOAT64 values. The → glyph signals "this number is a
        // pointer; click to follow it." Without it, the address pill
        // looks like any other typedValue(number) and the navigation
        // hint depends on the user already knowing what these fields
        // mean.
        const addrLink = (addr) => addr === undefined
          ? h`<span class="dim">(none — first commit)</span>`
          : h`<span class="dim">→ </span><a class="addr-link" data-action="open-at" data-keyhex=${keyHex} data-addr=${addr}>@${addr}</a>`
        const commitFieldsTable = h`
          <table class="kv">
            <tbody>
              <tr><td class="mono">message</td><td>${typedValue(decoded.message)}</td></tr>
              <tr><td class="mono">date</td><td>${typedValue(decoded.date)}</td></tr>
              <tr><td class="mono">dataAddress</td><td>${addrLink(decoded.dataAddress)}</td></tr>
              <tr><td class="mono">parent</td><td>${addrLink(decoded.parent)}</td></tr>
            </tbody>
          </table>
        `
        return h`
          ${banner}
          ${commitFieldsTable}
          <h3>value <span class="dim">at <a class="addr-link" data-action="open-at" data-keyhex=${keyHex} data-addr=${decoded.dataAddress}>@${decoded.dataAddress}</a></span></h3>
          ${valueTree(repo, keyHex, decoded.dataAddress)}
          ${changes
            ? h`
              <h3>changed paths <span class="dim">(${changes.length})</span></h3>
              ${changes.length
                ? h`<ul class="paths">${changes.map(p => h`<li class="mono">${p.length === 0 ? '/' : p.join('.')}</li>`)}</ul>`
                : h`<div class="dim">(no path-level changes — same dataAddress)</div>`}
            `
            : null}
          ${covering ? h`
            <h3>verification</h3>
            <table class="kv">
              <tbody>
                <tr>
                  <td>signature</td>
                  <td><a class="addr-link" data-action="open-at" data-keyhex=${keyHex} data-addr=${covering.sigAddress}>@${covering.sigAddress}</a></td>
                </tr>
                <tr>
                  <td>covers</td>
                  <td>@${covering.signedFrom} through @${covering.signedTo} (${covering.signedTo - covering.signedFrom + 1} bytes)</td>
                </tr>
                <tr><td>sig bytes</td><td class="mono">${truncHex(covering.decoded.compactRawBytes, 32)}</td></tr>
              </tbody>
            </table>
          ` : null}
          ${repoExtras(repo, keyHex)}
          ${economicsBlock}
        `
      }

      // Duple: explain what this tree-node IS, then show its two children.
      if (codecType === 'DUPLE') {
        return h`
          ${kindBanner('duple', h`<span class="dim">2-tuple, tree scaffolding</span>`)}
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
              <tr><td class="mono">v[0]</td><td>${typedValue(decoded.v[0])}</td></tr>
              <tr><td class="mono">v[1]</td><td>${typedValue(decoded.v[1])}</td></tr>
            </tbody>
          </table>
          ${economicsBlock}
        `
      }

      // Signature: the sig-detail page (auxiliary in the new model — sigs
      // are how commits are verified, not the user-level unit). Lists
      // the commits this sig covers; pick one to land on its commit page.
      if (isSig) {
        const banner = kindBanner(
          'signature chunk',
          () => {
            dep()
            const status = verifyStatus(repo, keyHex, decoded, contentAddr)
            return h`${verifyBadge(status)} <span class="dim">${verifyLabel(status)}</span>`
          },
          'verified'
        )
        return h`
          ${banner}
          ${sigDetailBody(repo, keyHex, contentAddr, decoded)}
          <div class="dim" style="margin-top: 0.5rem;">switch to the <strong>storage</strong> tab above to see the raw chunk bytes, outgoing references, and what else points at this address.</div>
          ${economicsBlock}
        `
      }

      // Object/array: clickable children with their addresses.
      if (refs && typeof refs === 'object') {
        const isArray = Array.isArray(refs)
        const fieldCount = isArray ? refs.length : Object.keys(refs).length
        const dim = fieldCount === 0
          ? null
          : h`<span class="dim">${isArray ? `length ${fieldCount}` : `${fieldCount} field${fieldCount === 1 ? '' : 's'}`}</span>`
        const label = fieldCount === 0
          ? (isArray ? 'empty array' : 'empty object')
          : (isArray ? 'array' : 'object')
        return h`
          ${kindBanner(label, dim)}
          ${refsTable()}
          ${fieldCount > 0 ? h`
            <h3>rehydrated</h3>
            <pre class="value">${safeJSON(decoded)}</pre>
          ` : null}
          ${economicsBlock}
        `
      }

      // Primitive: just show it.
      return h`
        ${kindBanner(codecType.toLowerCase())}
        <pre class="value">${safeJSON(decoded)}</pre>
        ${economicsBlock}
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
    ${bytesChart(bytes, { showOffset: true, perRow: 16, max: 512 })}
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

// Dedup leverage: for each chunk, count how many distinct commits'
// data trees include it (BFS from each commit's dataAddress through
// asRefs). A chunk that shows up in 10 commits "earned" 9 free reuses;
// without dedup, those 9 reuses would've cost chunk.length each.
//
// Repo rollup: naiveBytes = Σ(chunk.length × uses) is what the stream
// would've cost without dedup; actualReusable = Σ(chunk.length) over
// the reachable chunks is what streamo actually stores. Leverage =
// naiveBytes / actualReusable — "this many effective bytes per actual
// byte." Grows monotonically as commits reuse existing chunks.
//
// The savings narrative the user reached for: "earlier bytes become
// more efficient over time" — a chunk's price is fixed at first-
// encoding-time; its value compounds with every later commit that
// references it. This computes the snapshot.
function repoReuseStats (repo) {
  const uses = new Map()  // chunkAddr → number of commits reaching it
  let addr = repo.byteLength - 1
  while (addr >= 0) {
    const code = repo.resolve(addr)
    if (!code || !code.length) break
    if (repo.footerToCodec[code.at(-1)]?.type === 'OBJECT') {
      let val
      try { val = repo.decode(addr) } catch {}
      if (val && isCommitShape(val)) {
        const visited = new Set()
        const stack = [val.dataAddress]
        while (stack.length) {
          const a = stack.pop()
          if (typeof a !== 'number' || visited.has(a)) continue
          visited.add(a)
          uses.set(a, (uses.get(a) ?? 0) + 1)
          let refs
          try { refs = repo.asRefs(a) } catch {}
          if (Array.isArray(refs)) {
            for (const c of refs) if (typeof c === 'number') stack.push(c)
          } else if (refs && typeof refs === 'object' && !(refs instanceof Date) && !(refs instanceof Uint8Array)) {
            if (Array.isArray(refs.v)) {
              for (const c of refs.v) if (typeof c === 'number') stack.push(c)
            } else {
              for (const c of Object.values(refs)) if (typeof c === 'number') stack.push(c)
            }
          }
        }
      }
    }
    addr -= code.length
  }
  let naiveBytes = 0
  let actualReusable = 0
  for (const [a, count] of uses) {
    let code
    try { code = repo.resolve(a) } catch { continue }
    if (!code) continue
    naiveBytes += code.length * count
    actualReusable += code.length
  }
  const leverage = actualReusable > 0 ? naiveBytes / actualReusable : 1
  return { uses, naiveBytes, actualReusable, leverage }
}

// Per-value economics — for the chunk at address A, sum the bytes of
// its full asRefs subtree (the chunks streamo actually stores to
// represent A), then combine with A's repo-wide use count to express
// the "naive vs. actual" story for THIS specific value:
//
//   subtree bytes = sum of every chunk reachable from A via asRefs
//   uses_A        = commits whose data tree includes A
//   naive cost    = subtree_bytes × uses_A
//                   ("if every commit re-encoded the whole subtree")
//   actual cost   = subtree_bytes
//                   (streamo stores it once and references it after)
//   leverage      = naive / actual = uses_A
//
// Honest about graph roots (uses_A = 0 — commits and signatures): no
// reuse possible by construction, so the block reports it that way
// rather than dividing by zero or pretending.
function valueEconomics (repo, address, uses) {
  let chunkBytes = 0
  try { chunkBytes = repo.resolve(address)?.length ?? 0 } catch {}
  let subtreeBytes = 0
  const visited = new Set()
  const stack = [address]
  while (stack.length) {
    const a = stack.pop()
    if (typeof a !== 'number' || visited.has(a)) continue
    visited.add(a)
    let code
    try { code = repo.resolve(a) } catch { continue }
    if (!code) continue
    subtreeBytes += code.length
    let refs
    try { refs = repo.asRefs(a) } catch {}
    if (Array.isArray(refs)) {
      for (const c of refs) if (typeof c === 'number') stack.push(c)
    } else if (refs && typeof refs === 'object' && !(refs instanceof Date) && !(refs instanceof Uint8Array)) {
      if (Array.isArray(refs.v)) {
        for (const c of refs.v) if (typeof c === 'number') stack.push(c)
      } else {
        for (const c of Object.values(refs)) if (typeof c === 'number') stack.push(c)
      }
    }
  }
  const useCount = uses.get(address) ?? 0
  return {
    chunkBytes,
    subtreeBytes,
    dependenciesBytes: Math.max(0, subtreeBytes - chunkBytes),
    uses: useCount,
    naiveCost: subtreeBytes * useCount,
    savings: useCount > 0 ? subtreeBytes * (useCount - 1) : 0,
    leverage: useCount  // value-as-a-whole framing: leverage = use count
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
    const chunk = {
      address: addr,
      start: addr - code.length + 1,
      length: code.length,
      codecType: codec?.type || '?'
    }
    // For sigs: precompute the byte range covered, so hover anywhere on
    // the page can light up that range as an overlay band on the strip.
    if (chunk.codecType === 'SIGNATURE') {
      try {
        const sig = repo.decode(addr)
        chunk.signedFrom = sig.address
        chunk.signedTo = addr - code.length
      } catch {}
    }
    chunks.unshift(chunk)
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
  // Inspector text — codec, address, length, percentage. Defaults to
  // the at-view's current chunk (currentAddress) but follows the
  // hovered chunk when the user is peeking at one on the strip. The
  // slot re-renders on hover (via the live-preview path), so reading
  // hoveredAddress in a nested slot below — reacts to hoverDep so its
  // text updates without re-rendering the strip itself.
  // Map byte address → strip x. Used by the sig-coverage overlay so hover
  // anywhere on the page can light up "what bytes does this sig sign".
  // Stored as data attrs on the strip container so the hover handler
  // can read without recomputing.
  const xForByte = (byteAddr) => {
    // Find the chunk containing this byte and interpolate within it.
    for (const c of layout) {
      if (byteAddr >= c.start && byteAddr <= c.address) {
        const frac = c.length === 1 ? 0 : (byteAddr - c.start) / (c.length - 1)
        return c.x + frac * c.w
      }
    }
    return 0
  }
  // Snapshot dedup leverage. Used both in the byte-stream <h3>
  // headline (rollup) and inside the inspector slot below (per-chunk
  // use count). Always shown — even 1.00× tells you something honest
  // about the repo's state (no reuse yet, or all chunks are unique).
  const reuse = repoReuseStats(repo)
  const leverageTxt = ` · ${reuse.leverage.toFixed(2)}× via reuse`
  // Per-type rollup: for each codec type, sum (chunks, bytes, naive
  // bytes-if-no-dedup). Chunks not reachable from any commit's data
  // tree (the graph roots — commit + signature chunks) have leverage
  // of zero by construction; rendered as "—" rather than "0×" so the
  // distinction is visible.
  const byType = new Map()
  let scanAddr = repo.byteLength - 1
  while (scanAddr >= 0) {
    const code = repo.resolve(scanAddr)
    if (!code || !code.length) break
    const type = repo.footerToCodec[code.at(-1)]?.type || '?'
    if (!byType.has(type)) byType.set(type, { type, chunks: 0, bytes: 0, naive: 0 })
    const e = byType.get(type)
    e.chunks += 1
    e.bytes += code.length
    e.naive += code.length * (reuse.uses.get(scanAddr) ?? 0)
    scanAddr -= code.length
  }
  const typeRows = [...byType.values()].sort((a, b) => b.bytes - a.bytes)
  return h`
    <h3>byte stream <span class="dim">(${total} bytes · ${chunks.length} chunks${leverageTxt})</span></h3>
    <div class="byte-strip-container" data-key=${`strip-${keyHex}`} data-strip-w=${stripW}>
      <svg class="byte-map byte-strip" width=${stripW} height=${H} viewBox=${`0 0 ${stripW} ${H}`}>
        ${layout.map(c => {
          const cat = commitAddrs.has(c.address) ? 'commit' : codecCategory(c.codecType)
          const cls = ['chunk', `cat-${cat}`, c.address === currentAddress ? 'current' : null]
          // Sigs carry their coverage range in data-attrs so hover handlers
          // (anywhere on the page) can position the coverage overlay.
          // Non-sigs get null which removes the attrs.
          const sigFromX = c.signedFrom != null ? xForByte(c.signedFrom) : null
          const sigToX   = c.signedTo   != null ? xForByte(c.signedTo)   : null
          return h`<rect
            class=${cls}
            x=${c.x} y="0" width=${c.w} height=${H}
            data-action="open-at"
            data-keyhex=${keyHex}
            data-addr=${c.address}
            data-codec=${c.codecType}
            data-len=${c.length}
            data-sig-from-x=${sigFromX}
            data-sig-to-x=${sigToX}
          ><title>${c.codecType} @${c.address} (${c.length} bytes)</title></rect>`
        })}
        <rect class="sig-coverage" x="0" y="0" width="0" height=${H} pointer-events="none"/>
      </svg>
    </div>
    ${() => {
      // Inspector slot — reads hoverDep so it updates as the user moves
      // across the strip, but doesn't re-render the strip itself. layout,
      // total, currentAddress are closed over from byteStreamSection's
      // call (which only runs on bridge fires; chunk content is fixed
      // per render). isPeekActive lights up the .active background only
      // when the inspector is showing something other than the URL's
      // chunk.
      hoverDep()
      const inspectorAddr = hoveredAddress != null && hoveredAddress < total
        ? hoveredAddress
        : currentAddress
      const inspectorChunk = layout.find(c => c.address === inspectorAddr)
      let inspectorContent
      if (inspectorChunk) {
        // Codec-color chip replaces the standalone legend — the chip
        // colors the type name with the same palette the strip uses,
        // so a glance at the inspector reads as a glance at the strip.
        const cat = commitAddrs.has(inspectorChunk.address)
          ? 'commit'
          : codecCategory(inspectorChunk.codecType)
        // The chip's *label* is the user-level unit, not the raw codec.
        // A commit is encoded as OBJECT but the user thinks of it as
        // COMMIT — same logic the rest of the explorer uses.
        const chipLabel = cat === 'commit' ? 'COMMIT' : inspectorChunk.codecType
        const pct = total > 0
          ? ` (${((inspectorChunk.length / total) * 100).toFixed(2)}% of ${total})`
          : ''
        // Always show the reuse count — 0 means "this chunk isn't in
        // any commit's data tree" (true for commits + sigs by
        // structure), 1 means "appears in one commit," >1 means
        // streamo is saving you (count-1) × bytes by dedup.
        const useCount = reuse.uses.get(inspectorChunk.address) ?? 0
        const reusePart = h` <span class="dim">·</span> in ${useCount} commit${useCount === 1 ? '' : 's'}`
        inspectorContent = h`<span class=${['codec-chip', `cat-${cat}`]}>${chipLabel}</span> <span class="dim">·</span> @${inspectorChunk.address} <span class="dim">·</span> ${inspectorChunk.length} bytes${pct}${reusePart}`
      } else {
        inspectorContent = `${chunks.length} chunks · ${total} bytes`
      }
      const isPeekActive = hoveredAddress != null && hoveredAddress !== currentAddress
      return h`<div class=${['chunk-inspector', isPeekActive ? 'active' : null]}
                    data-key=${`inspector-${keyHex}`}>${inspectorContent}</div>`
    }}
    <table class="reuse-by-type">
      <thead><tr><th>type</th><th>chunks</th><th>bytes</th><th>via reuse</th></tr></thead>
      <tbody>
        ${typeRows.map(e => {
          const cat = e.type === 'OBJECT' ? 'composite' : codecCategory(e.type)
          const isRoot = e.naive === 0
          const leverage = isRoot ? null : e.naive / e.bytes
          return h`
            <tr data-key=${e.type}>
              <td><span class=${['codec-chip', `cat-${cat}`]}>${e.type}</span></td>
              <td class="mono">${e.chunks}</td>
              <td class="mono">${e.bytes}</td>
              <td class="mono">${isRoot ? h`<span class="dim">—</span>` : `${leverage.toFixed(2)}×`}</td>
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

// Streamo-typed value renderer — every value gets a visual identity
// matching its underlying codec, instead of being flattened through
// JSON.stringify. Primitives render with type-specific styling
// (string → quoted mono in green frame, date → <time> with calendar
// chip, number → number chip, etc.); composites currently render as
// count chips ({ N fields } / [ N elements ]) — depth-controlled
// expansion is the next step in this thread (see THREADS.md).
function typedValue (v, depth = 0) {
  if (v === null) return h`<span class="tv tv-null" title="NULL">null</span>`
  if (v === undefined) return h`<span class="tv tv-undefined" title="UNDEFINED">undefined</span>`
  if (typeof v === 'boolean') {
    return h`<span class=${['tv', 'tv-bool', v ? 'tv-true' : 'tv-false']} title=${v ? 'TRUE' : 'FALSE'}>${v ? '✓' : '✗'} ${String(v)}</span>`
  }
  if (typeof v === 'string') {
    const display = v.length > 60 ? v.slice(0, 60) + '…' : v
    return h`<span class="tv tv-string" title=${v.length === 0 ? 'EMPTY_STRING' : 'STRING'}><span class="tv-quote">“</span>${display}<span class="tv-quote">”</span></span>`
  }
  if (typeof v === 'number') {
    // UINT7 is the codec for non-negative integers < 128; everything else
    // routes through FLOAT64. Surfacing this distinction makes "why is
    // this 1 byte vs 9" tactile when you hover.
    const codec = (Number.isInteger(v) && v >= 0 && v < 128) ? 'UINT7' : 'FLOAT64'
    return h`<span class="tv tv-num" title=${codec}>${String(v)}</span>`
  }
  if (v instanceof Date) {
    return h`<span class="tv tv-date" title="DATE"><span class="tv-glyph">📅</span><time datetime=${v.toISOString()}>${v.toLocaleString()}</time></span>`
  }
  if (v instanceof Uint8Array) {
    // bytesChart shows hex / char / decimal as three stacked rows,
    // one column per byte. The chart conveys "this is bytes" by
    // structure; the old tv-bytes pill wrapper is dropped.
    return bytesChart(v, { max: 8 })
  }
  if (isDuple(v)) {
    if (depth > 1) return h`<span class="tv tv-duple" title="DUPLE">Duple(…)</span>`
    return h`<span class="tv tv-duple" title="DUPLE">Duple(${typedValue(v.v[0], depth + 1)}, ${typedValue(v.v[1], depth + 1)})</span>`
  }
  if (Array.isArray(v)) {
    return h`<span class="tv tv-array" title=${v.length === 0 ? 'EMPTY_ARRAY' : 'ARRAY'}>[ ${v.length} ${v.length === 1 ? 'element' : 'elements'} ]</span>`
  }
  if (typeof v === 'object') {
    const n = Object.keys(v).length
    return h`<span class="tv tv-object" title=${n === 0 ? 'EMPTY_OBJECT' : 'OBJECT'}>{ ${n} ${n === 1 ? 'field' : 'fields'} }</span>`
  }
  return h`<span class="tv">${String(v)}</span>`
}

// Recursive typed-value tree — like typedValue, but expands composites
// inline up to `depth` levels deep. Beyond depth, composites render as
// un-expanded chips. Click a chip to expand IN PLACE (forceExpanded);
// click an expanded composite's opening bracket to collapse it back to
// a chip (forceCollapsed). Force-expand and force-collapse override
// the default depth-based decision.
//
// Default depth=3 covers `{ name, messages: [{text, at}, ...] }` —
// outer object expanded, messages array expanded, message objects
// expanded, and primitives like text/at render inline.
const forceExpanded  = new Set()  // `${keyHex}:${address}` → user clicked chip
const forceCollapsed = new Set()  // `${keyHex}:${address}` → user clicked bracket

// Cheap width estimator for inline rendering — we only inline when
// every entry is a primitive, so we can predict rendered width without
// touching the DOM. Conservative: real chips have padding/quotes that
// add ~2-3 chars beyond the bare value.
function isInlinablePrimitive (v) {
  if (v === null || v === undefined) return true
  const t = typeof v
  if (t === 'number' || t === 'boolean' || t === 'string') return true
  if (v instanceof Date) return true
  // Uint8Array now renders as a multi-row bytes chart — not inlinable.
  return false
}
function estimateEntryWidth (k, v, isArray) {
  let w = isArray ? 0 : (String(k).length + 2)
  if (v === null) w += 4
  else if (v === undefined) w += 9
  else if (typeof v === 'boolean') w += v ? 6 : 7
  else if (typeof v === 'number') w += String(v).length
  else if (typeof v === 'string') w += Math.min(v.length, 60) + 2
  else if (v instanceof Date) w += 22
  return w
}

function valueTree (repo, keyHex, address, depth = 3) {
  let value, refs
  try {
    value = repo.decode(address)
    refs = repo.asRefs(address)
  } catch {
    return h`<span class="dim">(decode error @${address})</span>`
  }
  if (typeof value !== 'object' || value === null || value instanceof Date || value instanceof Uint8Array) {
    return typedValue(value)
  }
  const k = `${keyHex}:${address}`
  const userExpanded  = forceExpanded.has(k)
  const userCollapsed = forceCollapsed.has(k)
  const expand = userExpanded || (!userCollapsed && depth > 0)
  if (!expand) {
    return h`<a class="tv-drill" data-action="expand-tree"
                 data-keyhex=${keyHex} data-addr=${address}
                 title="click to expand · drill via storage tab if you need a full at-view"
              >${typedValue(value)}</a>`
  }
  const isArray = Array.isArray(value)
  const entries = isArray
    ? value.map((v, i) => [String(i), v, refs?.[i]])
    : Object.entries(value).map(([k, v]) => [k, v, refs?.[k]])
  if (entries.length === 0) {
    return h`<span class="tv ${isArray ? 'tv-array' : 'tv-object'}">${isArray ? '[ ]' : '{ }'}</span>`
  }

  // Inline rendering — Chrome-console-style. When every child is a
  // primitive AND the projected line width fits, lay the composite out
  // as `{k: v, k: v}` or `[v, v]` instead of one row per entry. Saves
  // a lot of vertical space on small leaf records (e.g. `{name, role,
  // active}`); falls back to multi-line for composites that wouldn't
  // fit on one line.
  const allPrimitive = entries.every(([_, v]) => isInlinablePrimitive(v))
  if (allPrimitive) {
    let width = 2
    for (const [k, v] of entries) width += estimateEntryWidth(k, v, isArray) + 2
    if (width <= 70) {
      return h`<span class=${['tv-tree-inline', isArray ? 'tv-tree-array' : 'tv-tree-object']}>
        <span class="tv-bracket clickable" data-action="collapse-tree"
              data-keyhex=${keyHex} data-addr=${address}
              title="click to collapse"
          >${isArray ? '[' : '{'}</span>
        ${entries.map(([k, v], i) => h`${i > 0 ? h`<span class="tv-sep">, </span>` : null}${!isArray ? h`<span class="tv-key">${k}:</span> ` : null}${typedValue(v)}`)}
        <span class="tv-bracket">${isArray ? ']' : '}'}</span>
      </span>`
    }
  }

  return h`
    <div class="tv-tree ${isArray ? 'tv-tree-array' : 'tv-tree-object'}">
      <span class="tv-bracket clickable" data-action="collapse-tree"
            data-keyhex=${keyHex} data-addr=${address}
            title="click to collapse"
        >${isArray ? '[' : '{'}</span>
      ${entries.map(([k, v, addr]) => h`
        <div class="tv-tree-row">
          <span class="tv-key">${k}:</span>
          ${addr !== undefined
            ? valueTree(repo, keyHex, addr, depth - 1)
            : typedValue(v)}
        </div>
      `)}
      <span class="tv-bracket">${isArray ? ']' : '}'}</span>
    </div>
  `
}

// Recursive chunk-graph tree — like valueTree, but for the storage tab.
// Two key differences:
//   1. Walks \\`directReferences\\` (the actual chunk graph) instead of
//      `asRefs` (the user-meaningful tree). DUPLEs that the value tab
//      hides as scaffolding are surfaced here as their own rows —
//      seeing them IS the storage view's job.
//   2. Every node shows codec chip + clickable @addr + value preview.
//      The chip and the preview share the codec palette, so a STRING
//      reads emerald all the way across.
// Shares the depth/expansion model with valueTree but keeps its own
// expanded/collapsed sets, since "expand this chunk" means different
// things in the two tabs (decoded value vs. chunk references).
const storageForceExpanded  = new Set()
const storageForceCollapsed = new Set()

function storageTree (repo, keyHex, address, depth = 3) {
  let codecType = '?'
  let preview = h`<span class="dim">…</span>`
  let refs = []
  try {
    const code = repo.resolve(address)
    codecType = repo.footerToCodec[code.at(-1)]?.type || '?'
    preview = typedValue(repo.decode(address))
    refs = repo.directReferences(address)
  } catch (e) {
    return h`<div class="storage-row"><span class="dim">(decode error @${address}: ${e.message})</span></div>`
  }
  const cat = codecCategory(codecType)
  const k = `${keyHex}:${address}`
  const userExpanded  = storageForceExpanded.has(k)
  const userCollapsed = storageForceCollapsed.has(k)
  const expand = userExpanded || (!userCollapsed && depth > 0)
  const isLeaf = refs.length === 0
  const toggle = isLeaf
    ? h`<span class="storage-toggle empty">·</span>`
    : expand
      ? h`<a class="storage-toggle" data-action="collapse-storage"
              data-keyhex=${keyHex} data-addr=${address}
              title="click to collapse">▾</a>`
      : h`<a class="storage-toggle" data-action="expand-storage"
              data-keyhex=${keyHex} data-addr=${address}
              title="click to expand">▸</a>`
  // DUPLE preview is suppressed in the chunk graph: a duple's whole
  // content is its two children, which already render as their own
  // rows directly below. typedValue's "Duple(left, right)" inline
  // form was duplicating those two children one line above where
  // they live. The purple DUPLE chip carries the identity; the tree
  // structure carries the content.
  const showPreview = codecType !== 'DUPLE'
  const header = h`
    <div class="storage-row">
      ${toggle}
      <span class=${['codec-chip', `cat-${cat}`]}>${codecType}</span>
      <a class="addr-link" data-action="open-at"
         data-keyhex=${keyHex} data-addr=${address}>@${address}</a>
      ${showPreview ? h`<span class="storage-preview">${preview}</span>` : null}
      ${!isLeaf && !expand
        ? h`<span class="dim storage-childcount">${refs.length} ref${refs.length === 1 ? '' : 's'}</span>`
        : null}
    </div>
  `
  if (!expand || isLeaf) return header
  return h`
    ${header}
    <div class="storage-children">
      ${refs.map(childAddr => storageTree(repo, keyHex, childAddr, depth - 1))}
    </div>
  `
}

function safeGet (f) { try { return f() } catch { return undefined } }

// Build a child→parents index over the chunk graph in one pass, so we
// can answer "who references address X?" in O(1) per query and walk
// up parent chains without re-scanning. Walks `directReferences` (not
// `asRefs`), so internal Duples are preserved as their own rows —
// mirroring what storageTree does going DOWN.
function buildDirectReferrerIndex (repo) {
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

// Recursive reference tree — twin of storageTree but walks UP through
// the chunk graph instead of DOWN. Where storageTree's leaves are
// chunks that don't reference anything (a single-byte WORD), this
// tree's leaves are chunks that NOTHING references — graph roots,
// typically commits and signatures. The tree is rooted at the URL's
// chunk and grows toward those roots: "who uses this? and who uses
// THAT? and who uses that?" all the way up.
//
// Visually identical to storageTree (same row class, same toggle,
// same chip + @addr + preview). Different state (refTreeForce*) so
// expand/collapse decisions don't cross-pollute. Different child
// label ("N referrers" vs. storage's "N refs") — small thing, but
// the direction is ambiguous otherwise.
const refTreeForceExpanded  = new Set()
const refTreeForceCollapsed = new Set()

function referenceTree (repo, keyHex, address, depth = 4, index = null) {
  index = index ?? buildDirectReferrerIndex(repo)
  let codecType = '?'
  let preview = h`<span class="dim">…</span>`
  try {
    const code = repo.resolve(address)
    codecType = repo.footerToCodec[code.at(-1)]?.type || '?'
    preview = typedValue(repo.decode(address))
  } catch (e) {
    return h`<div class="storage-row"><span class="dim">(decode error @${address}: ${e.message})</span></div>`
  }
  const referrers = index.get(address) ?? []
  const cat = codecCategory(codecType)
  const k = `${keyHex}:${address}`
  const userExpanded  = refTreeForceExpanded.has(k)
  const userCollapsed = refTreeForceCollapsed.has(k)
  const expand = userExpanded || (!userCollapsed && depth > 0)
  const isLeaf = referrers.length === 0
  const toggle = isLeaf
    ? h`<span class="storage-toggle empty">·</span>`
    : expand
      ? h`<a class="storage-toggle" data-action="collapse-refs"
              data-keyhex=${keyHex} data-addr=${address}
              title="click to collapse">▾</a>`
      : h`<a class="storage-toggle" data-action="expand-refs"
              data-keyhex=${keyHex} data-addr=${address}
              title="click to expand">▸</a>`
  // Same DUPLE suppression as storageTree — see comment there.
  const showPreview = codecType !== 'DUPLE'
  const header = h`
    <div class="storage-row">
      ${toggle}
      <span class=${['codec-chip', `cat-${cat}`]}>${codecType}</span>
      <a class="addr-link" data-action="open-at"
         data-keyhex=${keyHex} data-addr=${address}>@${address}</a>
      ${showPreview ? h`<span class="storage-preview">${preview}</span>` : null}
      ${isLeaf
        ? h`<span class="dim storage-childcount">graph root</span>`
        : !expand
          ? h`<span class="dim storage-childcount">${referrers.length} referrer${referrers.length === 1 ? '' : 's'}</span>`
          : null}
    </div>
  `
  if (!expand || isLeaf) return header
  return h`
    ${header}
    <div class="storage-children">
      ${referrers.map(r => referenceTree(repo, keyHex, r.address, depth - 1, index))}
    </div>
  `
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

// Consistent "what this is" banner at the top of every value-tab branch.
// label is the short codec/role name (e.g. "signed commit", "object",
// "duple"); content is whatever else goes in the banner (verify badge +
// label, field count, etc.); variant tints the surface — 'verified' for
// commits/sigs with a covering signature, 'unsigned' for commits awaiting
// one, undefined for everything else.
function kindBanner (label, content, variant) {
  return h`
    <div class=${['kind-banner', variant || null]}>
      <span class="kind-label">${label}</span>
      ${content || null}
    </div>
  `
}

function verifyLabel (status) {
  if (status === 'valid')   return 'verified — bytes match this repo’s public key'
  if (status === 'invalid') return 'NOT VERIFIED — bytes do not match the repo key'
  if (status === 'pending') return 'verifying…'
  return `error: ${status?.error ?? 'unknown'}`
}

function verifyBadge (status) {
  if (status === 'valid')   return h`<span class="verify-badge valid"   title="signature verified against repo's public key">✓</span>`
  if (status === 'invalid') return h`<span class="verify-badge invalid" title="signature does NOT match repo's public key">✗</span>`
  if (status === 'pending') return h`<span class="verify-badge pending" title="verifying…">…</span>`
  return h`<span class="verify-badge error" title=${status?.error || 'verification error'}>⚠</span>`
}

// Hex dump of a chunk's raw bytes. Truncates at maxLen so a giant value
// chunk doesn't blow up the page.
// Three-row byte chart: hex / char / decimal, with each byte in a
// fixed-width column. Tries to honor "beautifully formatted while
// also being tight" — monospace, narrow gutters, dim subordinate
// rows. Used by typedValue for inline Uint8Array previews (8 bytes,
// no offset) and by rawChunkSection for the full chunk dump
// (offset column on the left, 16 bytes per group, capped at 256).
//
//   ┌──────────────────────────────────────────┐
//   │     61   6c   69   63   65   20   66  6f │  ← hex (olive)
//   │      a    l    i    c    e         f   o │  ← char (ink, dim for non-printable)
//   │     97  108  105   99  101   32  102 111 │  ← decimal (dim, smaller)
//   └──────────────────────────────────────────┘
function bytesChart (bytes, options = {}) {
  const { max = Infinity, perRow = 8, showOffset = false } = options
  const len = bytes.length
  if (len === 0) return h`<span class="dim mono">(empty)</span>`
  const showLen = Math.min(len, max)
  const slice = bytes.subarray(0, showLen)
  const truncated = len > showLen
  const groups = []
  for (let i = 0; i < slice.length; i += perRow) {
    groups.push({ offset: i, bytes: slice.subarray(i, Math.min(i + perRow, slice.length)) })
  }
  return h`<div class="bytes-chart">
    ${groups.map(group => h`<table class=${['bytes-group', showOffset ? 'with-offset' : null]}>
      <tr class="hex">
        ${showOffset ? h`<th>${group.offset.toString(16).padStart(4, '0')}</th>` : null}
        ${[...group.bytes].map(b => h`<td>${b.toString(16).padStart(2, '0')}</td>`)}
      </tr>
      <tr class="char">
        ${showOffset ? h`<th></th>` : null}
        ${[...group.bytes].map(b => {
          const printable = b >= 0x20 && b <= 0x7E
          return h`<td class=${printable ? 'printable' : 'nonprint'}>${printable ? String.fromCharCode(b) : '·'}</td>`
        })}
      </tr>
      <tr class="dec">
        ${showOffset ? h`<th></th>` : null}
        ${[...group.bytes].map(b => h`<td>${b}</td>`)}
      </tr>
    </table>`)}
    ${truncated ? h`<div class="bytes-chart-more dim">… +${len - showLen} more bytes</div>` : null}
  </div>`
}

// ── Mount ─────────────────────────────────────────────────────────────────

// Page-level CSS, migrated from index.html as part of the "put it all
// in h" pass. Declared as a const so it doesn't bloat the mount call's
// literal text — same end result as inlining since it ships with main.js.
// (Shared base tokens like --ink, --rule, etc. still come from
//  proto.css, linked in index.html and applied document-wide.)
const css = `
    /* scrollbar-gutter reserves the scrollbar's width whether or not it's
       drawn, so a sudden scroll-needed (e.g. when the value pane grows
       under hover preview) doesn't shift everything left by ~15px. */
    html { scrollbar-gutter: stable; }
    body { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem; }

    .header  { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.25rem; }
    /* Brand lockup: mark + wordmark, single clickable unit linking home.
       Page title ("explorer") sits beside it as a separate, lighter
       element so the relationship reads as [home] · [you-are-here]. */
    .brand-lockup {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 1.6rem;
      letter-spacing: -0.02em;
      color: var(--ink);
      text-decoration: none;
    }
    .brand-lockup img { width: 1.8rem; height: 1.8rem; }
    .brand-lockup:hover { opacity: 0.8; }
    .page-title {
      font-size: 0.95rem;
      color: var(--ink-dim);
      letter-spacing: 0.04em;
    }
    .page-title::before { content: '· '; opacity: 0.5; }
    .crumbs  { font-size: 0.85rem; color: var(--ink-dim); }
    .back    { cursor: pointer; color: var(--ink-dim); font-size: 0.85rem; display: inline-block; margin-bottom: 1rem; }
    .back:hover { color: var(--ink); }

    h2 { font-size: 1.05rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }
    h2 .dim { font-weight: 400; font-size: 0.9rem; }

    .row {
      display: grid;
      grid-template-columns: 1fr 12rem 14rem;
      gap: 0.75rem;
      align-items: baseline;
      padding: 0.55rem 0.75rem;
      border: 1.5px solid transparent;
      border-radius: var(--radius);
      cursor: pointer;
    }
    .row:hover { border-color: var(--ink); background: rgba(254, 240, 138, 0.4); }
    .row + .row { border-top-color: var(--rule); }
    .row:hover + .row { border-top-color: transparent; }

    /* signed-commit + unsigned-commit + commit + signature rows share the same
       column template so the page doesn't visually jitter as you scan a mixed
       list. cols: kind | message | date | addr. */
    .row.signed-commit, .row.unsigned-commit,
    .row.commit, .row.signature { grid-template-columns: 6rem 1fr 14rem 6rem; }

    .row .mono { font-size: 0.85rem; }
    .row .when { font-size: 0.78rem; color: var(--ink-dim); }
    .row .msg  { font-size: 0.85rem; }
    .row .kind {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ink-dim);
      border: 1px solid var(--rule);
      border-radius: 999px;
      padding: 0.05rem 0.5rem;
      text-align: center;
      align-self: center;
    }
    .row.commit .kind                 { color: var(--accent); border-color: var(--accent); }
    .row.signature .kind              { color: var(--warn);   border-color: var(--warn); }
    .row.signed-commit .kind          { color: #16a34a;       border-color: #16a34a; }
    .row.signed-commit.unsigned .kind { color: var(--ink-dim); border-color: var(--ink-dim); }

    /* HEAD card — the most-recent signed commit, prominent and self-orienting. */
    .row.signed-commit.head-card {
      border: 1.5px solid #16a34a;
      background: rgba(22, 163, 74, 0.05);
      padding: 0.85rem;
    }
    .row.signed-commit.head-card .msg { font-size: 1rem; font-weight: 500; }

    /* Detached card — same layout as the head-card but neutral styling.
       Shown as the selector summary when the current address isn't a sig
       (you've drilled into raw memory). The dropdown body is still the
       way back — pick a real commit and you re-attach. */
    .row.signed-commit.detached-card {
      border: 1.5px dashed var(--rule);
      background: transparent;
      padding: 0.85rem;
      cursor: pointer;
    }
    .row.signed-commit.detached-card .kind {
      color: var(--ink-dim);
      border-color: var(--ink-dim);
    }
    .row.signed-commit.detached-card .msg { font-size: 0.95rem; }

    /* Commit selector: a real dropdown widget. Summary = currently-selected
       commit (HEAD by default), styled as the green head-card. Body =
       full list of signed commits, with the selected one marked. */
    details.commit-selector { margin: 0.5rem 0 1rem; }
    details.commit-selector > summary {
      cursor: pointer;
      list-style: none;
      padding: 0;
    }
    details.commit-selector > summary::-webkit-details-marker { display: none; }
    details.commit-selector > summary::marker { display: none; }
    details.commit-selector > summary::after {
      content: '▾';
      float: right;
      margin: 0.5rem 0.85rem;
      color: #16a34a;
      font-size: 0.85rem;
    }
    details.commit-selector[open] > summary::after { content: '▴'; }
    details.commit-selector .dropdown-body {
      margin-top: 0.25rem;
      border: 1px solid var(--rule);
      border-radius: var(--radius);
      padding: 0.25rem;
    }
    details.commit-selector .dropdown-body .row { padding: 0.45rem 0.6rem; }
    details.commit-selector .dropdown-body .row.selected {
      background: rgba(22, 163, 74, 0.07);
    }
    details.commit-selector .dropdown-body .row.selected .kind::after {
      content: ' ●';
      color: #16a34a;
    }

    /* Tucked-away secondary "storage chunks" list at the bottom of the
       repo view — a click away when you want to see the bytes underneath. */
    details.other-storage {
      margin: 1.25rem 0 0.5rem;
      border-top: 1px solid var(--rule);
      padding-top: 0.5rem;
    }
    details.other-storage > summary {
      cursor: pointer;
      font-size: 0.85rem;
      color: var(--ink-dim);
      padding: 0.35rem 0.25rem;
    }
    details.other-storage[open] > summary { color: var(--ink); }

    /* "What this is" banner — top of every value tab. Default neutral
       border for storage codecs; green .verified for commits or sigs
       backed by a valid signature; dim .unsigned for commits awaiting
       a signature. */
    .kind-banner {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.65rem 0.85rem; margin: 0.5rem 0 1rem;
      border: 1.5px solid var(--rule); border-radius: var(--radius);
    }
    .kind-banner.verified {
      border-color: #16a34a;
      background: rgba(22, 163, 74, 0.06);
    }
    .kind-banner.unsigned { border-style: dashed; }
    .kind-banner .kind-label {
      font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
      font-weight: 600; color: var(--ink-dim);
    }
    .kind-banner.verified .kind-label { color: #16a34a; }
    .commit-card {
      padding: 0.6rem 0.85rem; margin: 0.4rem 0;
      border: 1px solid var(--rule); border-radius: var(--radius);
    }
    .commit-card .commit-msg { font-size: 0.95rem; margin-bottom: 0.25rem; }
    .commit-card .commit-meta { font-size: 0.8rem; }

    .verify-badge { font-weight: 700; padding-left: 0.35em; font-size: 0.95em; }
    .verify-badge.valid   { color: #16a34a; }
    .verify-badge.invalid { color: #dc2626; }
    .verify-badge.pending { color: var(--ink-dim); font-weight: 400; }
    .verify-badge.error   { color: #ca8a04; }

    .empty { color: var(--ink-dim); padding: 0.5rem 0.75rem; font-size: 0.9rem; }

    /* key/value table for the at-view */
    .kv { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 0.75rem 0; }
    .kv td { padding: 0.4rem 0.6rem; vertical-align: top; }
    .kv tr + tr td { border-top: 1px dashed var(--rule); }
    .kv td:first-child {
      color: var(--ink-dim);
      width: 8rem;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    /* clickable variant — whole row is the click target */
    .kv.clickable tr { cursor: pointer; }
    .kv.clickable tr:hover td { background: rgba(254, 240, 138, 0.4); }
    .kv.clickable td:last-child { color: var(--accent); text-align: right; }

    .addr-link {
      font-family: monospace;
      font-size: 0.85rem;
      color: var(--accent);
      cursor: pointer;
      text-decoration: underline dotted;
    }
    .addr-link:hover { background: var(--flash); text-decoration-style: solid; }

    .paths { list-style: none; padding: 0; }
    .paths li { padding: 0.2rem 0.5rem; font-size: 0.85rem; }
    .paths li + li { border-top: 1px dashed var(--rule); }

    h3 { font-size: 0.9rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }
    h3 .dim { font-weight: 400; font-size: 0.85rem; }

    .explainer {
      font-size: 0.85rem;
      line-height: 1.55;
      color: var(--ink-dim);
      border-left: 2px solid var(--rule);
      padding: 0.4rem 0 0.4rem 0.85rem;
      margin: 0.6rem 0 0.9rem;
    }
    .explainer strong { color: var(--ink); }

    .conn { font-size: 0.75rem; color: var(--ink-dim); margin-bottom: 1.5rem; }
    .conn.ok  { color: #16a34a; }
    .conn.err { color: #dc2626; }

    .keyfull { font-size: 0.78rem; color: var(--ink-dim); word-break: break-all; }
    .keyfull .mono { font-family: monospace; }
    .repo-link {
      font-family: monospace;
      color: var(--accent);
      cursor: pointer;
      text-decoration: underline dotted;
    }
    .repo-link:hover { background: var(--flash); text-decoration-style: solid; }

    /* Sticky at-view header: selector + strip + tabs travel with you as
       you scroll long value trees or storage detail. Background-cover so
       content scrolling underneath doesn't bleed through. */
    .atview-header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--bg, #fefdf8);
      padding-top: 0.25rem;
      border-bottom: 1px solid var(--rule);
      margin-bottom: 0.75rem;
    }

    /* Byte stream — zoomed strip in a horizontally-scrollable container,
       click-drag-to-pan inside for "look around" navigation. */
    .byte-strip-container {
      width: 100%;
      overflow-x: auto;
      background: #faf9f4;
      border: 1.5px solid var(--rule);
      border-radius: var(--radius);
      margin: 0.4rem 0 1rem;
      cursor: grab;
    }
    .byte-strip-container.dragging { cursor: grabbing; user-select: none; }
    .byte-strip-container.dragging .chunk { cursor: grabbing; }
    .byte-strip { display: block; }

    /* Sig-coverage overlay: when hovering a sig anywhere on the page,
       this rect is positioned over its [signedFrom, signedTo] byte range
       on the strip. Subtle dashed band — doesn't fight the chunk colors. */
    .byte-strip .sig-coverage {
      fill: rgba(239, 68, 68, 0.12);
      stroke: rgba(239, 68, 68, 0.6);
      stroke-width: 1.5;
      stroke-dasharray: 4 3;
      opacity: 0;
      transition: opacity 0.08s;
    }
    .byte-strip .sig-coverage.active { opacity: 1; }

    /* Persistent context line for the at-view's current chunk: codec,
       address, length, percentage. Quiet by default (it's permanent,
       not the focus), lights up when something else on the page is
       hovered to show that chunk instead. Reverts via data-default
       on mouseout. */
    .chunk-inspector {
      font-family: monospace;
      font-size: 0.8rem;
      color: var(--ink-dim);
      padding: 0.25rem 0.5rem;
      margin: 0.25rem 0 0.75rem;
      border-radius: var(--radius);
      transition: color 0.08s, background 0.08s;
    }
    .chunk-inspector.active {
      color: var(--ink);
      background: var(--flash);
    }

    /* Per-codec reuse breakdown — quiet table under the byte strip
       showing each codec type's chunk count, total bytes, and dedup
       leverage. "—" in the leverage column marks chunks that aren't
       reachable from any commit's data tree (commit + signature
       chunks by structure — they're graph roots, not reuse candidates). */
    .reuse-by-type {
      width: auto;
      border-collapse: collapse;
      font-size: 0.78rem;
      margin: 0.25rem 0 0.75rem;
    }
    .reuse-by-type th,
    .reuse-by-type td {
      padding: 0.15rem 0.6rem 0.15rem 0;
      text-align: left;
      font-weight: normal;
      font-variant-numeric: tabular-nums;
    }
    .reuse-by-type th {
      color: var(--ink-dim);
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .reuse-by-type tbody tr + tr td { border-top: 1px solid var(--rule); }
    .reuse-by-type td.mono { font-family: monospace; }

    /* Per-value economics footer — appears under every value-tab page,
       showing this value's subtree size, use count, and dedup story.
       Secondary information: dim by default, numbers in ink, leverage
       in slightly bolder ink. Dashed top rule to separate from the
       main value display without competing with content. */
    .value-economics {
      font-size: 0.78rem;
      color: var(--ink-dim);
      line-height: 1.6;
      margin: 1.5rem 0 0.5rem;
      padding-top: 0.65rem;
      border-top: 1px dashed var(--rule);
      font-family: monospace;
    }
    .value-economics .num {
      color: var(--ink);
      font-weight: 500;
    }
    .value-economics .num.leverage {
      font-weight: 600;
    }

    .byte-map {
      display: block;
    }
    .byte-map .chunk {
      cursor: pointer;
      stroke: rgba(0, 0, 0, 0.15);
      stroke-width: 0.4;
      transition: stroke-width 0.08s, fill-opacity 0.08s;
    }
    .byte-map .chunk:hover { stroke: var(--ink); stroke-width: 1.5; }
    .byte-map .chunk.current { stroke: var(--ink); stroke-width: 2; }
    .byte-map .chunk.hovered { fill-opacity: 0.55; }

    /* Streamo-typed value pills — every value gets a type-specific visual
       identity instead of flattening through JSON.stringify. Colors echo
       the byte-strip codec palette below so the visual language carries
       across the page. */
    .tv {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.05rem 0.4rem;
      border-radius: var(--radius);
      font-size: 0.85rem;
      max-width: 100%;
      vertical-align: baseline;
    }
    .tv-string { color: #047857; background: rgba(16, 185, 129, 0.10); font-family: monospace; }
    .tv-string .tv-quote { color: #10b981; opacity: 0.7; font-weight: 600; }
    .tv-num    { color: #475569; background: rgba(100, 116, 139, 0.10); font-family: monospace; }
    .tv-date   { color: #475569; background: rgba(100, 116, 139, 0.10); }
    .tv-date .tv-glyph { font-size: 0.75rem; }
    .tv-date time { font-variant-numeric: tabular-nums; }
    .tv-bool.tv-true   { color: #15803d; background: rgba(22, 163, 74, 0.10); font-family: monospace; }
    .tv-bool.tv-false  { color: #b91c1c; background: rgba(220, 38, 38, 0.10); font-family: monospace; }
    .tv-null, .tv-undefined { color: var(--ink-dim); background: transparent; font-style: italic; font-family: monospace; }
    .tv-bytes  { color: #4d7c0f; background: rgba(132, 204, 22, 0.10); font-family: monospace; }
    .tv-array, .tv-object { color: #1e40af; background: rgba(59, 130, 246, 0.10); }
    .tv-duple  { color: #6b21a8; background: rgba(168, 85, 247, 0.10); }

    /* Three-row byte chart: hex / char / decimal. One column per byte,
       widths driven by the widest cell so dec values up to 255 align
       cleanly. Olive on a very-faint olive wash keeps the cat-bytes
       identity; rows have distinct visual weight so you can pick the
       layer you're reading (chars for meaning, hex for canonical,
       decimal for math). Offset column shows on rawChunkSection. */
    .bytes-chart {
      display: inline-block;
      vertical-align: middle;
      background: rgba(132, 204, 22, 0.06);
      border: 1px solid rgba(132, 204, 22, 0.18);
      padding: 0.25rem 0.4rem;
      border-radius: var(--radius);
      font-family: monospace;
      line-height: 1.15;
    }
    .bytes-group {
      border-collapse: collapse;
      border-spacing: 0;
    }
    .bytes-group + .bytes-group { margin-top: 0.25rem; }
    .bytes-group td, .bytes-group th {
      padding: 0 0.25rem;
      text-align: center;
      font-variant-numeric: tabular-nums;
      font-weight: normal;
    }
    .bytes-group .hex td  { font-size: 0.78rem; color: #4d7c0f; }
    .bytes-group .char td.printable { font-size: 0.85rem; color: var(--ink); font-weight: 500; }
    .bytes-group .char td.nonprint  { font-size: 0.85rem; color: var(--ink-dim); }
    .bytes-group .dec td  { font-size: 0.65rem; color: var(--ink-dim); }
    .bytes-group th {
      color: var(--ink-dim);
      font-size: 0.7rem;
      padding-right: 0.6rem;
      text-align: right;
      font-weight: normal;
    }
    .bytes-group.with-offset .hex th { color: #4d7c0f; }
    .bytes-chart-more {
      font-size: 0.75rem;
      margin-top: 0.3rem;
      font-style: italic;
    }

    /* Recursive typed-value tree — used for rehydrated views. Composites
       render in two modes: tv-tree-inline (Chrome-console-style, one
       line, used when every child is a primitive and the line fits) and
       tv-tree (multi-line, used otherwise). Both expose the same
       click-to-collapse opening bracket. */
    .tv-tree {
      font-size: 0.85rem;
      line-height: 1.4;
      font-family: monospace;
      margin: 0.3rem 0;
    }
    .tv-tree-row {
      padding-left: 1.25rem;
    }
    .tv-tree .tv-bracket,
    .tv-tree-inline .tv-bracket {
      color: var(--ink-dim);
      font-weight: 600;
    }
    .tv-tree .tv-bracket.clickable,
    .tv-tree-inline .tv-bracket.clickable {
      cursor: pointer;
    }
    .tv-tree .tv-bracket.clickable:hover,
    .tv-tree-inline .tv-bracket.clickable:hover {
      background: var(--flash);
      color: var(--ink);
    }
    .tv-tree .tv-key,
    .tv-tree-inline .tv-key {
      color: var(--ink-dim);
      margin-right: 0.25rem;
    }
    .tv-tree-inline {
      font-size: 0.85rem;
      font-family: monospace;
    }
    .tv-tree-inline .tv-sep { color: var(--ink-dim); }
    .tv-drill {
      cursor: pointer;
      text-decoration: underline dotted var(--ink-dim);
    }
    .tv-drill:hover { background: var(--flash); text-decoration-style: solid; }

    /* Storage tab's chunk-graph tree — same visual register as
       tv-tree, but each row is a chunk (chip + @addr + value preview)
       and indentation walks \`directReferences\`, surfacing the duples
       that the value tree hides. */
    .storage-tree {
      font-size: 0.85rem;
      margin: 0.4rem 0;
    }
    .storage-row {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.15rem 0;
      flex-wrap: wrap;
    }
    .storage-row .codec-chip { flex-shrink: 0; }
    .storage-toggle {
      cursor: pointer;
      width: 1rem;
      text-align: center;
      color: var(--ink-dim);
      font-weight: 600;
      text-decoration: none;
      user-select: none;
      flex-shrink: 0;
    }
    .storage-toggle:hover { color: var(--ink); }
    .storage-toggle.empty { cursor: default; opacity: 0.35; }
    .storage-toggle.empty:hover { color: var(--ink-dim); }
    .storage-preview { color: var(--ink-dim); }
    .storage-childcount {
      font-size: 0.75rem;
      color: var(--ink-dim);
      margin-left: auto;
    }
    .storage-children {
      padding-left: 1.25rem;
      border-left: 1px solid var(--rule);
      margin-left: 0.55rem;
    }

    /* codec-tag — colored codec name in the refs/referrers tables. Same
       palette as the byte-strip and the typed-value pills, so a chunk's
       codec reads visually consistent everywhere it appears. */
    .codec-tag { font-weight: 500; }
    .codec-tag.codec-commit    { color: #c2410c; }
    .codec-tag.codec-sig       { color: #b91c1c; }
    .codec-tag.codec-composite { color: #1e40af; }
    .codec-tag.codec-duple     { color: #6b21a8; }
    .codec-tag.codec-string    { color: #047857; }
    .codec-tag.codec-bytes     { color: #4d7c0f; }
    .codec-tag.codec-num       { color: #475569; }
    .codec-tag.codec-var       { color: #b45309; }
    .codec-tag.codec-other     { color: var(--ink-dim); }

    /* codec category palette — used by the SVG fills, the inspector chip,
       and any chip-styled element that wants to read as a chunk type. */
    .cat-commit    { fill: #f59e0b; background: #f59e0b; }
    .cat-sig       { fill: #ef4444; background: #ef4444; }
    .cat-composite { fill: #3b82f6; background: #3b82f6; }
    .cat-duple     { fill: #a855f7; background: #a855f7; }
    .cat-string    { fill: #10b981; background: #10b981; }
    .cat-bytes     { fill: #84cc16; background: #84cc16; }
    .cat-num       { fill: #64748b; background: #64748b; }
    .cat-var       { fill: #fbbf24; background: #fbbf24; }
    .cat-other     { fill: #cbd5e1; background: #cbd5e1; }

    /* codec chip — inline tag colored by codec category. Foreground
       colors are picked by relative luminance (Y = 0.2126R + 0.7152G +
       0.0722B): high-luminance backgrounds (lime, amber, yellow, light
       gray) use black text; mid-low luminance (red, blue, purple, slate)
       use white. Saturated mid-tones like emerald lean to white by
       convention even though the WCAG-correct call is marginal. */
    .codec-chip {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: var(--radius);
      font-size: 0.7rem;
      font-weight: 500;
      letter-spacing: 0.02em;
      line-height: 1;
      vertical-align: middle;
      color: #fff;
    }
    .codec-chip.cat-commit,
    .codec-chip.cat-bytes,
    .codec-chip.cat-var,
    .codec-chip.cat-other { color: #000; }

    /* Tab strip — hand-drawn underline aesthetic to match proto.css */
    .tabs {
      display: flex;
      gap: 1.25rem;
      border-bottom: 1.5px solid var(--rule);
      margin: 1.25rem 0 1rem;
    }
    .tab {
      padding: 0.45rem 0.1rem;
      margin-bottom: -1.5px;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: 0.85rem;
      color: var(--ink-dim);
      letter-spacing: 0.04em;
      text-transform: lowercase;
    }
    .tab:hover { color: var(--ink); }
    .tab.active {
      color: var(--ink);
      border-bottom-color: var(--ink);
      font-weight: 600;
    }

    pre.value {
      font-family: monospace;
      font-size: 0.8rem;
      background: var(--rule);
      border-radius: var(--radius);
      padding: 1rem;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
`

// Outer mount: page chrome (style, header, conn) wraps the view slot.
// The view-shape signal (viewKindDep) gates re-renders to kind/keyHex
// changes; the inner slots handle the rest. Mount owns its container,
// so the loading shim in index.html is wiped on first render.
mount(h`
  <style>${css}</style>
  <div class="header">
    <a class="brand-lockup" href="../../" title="streamo home">
      <img src="../../streamo.svg" alt="">streamo
    </a>
    <span class="page-title">explorer</span>
  </div>
  <div class=${['conn', connClass]}>${connText}</div>
  ${() => {
    viewKindDep()
    switch (view.kind) {
      case 'registry': return h`<section class="view" data-key="view-registry">${RegistryView()}</section>`
      case 'at':       return h`<section class="view" data-key=${`view-at-${view.keyHex}`}>${AtView({ keyHex: view.keyHex })}</section>`
      default:         return h`<div class="empty">?</div>`
    }
  }}
`, document.body, recaller)
