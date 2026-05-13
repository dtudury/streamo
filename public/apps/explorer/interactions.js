// Document-level event wiring for the explorer:
//   - click-drag-to-pan on the byte strip,
//   - mouseover/mouseout cross-highlight + live-preview hover (writes
//     `hovered`, a single-value LiveSource imported from context),
//   - post-render byte-strip pin-to-HEAD (`syncStrips`).
//
// suppressClickUntil and dragState are closure-local. Hover state lives
// in context as a liveValue; interactions writes, byte-stream and
// at-view read.

import { hovered } from './context.js'

export function setupInteractions ({ appEl }) {
  let suppressClickUntil = 0
  let dragState = null

  // On first render of a strip, scroll to the right edge (HEAD = newest
  // content). On subsequent renders, only re-pin if the user is already at
  // or near the right edge — so a live stream "follows" without dragging
  // you back if you've scrolled into history.
  function syncStrips () {
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
    // Live preview: if the hovered chunk is on the byte strip, write
    // the `hovered` liveValue so the content area peeks ahead. Click
    // navigates for real. Only set if the address changed — moving
    // within one chunk shouldn't fire.
    const onStrip = el.closest('.byte-strip-container')
    const next = onStrip ? +addr : null
    if (next !== hovered.get()) hovered.set(next)
  })
  appEl.addEventListener('mouseout', e => {
    const el = e.target.closest('[data-addr]')
    if (!el) return
    appEl.querySelectorAll('.byte-map .chunk.hovered').forEach(c => c.classList.remove('hovered'))
    appEl.querySelectorAll('.sig-coverage.active').forEach(o => o.classList.remove('active'))
    // Clear `hovered` unless the cursor is moving to ANOTHER chunk on
    // the strip. The previous check ("still inside .byte-strip-container")
    // treated the direction labels and any blank-space as "still hovering,"
    // which left the page stuck on the previously hovered chunk's content.
    // Requiring .chunk[data-addr] specifically means moving off a chunk
    // anywhere — out of the strip OR to its non-chunk regions — reverts.
    const goingToChunk = e.relatedTarget?.closest?.('.byte-strip-container .chunk[data-addr]')
    if (!goingToChunk && hovered.get() !== null) hovered.set(null)
  })

  return {
    isClickSuppressed: () => Date.now() < suppressClickUntil,
    syncStrips
  }
}
