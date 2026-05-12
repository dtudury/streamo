// The three recursive tree renderers — the user-meaningful value tree
// (asRefs), the chunk-graph DOWN tree (directReferences), and the
// chunk-graph UP tree (referrer index). All three share an expansion
// model (depth-based default, override per-node via a LiveSource),
// but namespaced so "expand this chunk" in the value tab doesn't
// affect the same chunk in the storage tab.
//
// State + the matching expand/collapse action handlers live together
// inside makeTrees(recaller). Tree functions read state.get(...) on a
// key like `${tree}:${keyHex}:${address}` and auto-subscribe to that
// specific key. main.js's click delegator hands action+key to
// handleTreeAction which does state.set(...) — finer than the old
// "fire wakes every tree slot" semantics.

import { h } from '../../streamo/h.js'
import { codecCategory, isInlinablePrimitive, estimateEntryWidth } from './shapes.js'
import { typedValue } from './render.js'
import { buildDirectReferrerIndex } from './walking.js'
import { liveObject } from '../../streamo/LiveSource.js'

export function makeTrees (recaller) {
  // One LiveSource for all three trees' expand/collapse state. Keys
  // are `${tree}:${keyHex}:${address}` where tree ∈ {value, storage,
  // refs}; values are 'expand' | 'collapse' | undefined (undefined =
  // use the default depth-based decision).
  const force = liveObject({}, { recaller, name: 'trees' })

  // Convenience: a slot's `force.get(k)` registers it on key k; the
  // depth-based default kicks in when the key is undefined.
  const isExpanded = (tree, keyHex, address, depth) => {
    const v = force.get(`${tree}:${keyHex}:${address}`)
    return v === 'expand' || (v !== 'collapse' && depth > 0)
  }

  // Recursive typed-value tree — like typedValue, but expands composites
  // inline up to `depth` levels deep. Beyond depth, composites render as
  // un-expanded chips. Click a chip to expand IN PLACE; click an expanded
  // composite's opening bracket to collapse back to a chip.
  //
  // Default depth=3 covers `{ name, messages: [{text, at}, ...] }` —
  // outer object expanded, messages array expanded, message objects
  // expanded, and primitives like text/at render inline.
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
    if (!isExpanded('value', keyHex, address, depth)) {
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
  //   1. Walks `directReferences` (the actual chunk graph) instead of
  //      `asRefs` (the user-meaningful tree). DUPLEs that the value tab
  //      hides as scaffolding are surfaced here as their own rows —
  //      seeing them IS the storage view's job.
  //   2. Every node shows codec chip + clickable @addr + value preview.
  //      The chip and the preview share the codec palette, so a STRING
  //      reads emerald all the way across.
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
    const expand = isExpanded('storage', keyHex, address, depth)
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

  // Recursive reference tree — twin of storageTree but walks UP through
  // the chunk graph instead of DOWN. Where storageTree's leaves are
  // chunks that don't reference anything (a single-byte WORD), this
  // tree's leaves are chunks that NOTHING references — graph roots,
  // typically commits and signatures. The tree is rooted at the URL's
  // chunk and grows toward those roots: "who uses this? and who uses
  // THAT? and who uses that?" all the way up.
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
    const expand = isExpanded('refs', keyHex, address, depth)
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

  // Dispatcher for the six tree expand/collapse actions. Action shape:
  // `${verb}-${kind}` where verb ∈ {expand, collapse} and kind ∈
  // {tree, storage, refs} ('tree' historically meant value-tree).
  // Returns true if handled, false otherwise.
  function handleTreeAction (action, k) {
    const dash = action.indexOf('-')
    if (dash < 0) return false
    const verb = action.slice(0, dash)
    const kind = action.slice(dash + 1)
    if (verb !== 'expand' && verb !== 'collapse') return false
    const tree = kind === 'tree' ? 'value' : kind
    if (tree !== 'value' && tree !== 'storage' && tree !== 'refs') return false
    force.set(`${tree}:${k}`, verb)
    return true
  }

  return { valueTree, storageTree, referenceTree, handleTreeAction }
}
