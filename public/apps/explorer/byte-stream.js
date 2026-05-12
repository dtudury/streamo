// The color-coded SVG byte-stream strip, the live inspector below it,
// and the per-codec rollup table. Every chunk is a clickable rect tinted
// by codec category; signature chunks carry their coverage range in data
// attrs so hover anywhere on the page can light up "what bytes does this
// sig sign" via an overlay band.
//
// Two deps cross from main.js: hoverDep (the explorer recaller's read
// reporter for hoverSignal — so the inspector slot re-runs as the user
// moves across the strip) and getHoveredAddress (current hovered chunk,
// owned by interactions.js).

import { h } from '../../streamo/h.js'
import { codecCategory } from './shapes.js'
import { repoReuseStats } from './analytics.js'

export function makeByteStreamSection ({ hoverDep, getHoveredAddress }) {
  // Byte stream as a color-coded SVG strip — every chunk is a rect, color
  // coded by codec category. Modestly zoomed so even 1-byte chunks have a
  // clickable width; horizontally scrollable, click-drag-to-pan inside the
  // strip (cursor: grab/grabbing). First render auto-scrolls to HEAD (the
  // newest content, at the right) and stays pinned there if you haven't
  // dragged off it — so a live stream "follows" the newest activity. The
  // signed-commits dropdown above is for jumping to a known commit; this
  // strip is for poking around between them.
  return function byteStreamSection (repo, keyHex, currentAddress) {
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
        const hovered = getHoveredAddress()
        const inspectorAddr = hovered != null && hovered < total
          ? hovered
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
        const isPeekActive = hovered != null && hovered !== currentAddress
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
}
