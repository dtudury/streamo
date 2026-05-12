// The at-view — the page you see after picking a repo from the
// registry. Two reactive slots: HEADER (commit selector + byte strip
// + tabs) reacts to bridge fires only; CONTENT reacts to bridge AND
// hover, so the page peeks at the hovered chunk without re-rendering
// the strip itself.
//
// CONTENT branches by tab (value / storage / refs) and within the
// value tab branches by codec (commit / duple / signature / object /
// array / primitive). Each branch composes pre-built pieces from
// other modules — by the time you're reading this, AtView is mostly
// glue.

import { h } from '../../streamo/h.js'
import { truncKey, truncHex, safeJSON } from './format.js'
import { isCommitShape } from './shapes.js'
import { valueAndChildren, resolveHead, findCoveringSig, safeGet } from './walking.js'
import { typedValue } from './render.js'
import { kindBanner, verifyBadge, verifyLabel } from './verify.js'
import { repoReuseStats, valueEconomics } from './analytics.js'
import { changedPaths } from '../../streamo/Streamo.js'

export function makeAtView (deps) {
  const {
    state, view, registry,
    commitSelectorSection, byteStreamSection,
    repoExtras, rawChunkSection, sigDetailBody,
    valueTree, storageTree, referenceTree,
    verifyStatus
  } = deps

  return function AtView ({ keyHex }) {
    // AtView's body is built once per repo (the outer mount slot only
    // re-runs on view().kind / view().keyHex changes). Anything that
    // depends on the current address must read view().address inside
    // a reactive cell, NOT capture it in closure here. Same for resolved
    // chunk lookups: each slot calls resolveContext(repo) on every run.
    const resolveContext = (repo) => {
      let resolved = view().address
      if (resolved === 'HEAD') {
        resolved = resolveHead(repo)
        if (resolved === undefined) return { state: 'no-head' }
      }
      if (resolved >= repo.byteLength) return { state: 'loading' }
      return { state: 'ok', resolved }
    }

    return h`
      <a class="back" data-action="back-registry">← all repos</a>
      <div class="keyfull">
        <a class="repo-link" data-action="back-repo" data-keyhex=${keyHex}>${truncKey(keyHex)}</a>
        <span class="dim"> @ ${() => view().address}</span>
      </div>

      ${() => {
        // HEADER slot — auto-subscribes via the reads inside:
        // `registry.get` reports on (registry, 'keys') for new repos;
        // `resolveContext` reads `repo.byteLength` which reports on
        // (repo, 'length') for chunk arrivals; state.get('atTab') in
        // the tab indicators registers on the tab key. Does NOT
        // re-run on hover — only the CONTENT slot reads state.hovered,
        // so hovering the strip leaves the selector + strip + tabs
        // untouched.
        const repo = registry.get(keyHex)
        if (!repo) return null
        const ctx = resolveContext(repo)
        if (ctx.state !== 'ok') return null
        const tabs = h`
          <nav class="tabs">
            <a class=${() => ['tab', state.get('atTab') === 'value'   ? 'active' : null]}
               data-action="set-tab" data-tab="value">value</a>
            <a class=${() => ['tab', state.get('atTab') === 'storage' ? 'active' : null]}
               data-action="set-tab" data-tab="storage">storage</a>
            <a class=${() => ['tab', state.get('atTab') === 'refs'    ? 'active' : null]}
               data-action="set-tab" data-tab="refs">refs</a>
          </nav>
        `
        const selector = commitSelectorSection(repo, keyHex, ctx.resolved)
        const bytes = byteStreamSection(repo, keyHex, ctx.resolved)
        return h`<div class="atview-header">${selector}${bytes}${tabs}</div>`
      }}

      ${() => {
        // CONTENT slot — auto-subscribes via the reads inside:
        // registry.get + repo.byteLength via resolveContext + state.get
        // for hovered/address/atTab. Renders the tab body for
        // contentAddr — the hovered address if peeking, else the URL.
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
        const resolvedAddr = ctx.resolved

        // Live hover preview: contentAddr peeks at the hovered chunk;
        // header still shows resolvedAddr (the URL position). Click to
        // navigate.
        const hovered = state.get('hovered')
        const contentAddr = hovered != null && hovered < repo.byteLength
          ? hovered
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

        const atTab = state.get('atTab')

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
}
