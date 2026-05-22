// The commit wheel — a Price-is-Right big-wheel picker for the top of an
// at-view. Commits stack newest-first; flick, drag, or scroll spins the
// wheel, momentum carries it, and it snaps so exactly one commit always
// rests under the centre band. It's the always-on replacement for the
// old <details> commit dropdown: ambient navigation, not modal selection.
//
// Two halves, mirroring the byte strip's makeByteStreamSection /
// setupInteractions split:
//
//   commitWheelSection(repo, keyHex, currentAddr)
//     Emits the h tree. Memoized per (repo, byteLength) so switching
//     tabs doesn't rebuild hundreds of rows. Crucially it carries NO
//     transform in the h tree — the resting position is pure imperative
//     state the engine owns, so a tab re-render can't reset a spin.
//
//   setupCommitWheel({ appEl })
//     Document-level gesture + momentum engine. Drives the track's
//     translateY directly on requestAnimationFrame — the spin never
//     touches the recaller, so it stays smooth no matter what the page
//     below costs to render. Returns { syncWheel }, a post-render pass
//     that seeds a freshly-mounted wheel's resting position.
//
// Phase 1: the wheel spins and snaps. It does NOT navigate yet — picking
// a commit (writing the URL on settle) is Phase 2's job.

import { h } from '../../streamo/h.js'
import { fmtDate } from './format.js'
import { commitsNewestFirst } from './walking.js'

// Geometry — the single source of truth. CSS handles colour and type
// only; every pixel position below is inline-styled from these constants
// so the JS and the stylesheet can't drift. VISIBLE_ROWS is odd so one
// row sits dead-centre under the band.
const ROW_H = 34
const VISIBLE_ROWS = 5
const CENTER = (VISIBLE_ROWS - 1) / 2

// The track translateY that parks list-index `i` under the centre band,
// and its rounded inverse — at rest, offsets are whole multiples of ROW_H.
const offsetForIndex = i => (CENTER - i) * ROW_H
const indexForOffset = off => CENTER - Math.round(off / ROW_H)

// ── Renderer ────────────────────────────────────────────────────────────────

export function makeCommitWheel () {
  // Memoize per (repo, byteLength): the commit walk + row build only
  // change when new bytes land. Tab switches re-run the header slot but
  // hit this cache, so the wheel's DOM (and its live transform) is left
  // untouched.
  const cache = new WeakMap() // repo → { byteLength, result }
  return function commitWheelSection (repo, keyHex, currentAddr) {
    const cached = cache.get(repo)
    if (cached && cached.byteLength === repo.byteLength) return cached.result
    const result = buildCommitWheel(repo, keyHex, currentAddr)
    cache.set(repo, { byteLength: repo.byteLength, result })
    return result
  }
}

function buildCommitWheel (repo, keyHex, currentAddr) {
  const entries = [...commitsNewestFirst(repo)].filter(e => e.kind === 'commit')
  if (!entries.length) return null
  const tagFor = i => i === 0 ? 'HEAD' : `HEAD-${i}`
  // Where the wheel rests on first mount — the commit the URL is on, or
  // HEAD if the address isn't a commit (a sig, raw bytes, a deep link).
  const found = entries.findIndex(e => e.address === currentAddr)
  const initialIndex = found < 0 ? 0 : found
  return h`
    <div class="commit-wheel" data-key=${`wheel-${keyHex}`}
         data-count=${entries.length} data-initial-index=${initialIndex}
         style=${`height:${VISIBLE_ROWS * ROW_H}px`}>
      <div class="wheel-track" data-key="wheel-track">
        ${entries.map((e, i) => h`
          <div class="wheel-row" data-key=${`wr${e.address}`}
               data-index=${i} data-commit-addr=${e.address}
               style=${`top:${i * ROW_H}px;height:${ROW_H}px`}>
            <span class="wheel-tag">${tagFor(i)}</span>
            <span class="wheel-msg">${e.message || h`<span class="dim">(no message)</span>`}</span>
            <span class="wheel-when">${fmtDate(e.date)}</span>
          </div>
        `)}
      </div>
      <div class="wheel-band" style=${`top:${CENTER * ROW_H}px;height:${ROW_H}px`}></div>
      <div class="wheel-fade wheel-fade-top"></div>
      <div class="wheel-fade wheel-fade-bottom"></div>
    </div>
  `
}

// ── Gesture + momentum engine ───────────────────────────────────────────────

export function setupCommitWheel ({ appEl }) {
  // Friction per frame, the snap easing factor, and a cap on flick speed
  // so a violent gesture doesn't shoot the wheel off its ends.
  const FRICTION = 0.94
  const SNAP = 0.2
  const MAX_V = 80

  const seen = new WeakSet() // tracks the engine has already seeded
  let drag = null
  let raf = null
  let wheelStop = null

  const trackOf = wheel => wheel.querySelector('.wheel-track')
  const boundsOf = wheel => {
    const count = +wheel.dataset.count || 1
    return { min: offsetForIndex(count - 1), max: offsetForIndex(0) }
  }
  const clamp = (v, { min, max }) => Math.max(min, Math.min(max, v))

  function applyOffset (track, off) {
    track._offset = off
    track.style.transform = `translateY(${off}px)`
  }
  function cancelMomentum () {
    if (raf != null) { cancelAnimationFrame(raf); raf = null }
  }

  // Mark the commit currently under the band. Phase 1 this is purely
  // cosmetic; Phase 2 will navigate from here instead.
  function settleRow (wheel, track) {
    const last = (+wheel.dataset.count || 1) - 1
    const idx = clamp(indexForOffset(track._offset), { min: 0, max: last })
    for (const row of track.children) {
      row.classList.toggle('selected', +row.dataset.index === idx)
    }
  }

  // Post-render pass — a wheel the engine has never seen gets its resting
  // position seeded from data-initial-index. Wheels it already knows are
  // left strictly alone: the engine owns their transform, and a tab
  // re-render must never reset a spin in progress.
  function syncWheel () {
    for (const wheel of appEl.querySelectorAll('.commit-wheel')) {
      const track = trackOf(wheel)
      if (!track || seen.has(track)) continue
      seen.add(track)
      const idx = +wheel.dataset.initialIndex || 0
      applyOffset(track, clamp(offsetForIndex(idx), boundsOf(wheel)))
      settleRow(wheel, track)
    }
  }

  // The momentum loop: glide under friction, then ease into the nearest
  // whole-row offset. Gliding past an end flips straight to the snap
  // phase so the wheel eases into its bound instead of slamming it.
  function momentum (wheel, track, velocity) {
    cancelMomentum()
    const bounds = boundsOf(wheel)
    let v = Math.max(-MAX_V, Math.min(MAX_V, velocity))
    let snapping = false
    let target = 0
    const frame = () => {
      if (!snapping) {
        const off = track._offset + v
        v *= FRICTION
        if (off > bounds.max || off < bounds.min || Math.abs(v) < 0.5) {
          snapping = true
          target = clamp(ROW_H * Math.round(off / ROW_H), bounds)
        } else {
          applyOffset(track, off)
          raf = requestAnimationFrame(frame)
          return
        }
      }
      const diff = target - track._offset
      if (Math.abs(diff) < 0.5) {
        applyOffset(track, target)
        raf = null
        settleRow(wheel, track)
        return
      }
      applyOffset(track, track._offset + diff * SNAP)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
  }

  // Drag — a 3px threshold before a pointerdown counts as a spin, so a
  // tap falls through harmlessly. Velocity is sampled per move (px per
  // 16ms frame) and handed to the momentum loop on release.
  appEl.addEventListener('pointerdown', e => {
    if (e.button) return
    const wheel = e.target.closest('.commit-wheel')
    const track = wheel && trackOf(wheel)
    if (!track) return
    cancelMomentum()
    drag = {
      wheel, track, pointerId: e.pointerId,
      startY: e.clientY, startOffset: track._offset ?? 0,
      lastY: e.clientY, lastT: performance.now(), velocity: 0, moved: false
    }
  })
  appEl.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return
    const dy = e.clientY - drag.startY
    if (!drag.moved) {
      if (Math.abs(dy) < 3) return
      drag.moved = true
      drag.wheel.classList.add('spinning')
      try { drag.wheel.setPointerCapture(e.pointerId) } catch {}
    }
    const now = performance.now()
    const dt = (now - drag.lastT) || 16
    drag.velocity = (e.clientY - drag.lastY) / dt * 16
    drag.lastY = e.clientY
    drag.lastT = now
    applyOffset(drag.track, clamp(drag.startOffset + dy, boundsOf(drag.wheel)))
    e.preventDefault()
  })
  function endDrag () {
    if (!drag) return
    const d = drag
    drag = null
    d.wheel.classList.remove('spinning')
    if (!d.moved) return
    // A drag that ended in a pause shouldn't fling — drop stale velocity.
    const v = performance.now() - d.lastT > 80 ? 0 : d.velocity
    momentum(d.wheel, d.track, v)
  }
  appEl.addEventListener('pointerup', endDrag)
  appEl.addEventListener('pointercancel', endDrag)

  // Mouse-wheel / trackpad — nudge the offset directly, then snap once
  // the deltas stop arriving (a momentum call with zero velocity).
  appEl.addEventListener('wheel', e => {
    const wheel = e.target.closest('.commit-wheel')
    const track = wheel && trackOf(wheel)
    if (!track) return
    e.preventDefault()
    cancelMomentum()
    applyOffset(track, clamp((track._offset ?? 0) - e.deltaY * 0.5, boundsOf(wheel)))
    clearTimeout(wheelStop)
    wheelStop = setTimeout(() => momentum(wheel, track, 0), 90)
  }, { passive: false })

  return { syncWheel }
}
