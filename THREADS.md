# threads

Mid-flight exploration threads — what's currently being chewed on, why it
got started, where it paused, and what to try next. Different from
`ROADMAP.md`, which is for shipped/planned work; this is the working
memory between sessions.

A thread can leave any time it ships fully (move it to ROADMAP "where we
are") or gets retired (delete it). New threads start lightweight; they
earn detail as they accumulate state.

---

## Streamo-typed value displays

**Why this thread exists.** Every chunk in streamo has a codec — and
the codec IS the type. Today we flatten through `JSON.stringify` and
lose that fidelity (Dates become ISO strings, Uint8Arrays become
"Uint8Array(N)", numbers and strings render with the same shape).
Type-aware displays would honor the encoding, give each value visual
identity, and as a side benefit let us control rehydration depth so
big arrays don't have to render eagerly.

The thread also paves the way for **editable typed inputs**: once a
value renders as e.g. a `<time>` chip, "let me edit this date" is a
small step. That's the bridge into the StreamoComponent demos thread.

**State:** primitives shipped (strings, numbers, dates, booleans,
null/undefined, Uint8Array). Composites currently render as count
chips (`{ 7 fields }`, `[ 12 elements ]`) — same visual identity, no
expansion yet.

**Next.** Pick whichever feels right:

- *Composite expansion.* Render objects/arrays one level deep with
  each field/element as its typed value. Nested composites stay as
  count chips, expandable on click. This is the depth-control payoff.
- *Replace the `rehydrated` `<pre>`.* Once composites can render
  recursively at controlled depth, the eager `safeJSON` block becomes
  redundant — kill it.
- *Editable variants.* `<input type="date">` for dates, `<input>` for
  strings, etc. This is the bridge to writing-as-editing instead of
  set-the-whole-value. Substantial — its own thread when it's time.

---

## mount: recursive reconcile instead of trash-and-remount

The current fix for "data-keyed elements never update their static
text content" (commit `0f72346`) is correct but blunt: every recycled
element rebuilds its entire subtree on every outer re-render. That
means O(N) DOM ops per re-render where N is total descendants, and it
forces re-creation of every inner slot's watchers. Invisible at
explorer scale (5 rows). Becomes a perf cliff for chats with hundreds
of messages, where every chunk arrival re-renders the messages list
and rebuilds every existing message's DOM.

**State.** Not started. The fix in `mount.js` is correct; this is
follow-up work.

**Right answer.** Recursive reconciliation: walk new vnode children
in parallel with existing DOM children, match by tag/key, only update
text nodes whose content actually changed, only patch attrs that
differ, leave unchanged subtrees alone. ~50 more lines of mount.js.

**The subtle case.** Inner slot cells (function children) — their
closures change across outer re-renders, so preserving an existing
slot risks running stale closures forever; recreating wastes work
(loses cached async state). The pragmatic answer is probably:
preserve the slot's anchor structure but call its watcher with the
NEW cell function. That requires distinguishing slot anchors in the
DOM, which is doable but isn't standard React-style reconciliation.

**Trigger.** Look here when a chat with N>200 messages starts to
feel laggy on chunk arrival. Until then, ship.

---

## bring back the minimap (optional)

Punted during 4.0.x. The single-strip detail-with-grab works well for
panning; the minimap is the natural addition if "where am I in the
whole stream" becomes a felt need. D3-brush style: small overview
above, translucent viewport rect tracking the detail's scroll.

**State.** Not started. User explicitly reserved the right to ask for
this — wait for them.

---

## first-30-seconds session ritual

When the user opens a session with a brief greeting (no specific ask),
I run a small warmup: peek at recent commits, MEMORY pointers,
ROADMAP, and this file; then offer one paragraph — "last session you
wrapped up X, ROADMAP suggests Y, THREADS has Z mid-flight, what's
calling to you?" — and let them confirm or redirect.

**State.** Memory note saved on 2026-05-09. The ritual itself is
behavioral, not tooled.
