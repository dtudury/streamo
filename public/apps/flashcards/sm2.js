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

export const DEFAULT_REVIEW = { ease: 2.5, interval: 0, due: 0, reps: 0, lastReviewAt: 0 }

const GRADE_TO_Q = [0, 2, 4, 5]

export function applySM2 (review, gradeIdx, atMs) {
  const q = GRADE_TO_Q[gradeIdx]
  const r = { ...review }
  if (q < 3) {
    r.reps = 0
    r.interval = 0
  } else {
    if (r.reps === 0)      r.interval = 1
    else if (r.reps === 1) r.interval = 6
    else                   r.interval = Math.round(r.interval * r.ease)
    r.reps += 1
  }
  r.ease = Math.max(1.3, r.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  // Due time. 'Again' (q<3) pushes due 1 minute forward — long enough
  // that the card falls out of this session's derived queue, short
  // enough that it comes back next time. Encodes session-relevance in
  // the algorithm so the queue doesn't have to be a stateful array.
  r.due = q < 3
    ? atMs + 60 * 1000
    : atMs + r.interval * 24 * 60 * 60 * 1000
  // Track the moment of this grading. Mastery is a function of
  // elapsed time since this — climbs slowly between reviews, resets
  // (here) on each grade. So the bar is alive.
  r.lastReviewAt = atMs
  return r
}
