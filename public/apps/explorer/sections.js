// The smaller AtView sections: the commit-selector dropdown at the top
// of an at-view, the "other storage chunks" tuck-away, the sig-detail
// table for when you've landed on a signature directly, and the raw
// hex-dump section. All emit h; none own state.
//
// `verifyStatus` crosses from main.js for the commit-selector verify
// badge; reading from it inside the badge slot auto-subscribes the slot
// via the verify cache's LiveSource.

import { h } from '../../streamo/h.js'
import { truncHex, fmtDate } from './format.js'
import { commitsNewestFirst, commitsCoveredBySignature, computeSignedFrom } from './walking.js'
import { typedValue, bytesChart } from './render.js'
import { verifyBadge } from './verify.js'

export function makeSections ({ verifyStatus }) {
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
    const signedFrom = computeSignedFrom(repo, sigAddress, chunkLen)
    const sigChunkStart = sigAddress - chunkLen + 1
    const covered = commitsCoveredBySignature(repo, signedFrom, signedTo)
    return h`
      <table class="kv">
        <tbody>
          <tr>
            <td>covers</td>
            <td>@${signedFrom} through @${signedTo} (${signedTo - signedFrom + 1} bytes)</td>
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

  // StreamoRecord-wide "other storage chunks" list — Duples, raw OBJECTs, ARRAYs,
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

  // Hex dump of the chunk at this address — the raw bytes that live in
  // the stream. Shown beneath the value/storage view on the value-tab,
  // and on its own on the storage tab for non-DUPLE chunks. Truncates
  // at 512 bytes so a giant value chunk doesn't blow up the page.
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

  return { sigDetailBody, commitSelectorSection, repoExtras, rawChunkSection }
}
