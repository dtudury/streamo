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

      // Storage tab: position in stream + reachable commit, then this
      // chunk's outgoing refs, raw bytes, and referrers. All for
      // contentAddr (the peeked chunk during hover, otherwise the
      // URL's address). Header is rendered by the sibling header slot.
      if (atTab === 'storage') {
        return h`
          ${chunkContextSection(repo, keyHex, contentAddr)}
          ${outgoingReferencesSection(repo, keyHex, contentAddr)}
          ${rawChunkSection(repo, contentAddr)}
          ${referrersSection(repo, keyHex, contentAddr)}
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
        `
      }

      // Primitive: just show it.
      return h`
        ${kindBanner(codecType.toLowerCase())}
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
      const inspectorText = inspectorChunk
        ? `${inspectorChunk.codecType} · @${inspectorChunk.address} · ${inspectorChunk.length} bytes${total > 0 ? ` (${((inspectorChunk.length / total) * 100).toFixed(2)}% of ${total})` : ''}`
        : `${chunks.length} chunks · ${total} bytes`
      const isPeekActive = hoveredAddress != null && hoveredAddress !== currentAddress
      return h`<div class=${['chunk-inspector', isPeekActive ? 'active' : null]}
                    data-key=${`inspector-${keyHex}`}>${inspectorText}</div>`
    }}
  `
}

// Commit reachability — the *semantic* parent of every chunk. Commits
// don't reference their data tree via asRefs; they store the address
// as a number value (a FLOAT64), and the convention "follow this
// number to find your data" is implicit. So the structural referrer
// index doesn't connect chunks to their owning commits. This walk
// makes the connection: for each commit, BFS from commit.dataAddress
// through asRefs and mark every reachable chunk. Result: chunk
// address → set of commit addresses whose dataAddress reach it.
function buildCommitReachabilityIndex (repo) {
  const reach = new Map()  // chunk addr → Set<commit addr>
  let walk = repo.byteLength - 1
  while (walk >= 0) {
    const code = repo.resolve(walk)
    if (!code || !code.length) break
    const type = repo.footerToCodec[code.at(-1)]?.type
    if (type === 'OBJECT') {
      let value
      try { value = repo.decode(walk) } catch {}
      if (value && isCommitShape(value)) {
        const visited = new Set()
        const stack = [value.dataAddress]
        while (stack.length) {
          const a = stack.pop()
          if (typeof a !== 'number' || visited.has(a)) continue
          visited.add(a)
          if (!reach.has(a)) reach.set(a, new Set())
          reach.get(a).add(walk)
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
    walk -= code.length
  }
  return reach
}

// Storage-tab context: which commits reach this chunk. (Position info
// — byte range, percentage, codec — now lives in the persistent chunk
// inspector under the byte strip, so this section focuses on the
// "story" of the chunk's place in user data.) Uses the commit-
// reachability index above, falling back to the structural referrer
// BFS for chunks not reachable from any commit (typically sigs and
// other top-level chunks).
function chunkContextSection (repo, keyHex, address) {
  const reach = buildCommitReachabilityIndex(repo)
  const reachingCommits = reach.get(address)
  let label = null
  if (reachingCommits && reachingCommits.size) {
    // Show the most recent commit (highest address) reaching this chunk,
    // plus a count if there are more.
    const sorted = [...reachingCommits].sort((a, b) => b - a)
    const newest = sorted[0]
    label = h`
      <a class="addr-link" data-action="open-at" data-keyhex=${keyHex} data-addr=${newest}>@${newest}</a>
      ${sorted.length > 1
        ? h` <span class="dim">(and ${sorted.length - 1} earlier commit${sorted.length === 2 ? '' : 's'})</span>`
        : null}
    `
  } else {
    // Fall back to the structural BFS — catches sig chunks (referenced
    // by nothing in the asRefs sense, but the user might want to know
    // some commit they cover).
    const index = buildReferrerIndex(repo)
    const visited = new Set()
    let frontier = [address]
    let depth = 0
    while (frontier.length && depth < 64 && !label) {
      const next = []
      for (const a of frontier) {
        if (visited.has(a)) continue
        visited.add(a)
        const parents = index.get(a) ?? []
        for (const p of parents) {
          try {
            const decoded = repo.decode(p.address)
            if (isCommitShape(decoded)) {
              label = h`<a class="addr-link" data-action="open-at" data-keyhex=${keyHex} data-addr=${p.address}>@${p.address}</a> <span class="dim">(via structural ref)</span>`
              break
            }
          } catch {}
          next.push(p.address)
        }
        if (label) break
      }
      frontier = next
      depth++
    }
  }
  if (!label) {
    label = h`<span class="dim">no commit references this chunk</span>`
  }
  return h`
    <h3>reachable from <span class="dim">user-meaningful commits</span></h3>
    <p class="dim" style="font-size: 0.85rem; margin-bottom: 0.4rem;">
      commits hold their data's location as a number-valued <code>dataAddress</code> field, so reachability isn't a structural ref — it's "starting from each commit's data, this chunk shows up."
    </p>
    <p>${label}</p>
  `
}

// Outgoing references — what THIS chunk points to in the chunk graph (as
// opposed to "referenced by", which is what points to this chunk). Walks
// the codec's parts via repo.directReferences. Codec-by-codec — exposes
// the storage chain so e.g. STRING → UINT8ARRAY → DUPLE → DUPLE → … → WORD
// is browsable one click at a time. Codec column is color-coded to match
// the byte-strip palette so the chain reads visually.
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
            preview = typedValue(repo.decode(childAddr))
          } catch { preview = '(error)' }
          return h`
            <tr data-key=${`out${i}@${childAddr}`} data-action="open-at"
                data-keyhex=${keyHex} data-addr=${childAddr}>
              <td class=${['mono', 'codec-tag', `codec-${codecCategory(codecType)}`]}>${codecType}</td>
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
          try { preview = typedValue(repo.decode(r.address)) }
          catch { preview = '(error)' }
          return h`
            <tr data-key=${`r${r.address}`} data-action="open-at"
                data-keyhex=${keyHex} data-addr=${r.address}>
              <td class=${['mono', 'codec-tag', `codec-${codecCategory(r.codecType || '?')}`]}>${r.codecType || '?'}${r.count > 1 ? ` ×${r.count}` : ''}</td>
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
    return h`<span class="tv tv-bytes" title=${v.length === 0 ? 'EMPTY_UINT8ARRAY' : (v.length <= 4 ? 'WORD or UINT8ARRAY' : 'UINT8ARRAY')}>Uint8Array(${v.length})</span>`
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
    case 'expand-tree': {
      const k = `${el.dataset.keyhex}:${el.dataset.addr}`
      forceExpanded.add(k)
      forceCollapsed.delete(k)
      return fire()
    }
    case 'collapse-tree': {
      const k = `${el.dataset.keyhex}:${el.dataset.addr}`
      forceCollapsed.add(k)
      forceExpanded.delete(k)
      return fire()
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
    // Auto-pin to HEAD only when the strip is freshly mounted (scroll
    // hasn't been touched yet, so scrollLeft === 0). For recycled strips
    // mount restores the previous scrollLeft, so this branch correctly
    // skips and the user's position is preserved. Live updates still
    // pin if the user is already at the right edge (atRight).
    if (container.scrollLeft === 0 || atRight) {
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
