/**
 * @file SM-2 (lite) — a tiny spaced-repetition algorithm. Pure, no
 * reactive coupling, no DOM. Lives in its own file so the math can
 * be read (and tested) without scrolling past the rest of the app.
 *
 * Grade indices map to SM-2 quality scores:
 *   0 = 'again' → q=0, reps reset, due 1 minute out
 *   1 = 'hard'  → q=2
 *   2 = 'good'  → q=4
 *   3 = 'easy'  → q=5
 *
 * The 'again' → 1-minute-due trick lets the card fall out of *this
 * session's* derived queue but come back next time. Session-relevance
 * encoded in the algorithm, so the study queue can stay a stateless
 * derived value (folded over the reviews stream every render).
 */

export const DEFAULT_REVIEW = {
  ease: 2.5,
  interval: 0,
  previousInterval: 0,  // interval before the most recent successful grade;
                        // `hard` reverts to this. See applySM2 below.
  due: 0,
  reps: 0,
  lastReviewAt: 0
}

// GRADE_TO_Q maps the UI's 4-button scale (again/hard/good/easy) onto
// the classical SM-2 quality scale (0..5). Hard is q=3 — Anki's
// convention — meaning "got it right but with serious difficulty,"
// NOT a lapse. (Earlier this mapped to q=2, which put hard on the
// lapse branch alongside again. David flagged: hard shouldn't reset
// mastery; it should mean 'back off, don't lengthen my interval.')
const GRADE_TO_Q = [0, 3, 4, 5]

export function applySM2 (review, gradeIdx, atMs) {
  const q = GRADE_TO_Q[gradeIdx]
  const r = { ...review }
  if (gradeIdx === 0) {
    // 'again' — lapse. Full reset to the learning stage; the card
    // comes back through the 1-then-6-day ladder.
    r.reps = 0
    r.interval = 0
  } else if (gradeIdx === 1) {
    // 'hard' — David's intuition: "I got it right but don't lengthen
    // my interval. Back it down to what it was before I got it right
    // last time." Revert interval to `previousInterval` (the interval
    // before the most recent successful grade); floor at 1 so a
    // freshly-graduated card doesn't fall back to "due immediately."
    // reps stays the same — not a lapse, just a slow-down.
    r.interval = Math.max(1, r.previousInterval || 1)
  } else {
    // 'good' (q=4) or 'easy' (q=5) — successful grade. Save the
    // current interval as previousInterval (so a future 'hard' can
    // revert to it), then advance per classical SM-2 progression.
    r.previousInterval = r.interval
    if (r.reps === 0)      r.interval = 1
    else if (r.reps === 1) r.interval = 6
    else                   r.interval = Math.round(r.interval * r.ease)
    r.reps += 1
  }
  // Ease adjustment — classical SM-2 formula, applies to all grades.
  // Drops a lot on again (q=0), a little on hard (q=3), zero on good
  // (q=4), grows on easy (q=5).
  r.ease = Math.max(1.3, r.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  // Due time. 'Again' bumps 1 minute forward — long enough that the
  // card falls out of this session's derived queue, short enough that
  // it comes back next time. Encodes session-relevance in the
  // algorithm so the queue doesn't have to be a stateful array.
  // Other grades use the (new or reverted) interval.
  r.due = gradeIdx === 0
    ? atMs + 60 * 1000
    : atMs + r.interval * 24 * 60 * 60 * 1000
  // Track the moment of this grading. Mastery is a function of elapsed
  // time since this — climbs between reviews, resets here on each grade.
  r.lastReviewAt = atMs
  return r
}
