/**
 * @file Mastery math — pure functions that turn a review record (SM-2
 * state + last-review timestamp) into renderable signals:
 *
 *   - **masteryOf** — `log₂(1 + interval + elapsed_days)`. A 0..~7
 *     scalar that grows with both interval (commitment from the most
 *     recent grade) and elapsed time (live climb between reviews).
 *   - **masteryColor** — HSL gradient stops at log-time positions,
 *     shortest-arc hue interpolation so we never wander through cyan
 *     on the way from red to red-orange.
 *   - **urgencyOf** — `(now - due) / interval`. Self-normalized "how
 *     overdue is this for its own scale."
 *   - **formatTimeUntil** — short human-readable countdown for a
 *     reactive slot.
 *
 * No DOM, no reactivity, no app-state coupling. Pure functions over
 * review records. The slot that calls them owns the reactivity.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

// Mastery = log₂(1 + interval + elapsed_days_since_last_review).
// Two components:
//   - `interval` is the SM-2 interval set by the most recent grade —
//     the static commitment that "you've earned this much." Means the
//     bar is populated right after a grade (interval ≥ 1 for 'good'),
//     not empty. Visible reward for the work.
//   - `elapsed_days` is time since the grade — adds the live climb,
//     so the bar moves visibly while the user watches.
// Grading 'again' resets interval to 0 AND lastReviewAt to now;
// mastery falls back to ~0 and starts climbing fresh. Takes `now` so
// the calling slot can pass time.get() and re-render each tick.
export function masteryOf (review, now) {
  if (!review || !review.lastReviewAt) return 0
  const elapsedDays = Math.max(0, (now - review.lastReviewAt) / DAY_MS)
  return Math.log2(1 + review.interval + elapsedDays)
}

// HSL stops anchored at log-time mastery positions. Hoisted to module
// scope so it isn't allocated on every masteryColor() call (the
// function is called ~30 times/second during a tick — small win, no
// downside). Color shifts FASTER than width at low mastery:
// red→yellow→green happens in the first ~30% of the bar, then colors
// stretch slowly toward blue across the rest.
//
// Yellow at 1.5 days (~19% bar width), green at 3 days (~29%), emerald
// at 1 week, teal at 1 month, blue at 3+ months. All chosen for
// legibility on white since the same color is used for both the bar
// fill and the text label.
const COLOR_STOPS = [
  [0.00, 355, 80, 50],   // bright red — only the sliver
  [0.50,  20, 85, 48],   // red-orange transitioning
  [1.00,  35, 90, 45],   // amber
  [1.32,  45, 95, 40],   // fully yellow — 1.5 days
  [2.00, 140, 70, 38],   // fully green — 3 days
  [3.00, 160, 75, 30],   // emerald — 1 week
  [4.95, 190, 85, 30],   // teal — 1 month
  [6.50, 215, 75, 45]    // blue — 3+ months
]

export function masteryColor (mastery) {
  if (mastery <= COLOR_STOPS[0][0]) {
    const [, h, s, l] = COLOR_STOPS[0]
    return `hsl(${h}, ${s}%, ${l}%)`
  }
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [m1, h1, s1, l1] = COLOR_STOPS[i]
    const [m2, h2, s2, l2] = COLOR_STOPS[i + 1]
    if (mastery <= m2) {
      const t = (mastery - m1) / (m2 - m1)
      // Shortest-arc hue interpolation: take the SHORT way around the
      // wheel, not the long way. Critical for the red (hue 355) →
      // red-orange (hue 20) transition — naive linear interpolation
      // wanders through cyan (hue ~187 at t=0.5) instead of staying
      // in the red end. David caught this with a low-mastery card
      // rendering as bright teal-green: width 3.9% (mastery 0.27) +
      // color hsl(174, 83%, 49%). The width was right; the color
      // was lying about which mastery value it represented.
      let dh = h2 - h1
      if (dh > 180) dh -= 360
      else if (dh < -180) dh += 360
      const hue = ((h1 + dh * t) % 360 + 360) % 360
      return `hsl(${Math.round(hue)}, ${Math.round(s1 + (s2 - s1) * t)}%, ${Math.round(l1 + (l2 - l1) * t)}%)`
    }
  }
  const [, h, s, l] = COLOR_STOPS[COLOR_STOPS.length - 1]
  return `hsl(${h}, ${s}%, ${l}%)`
}

// Urgency: -1 = won't be due for another full interval; 0 = due now;
// +1 = a full interval overdue. Self-normalizes by mastery so an
// overdue daily card and an overdue monthly card don't read the same.
export function urgencyOf (review, nowMs) {
  if (!review || review.due === 0) return 0
  if (review.interval <= 0) return Math.max(0, (nowMs - review.due) / DAY_MS)
  return (nowMs - review.due) / (review.interval * DAY_MS)
}

// barFor: returns `{ kind, width }` describing how to draw the
// urgency bar for a review record. Two distinct visual states:
//
//   kind = 'remaining' — the card is NOT yet due. Bar is anchored
//     left and DRAINS as time approaches due. Full bar = 1 day or
//     more remaining; bar drains over the last 24h. Log shape
//     accelerates the drain in the final hour/minute.
//
//   kind = 'overdue' — the card is past its due time. Bar anchors
//     right (visually distinct from the remaining state) and GROWS
//     as overdue-ness accumulates. Sqrt shape so the early overdue
//     is a thin sliver, not an immediate jump to half-full. Full
//     bar = one full interval overdue.
//
//   kind = 'empty' — no history. Bar at 0%, used as the gray
//     placeholder for never-reviewed cards.
//
// David's framing: "fill it up from the other side with its overdue-
// ness... some sort of different treatment to keep it interesting."
// The kind/width pair lets the renderer pick its anchor.
const ONE_DAY_MS  = 24 * 60 * 60 * 1000
const ONE_YEAR_MS = 365 * ONE_DAY_MS

export function barFor (review, now) {
  if (!review || !review.lastReviewAt) return { kind: 'empty', width: 0 }
  const intervalMs = review.due - review.lastReviewAt
  if (intervalMs <= 0) return { kind: 'remaining', width: 100 }
  const timeUntilDueMs = review.due - now
  if (timeUntilDueMs > 0) {
    // Pre-due: bar drains as time approaches due. Drain window is
    // always 1 day. Cards with >= 1 day remaining stay full; cards
    // with intervals shorter than a day (5-min lapse, 30-min ladder
    // step) NEVER read as fully fresh — they start at whatever
    // fraction of a day they have. David: "it should only be full
    // if there's a day or more left."
    const drainWindowMs = ONE_DAY_MS
    if (timeUntilDueMs >= drainWindowMs) {
      return { kind: 'remaining', width: 100 }
    }
    // Log shape: drains slowly in the first hours, fast near due.
    const w = Math.log(timeUntilDueMs + 1) / Math.log(drainWindowMs + 1)
    return { kind: 'remaining', width: Math.max(0, Math.min(100, w * 100)) }
  }
  // Overdue: bar grows as overdue-ness piles up. Scale = 1 year (not
  // the card's interval) so a card overdue by a few days only fills
  // a sliver; "fully overdue" requires neglect on the order of months
  // to a year. David: "I want to see it move a little at the start
  // but it should almost never be full."
  const overdueMs = -timeUntilDueMs
  if (overdueMs >= ONE_YEAR_MS) return { kind: 'overdue', width: 100 }
  // Sqrt shape: visible early as a thin sliver, growth slows later.
  const w = Math.sqrt(overdueMs / ONE_YEAR_MS)
  return { kind: 'overdue', width: Math.max(0, Math.min(100, w * 100)) }
}

// A short, human-readable string for "time until due" — or "overdue"
// if the moment has passed. Designed to be called inside a reactive
// slot that has already read time.get() (so the slot re-renders each
// tick). Takes ms (not a Date) so callers can pass (due - time.get())
// cleanly.
export function formatTimeUntil (deltaMs) {
  const abs = Math.abs(deltaMs)
  const overdue = deltaMs < 0
  let label
  if (abs < 60 * 1000) label = `${Math.floor(abs / 1000)}s`
  else if (abs < 60 * 60 * 1000) label = `${Math.floor(abs / 60000)}m`
  else if (abs < DAY_MS) label = `${Math.floor(abs / 3600000)}h`
  else label = `${Math.floor(abs / DAY_MS)}d`
  return overdue ? `overdue ${label}` : (deltaMs <= 0 ? 'now' : `in ${label}`)
}
