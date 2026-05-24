/**
 * @file SM-2 (lite) — a tiny spaced-repetition algorithm. Pure, no
 * reactive coupling, no DOM. Lives in its own file so the math can
 * be read (and tested) without scrolling past the rest of the app.
 *
 * Grade indices map to a 4-button UI scale:
 *   0 = 'again' — lapse. Interval resets; due 1 minute out so the
 *       card falls out of this session's queue but comes back next.
 *   1 = 'hard'  — got it right but barely. Interval shrinks by
 *       HARD_MULT (0.5×); reps stays the same — slow-down, not lapse.
 *   2 = 'good'  — got it right normally. Interval grows by ease.
 *   3 = 'easy'  — got it right with no friction. Same path as good
 *       but with an extra EASY_BONUS multiplier so it's visibly
 *       different from good on a single grade, not just over time.
 *
 * The 'again' → 1-minute-due trick lets the card fall out of *this
 * session's* derived queue but come back next time. Session-relevance
 * encoded in the algorithm, so the study queue can stay a stateless
 * derived value (folded over the reviews stream every render).
 */

export const DEFAULT_REVIEW = { ease: 2.5, interval: 0, due: 0, reps: 0, lastReviewAt: 0 }

// **Retention target** — the per-deck slider knob. Maps a desired
// retention rate (e.g., 0.95 = "I want to remember 95% of cards when
// they come due") to a multiplier applied to all due times. The
// formula comes from the forgetting curve: if R = exp(-t/s) and we
// want R = T at due time, then due-time = -ln(T) * s. The multiplier
// is the ratio of the user's target to the default target.
//
// At T = DEFAULT (0.85), mult = 1 (no change from raw SM-2).
// At T = 0.95, mult ≈ 0.315 (intervals shrink to 31.5% — way more
// reviews, much higher retention).
// At T = 0.70, mult ≈ 2.19 (intervals stretch to 219% — fewer
// reviews, lower retention).
//
// Applied at READ TIME in reviewStateForCard (in derived.js), so
// sliding the value retroactively reinterprets all stored intervals —
// the deck visibly re-sorts as the slider moves. Past grades aren't
// rewritten; only the projected due times change.
export const DEFAULT_RETENTION_TARGET = 0.85
export function retentionMultiplier (target) {
  if (!target || target === DEFAULT_RETENTION_TARGET) return 1
  return Math.log(target) / Math.log(DEFAULT_RETENTION_TARGET)
}

// GRADE_TO_Q maps the UI's 4-button scale onto the classical SM-2
// quality scale (0..5). Hard is q=3 — Anki's convention — meaning
// "got it right with serious difficulty," NOT a lapse. (q=2 would
// put it on the lapse branch alongside again.)
const GRADE_TO_Q = [0, 3, 4, 5]

// Tunable multipliers for the non-classical branches. These will
// become per-deck and slider-tunable in a later commit (retention
// target). For now they're constants picked to match David's
// intuition: hard shrinks (he wants "back it down, not just slow
// growth"); easy is visibly larger than good on a single grade.
const HARD_MULT  = 0.5  // 'hard' multiplies the interval (back-off)
const EASY_BONUS = 1.3  // 'easy' adds on top of the good growth

export function applySM2 (review, gradeIdx, atMs) {
  const q = GRADE_TO_Q[gradeIdx]
  const r = { ...review }
  if (gradeIdx === 0) {
    // 'again' — lapse. Full reset to the learning stage.
    r.reps = 0
    r.interval = 0
  } else if (gradeIdx === 1) {
    // 'hard' — got it right but barely. Multiplicative back-off:
    // shrink the interval by HARD_MULT. Floor at 1 so a freshly-
    // graduated card doesn't fall back to "due immediately." reps
    // stays the same — hard is a slow-down, not a lapse.
    r.interval = Math.max(1, Math.round(r.interval * HARD_MULT))
  } else {
    // 'good' (gradeIdx=2) or 'easy' (gradeIdx=3) — successful grade,
    // advance per SM-2's ladder (1, 6, then interval × ease). Easy
    // gets an extra EASY_BONUS multiplier so it's visibly distinct
    // from good on every grade, not just over time via ease drift.
    let next
    if (r.reps === 0)      next = 1
    else if (r.reps === 1) next = 6
    else                   next = r.interval * r.ease
    if (gradeIdx === 3) next *= EASY_BONUS
    r.interval = Math.max(1, Math.round(next))
    r.reps += 1
  }
  // Ease adjustment — classical SM-2 formula. Drops a lot on again
  // (q=0), drops 0.14 on hard (q=3), holds on good (q=4), grows by
  // 0.1 on easy (q=5). The 1.3 here is the MINIMUM ease (a floor),
  // NOT a cap — ease starts at 2.5 and can climb above that with
  // repeated easies; the floor just keeps it from collapsing to ~0
  // on a deck full of lapses.
  r.ease = Math.max(1.3, r.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  // Due time. 'Again' bumps 1 minute forward — long enough to fall
  // out of this session's derived queue, short enough to come back.
  // Other grades use the (new or shrunk) interval in days.
  r.due = gradeIdx === 0
    ? atMs + 60 * 1000
    : atMs + r.interval * 24 * 60 * 60 * 1000
  // Mastery is a function of elapsed time since this — climbs between
  // reviews, resets here on each grade. So the bar is alive.
  r.lastReviewAt = atMs
  return r
}
