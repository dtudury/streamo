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
import { truncKey, truncHex, fmtDate, safeJSON } from './format.js'
import { isCommitShape, isDuple, codecCategory, isInlinablePrimitive, estimateEntryWidth } from './shapes.js'
import {
  commitsNewestFirst, findCoveringSig, commitsCoveredBySignature,
  valueAndChildren, resolveHead, safeGet, buildDirectReferrerIndex
} from './walking.js'
import { makeVerifier, kindBanner, verifyLabel, verifyBadge } from './verify.js'
import { typedValue, bytesChart } from './render.js'
import { makeTrees } from './trees.js'

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

// Signature-verification cache, bound to fire() so async-resolved
// statuses trigger a re-render. See verify.js for the cache shape.
const verifyStatus = makeVerifier(fire)

// Three tree renderers + their expand/collapse state + their action
// dispatcher, all bound to fire() — see trees.js.
const { valueTree, storageTree, referenceTree, handleTreeAction } = makeTrees(fire)

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

// ── Mount ─────────────────────────────────────────────────────────────────

const appEl = document.getElementById('app')

// Outer mount slot. Reads viewKindDep ONLY — re-runs on view.kind
// or view.keyHex changes (registry ↔ at, or switching repos). It does
// NOT re-run on address changes, chunk arrivals, tab clicks, or any
// other bridge fire. That's the whole point of the decomposition:
// keep the at-view's <section> (and the strip-container inside it)
// alive across intra-repo navigation so click-to-navigate doesn't
// rebuild the strip and reset its scrollLeft.
//
// Each view gets a data-keyed <section> so mount's matcher distinguishes
// them — switching from registry to an at-view, or between repos, drops
// the old section and fresh-mounts the new one. RegistryView and AtView
// each do their own internal reactivity (inner slots reading dep() and
// hoverDep()) for everything within a view.
mount(h`${() => {
  viewKindDep()
  switch (view.kind) {
    case 'registry': return h`<section class="view" data-key="view-registry">${RegistryView()}</section>`
    case 'at':       return h`<section class="view" data-key=${`view-at-${view.keyHex}`}>${AtView({ keyHex: view.keyHex })}</section>`
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
    case 'expand-tree':
    case 'collapse-tree':
    case 'expand-storage':
    case 'collapse-storage':
    case 'expand-refs':
    case 'collapse-refs':
      handleTreeAction(el.dataset.action, `${el.dataset.keyhex}:${el.dataset.addr}`)
      return
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
    const currentChunk = container.querySelector('.chunk.current')
    const currentAddr = currentChunk?.getAttribute('data-addr') ?? null
    const lastCurrent = container.dataset.lastCurrent ?? null
    const currentChanged = currentAddr !== null && currentAddr !== lastCurrent
    if (currentAddr !== null) container.dataset.lastCurrent = currentAddr
    // Auto-pin to HEAD when the strip is freshly mounted (scrollLeft === 0)
    // or while the user is following live activity at the right edge.
    // Otherwise, when navigation lands on a chunk that's off-screen
    // (commit selector, click on a chip's @addr link, keyboard nav),
    // bring it into view. Hover already pre-scrolls during dropdown
    // peeks; this catches the cases hover didn't trigger.
    if (container.scrollLeft === 0 || atRight) {
      container.scrollLeft = container.scrollWidth
    } else if (currentChanged && currentChunk) {
      currentChunk.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
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
// matching chunk in the byte-map, populates the chunk inspector below
// the strip with codec/addr/length, and (if the hovered chunk is a
// signature) lights up its covered byte range as an overlay band on
// the strip. If the hover came from somewhere other than the strip
// itself, smooth-scroll the matching chunk into view in the strip.
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
  // Look up the chunk's data on the strip rect for sig-coverage overlay.
  const stripRect = matches[0]?.closest('.byte-strip-container') ? matches[0]
    : appEl.querySelector(`.byte-strip .chunk[data-addr="${addr}"]`)
  if (stripRect) {
    const fromX = stripRect.getAttribute('data-sig-from-x')
    const toX   = stripRect.getAttribute('data-sig-to-x')
    if (fromX != null && toX != null) {
      const overlay = stripRect.closest('.byte-strip').querySelector('.sig-coverage')
      if (overlay) {
        overlay.setAttribute('x', fromX)
        overlay.setAttribute('width', String(parseFloat(toX) - parseFloat(fromX)))
        overlay.classList.add('active')
      }
    }
  }
  // Live preview: if the hovered chunk is on the byte strip, set
  // hoveredAddress so the page content below renders for that chunk.
  // Click to actually navigate. Only fire if the address changed —
  // moving within the same chunk shouldn't re-render.
  const onStrip = el.closest('.byte-strip-container')
  const newHover = onStrip ? +addr : null
  if (newHover !== hoveredAddress) {
    hoveredAddress = newHover
    hoverFire()
  }
})
appEl.addEventListener('mouseout', e => {
  const el = e.target.closest('[data-addr]')
  if (!el) return
  appEl.querySelectorAll('.byte-map .chunk.hovered').forEach(c => c.classList.remove('hovered'))
  appEl.querySelectorAll('.sig-coverage.active').forEach(o => o.classList.remove('active'))
  // Clear hoveredAddress unless the cursor is moving to ANOTHER chunk
  // on the strip. The previous check ("still inside .byte-strip-container")
  // treated the direction labels and any blank-space as "still hovering,"
  // which left the page stuck on the previously hovered chunk's content.
  // Requiring .chunk[data-addr] specifically means moving off a chunk
  // anywhere — out of the strip OR to its non-chunk regions — reverts.
  const goingToChunk = e.relatedTarget?.closest?.('.byte-strip-container .chunk[data-addr]')
  if (!goingToChunk && hoveredAddress !== null) {
    hoveredAddress = null
    hoverFire()
  }
})
