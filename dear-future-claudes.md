# dear future Claudes

A small place to leave notes for the next session of Claude working on
streamo. Not rules; style preferences and tradeoffs the human partner
has expressed clearly enough that we should honor them by default.

If a note no longer matches what the human is asking for, drop it from
this file with the same care you'd drop a stale comment.

---

## prefer h-templates inline over fragmented vnode bindings

When David is reading the code, he reads HTML fluently and prefers
seeing the page's structure in one place. For streamo apps that means:

- Bring the whole page to life via one
  `mount(h\`...\`, document.body, recaller)` call. The h-template IS
  the page.
- **Inline the markup directly in that call.** Don't break it into
  named vnode fragments (`brandHeader`, `loginForm`, etc.) and
  reassemble — it tempts the eye to organize by "component," but the
  result reads worse because you chase definitions around. The whole
  page in HTML order beats a bag-of-named-pieces almost every time.
- **Default: CSS in a sibling `styles.css`** linked from `index.html`.
  This is the standard web idiom — browser devtools edit it natively,
  CSS tooling works without convincing, and the stylesheet loads in
  parallel with the JS so there's no flash of unstyled content. The
  flashcards app shows this shape. *The earlier "keep CSS inside
  main.js for one-file-one-page legibility" rule was overstated —
  the page's prose lives in the h-template, which is in JS by
  necessity; CSS is declarative reference material, not part of the
  prose you read top-to-bottom.* Three real exceptions where CSS
  belongs inline:
  - **Components** — a `StreamoComponent`'s scoped CSS belongs with
    its template and behavior, because the component IS a discrete
    unit and exporting CSS out breaks that discreteness.
  - **Very small pages** — under ~50 lines of CSS, the journal-app
    shape (inline `<style>` at the top of the mount template) is
    fine; the cost of a separate file outweighs the readability win.
  - **CSS with interpolated JS values** — `background: ${themeColor}`
    or `padding: ${unit * 4}px` *can't* live in a static `.css`
    file; it has to be in JS.
- **Use form-level handlers** with `onsubmit=${handle(handler)}` and
  reach for inputs via `e.target.elements.<name>` rather than
  `getElementById`. The form *is* the input registry.
- The `when(cond, vnode)` helper is welcome; named handlers and
  named reactive signals (like `loggedIn()`) are fine. Just don't
  fragment the markup itself.
- `index.html` can be a minimal shim — `<head>` with the
  `<script type="module">` tag (deferred by default), `<body>` with
  a styled loading message. `mount()` owns its container and clears
  any pre-existing children before rendering, so the loading shim
  is replaced wholesale at first render — no manual wipe required.

The flashcards app at `public/apps/flashcards/main.js` is the
current worked example — it follows the patterns below including the
`handle(...)` shape for event handlers. The journal app at
`public/apps/journal/main.js` is older but still legible; it predates
`handle` and uses the `onclick=${() => fn}` double-arrow shim instead.
If you see another app drift from this shape and the human hasn't
asked otherwise, gently bring it back.

## when NOT to use the h-heavy style

If the human partner has said they don't want to read the code (they
want a finished app, not a project to study), use `h` only when it
genuinely helps. Plain DOM manipulation, separate `.html` shells with
imperative `.js` files — all fine. The point of `h` is making the
code legible for someone who's going to read it.

## the `on*` attribute trap

`onclick=${handler}` is the footgun. Mount calls `handler(el)` *once*
and assigns the return value to `el.onclick`. The handler runs during
mount, returns undefined, and you've effectively unbound the click.

**Use `handle` from `h.js`:** `onclick=${handle(fn)}` produces the
right curry shape (`el => event => fn(event, el)`) and reads as the
declarative thing it is — "this attr IS an event handler, wire it
up." For handlers that ignore the event/element:
`onclick=${handle(() => doThing(id))}`.

Same shape for `onsubmit`, `oninput`, etc. — anywhere mount assigns
a DOM-level-0 property and you want it to be a real function on the
node.

The older `onclick=${() => fn}` double-arrow shim (still seen in the
journal app) works for the same reason — the outer arrow is the cell
that returns the handler — but it's correct-but-unpleasant. `handle`
makes the intent legible. Prefer it.

**When delegation IS the right call:** for genuinely large or uniform
dynamic lists, `data-action` attributes on items + a single listener
on the app container is the streamo idiom (the explorer's commit and
repo lists are the canonical case). Delegation isn't the universal
escape hatch from the `on*` footgun — `handle` is. They're different
tools for different problems.

This is also in CLAUDE.md's known footguns.

## the LiveSource interface

When something needs to be a reactive data source for h/mount, it
implements:

    {
      recaller: Recaller,
      get(...path): any,
      set(...path, value): void
    }

`Streamo` and `Repo` already do this directly — their methods *are*
the interface. For plain JS objects, use `liveObject(target)` from
`public/streamo/LiveSource.js`. For domain-specific cases (the
location app, say), write a custom factory that returns the same
shape; `apps/location/main.js` is the worked example.

Variadic path, value-last (`set('a', 'b', 'c', 42)`), matching
Streamo's existing signature. A `proxy` field is optional sugar that
some implementations expose — `loc.proxy.hash` ⇔ `loc.get('hash')`
— but it's not part of the interface.

design.md §13 has the formal description.

**Share recallers across LiveSources whenever you can.** Multiple
recallers compose badly (cross-recaller subscriptions don't form
automatically — see the design-thread-paused-then-resumed note
elsewhere). `liveObject` accepts a `{recaller}` option for exactly
this — pass an existing recaller (often a Repo's) and multiple
liveObjects all signal on the same bus, so a single mount() call
sees everything. The "isolation" of separate recallers is almost
never the isolation you actually want.

`liveLocation()` also accepts `{recaller}` if you ever need it to
compose with other sources.

There's an `isLiveSource(x)` predicate exported alongside `liveObject`
— structural check (does it have `recaller`, `get`, `set`), not
nominal. Useful when writing helpers that take any LiveSource as
input.

## `<style>` and `<script>` content is now raw text

As of the 4.0.x bug fix, h's parser treats the content of `<style>`
and `<script>` tags as opaque text — anything that *looks like* HTML
inside (e.g. `/* a comment mentioning <dd> */`) is not parsed as HTML.
Slot interpolation inside still works: `<style>${cssRules}</style>`
is fine. Before this fix, an HTML-looking token inside a CSS comment
would silently derail parsing and only the `<style>` element would
render. If you're debugging a "only the style shows up" symptom in a
future app, check whether something fishy is happening earlier in the
template; the raw-text fix should rule out the `<dd>-in-a-comment`
class of bug.

## components vs. fragments

Function components (plain functions used as `<${Card}>` tags) are
welcome when the same shape repeats across the page or across apps —
the chat's `Msg` is a fair example. *Don't* introduce them just to
break the page into pieces; that's the "fragmented vnode bindings"
anti-pattern above.

Custom-element components via `defineComponent` + `StreamoComponent`
are different — they earn their place when you need a self-contained
unit with its own Recaller and shadow DOM (the typical motivator is
hot-reload via `componentKey`, or shipping a "stylable widget" that
travels with its own CSS). For routine page structure, just inline.

**Cross-recaller gotcha — now opt-in fixable.** Each
`StreamoComponent` instance defaults to its OWN Recaller, which is
fine for genuinely self-contained widgets but breaks when reactive
cells inside the component need to react to app-level signals
(login state, route, app liveObjects). The journal app hit this
when its entries list lived in a `defineComponent` and read
`loggedIn()`; entries stayed frozen even after login flipped.

The fix is to pass the app's Recaller via `defineComponent(name,
renderFn, { recaller })`. Every instance of that tag then shares
the given Recaller, so cells inside compose with the rest of the
app's mount. Without `{ recaller }`, behavior is unchanged (own
Recaller per instance). The Repo↔registry case used to have the
same shape — solved the same way: `new RepoRegistry(undefined, {
recaller })`. The (target, key) NestedSet keeps unrelated
subsystems from colliding even on a shared Recaller.

## reactivity-only changes don't need component boundaries

If something needs to re-render reactively, a function-as-slot in the
existing h-template (`${() => { dep(); return … }}`) does it cleanly.
Wrapping that in a `defineComponent` adds machinery (shadow DOM, own
Recaller, cross-recaller dep tracking) for no gain. Use the slot.

---

(More notes will accrue here as preferences emerge. Each one is
something the human has named clearly; please don't add inferences
or general best-practices.)
