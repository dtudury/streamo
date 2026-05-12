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
- **Inline the CSS too,** as a multi-line pretty `<style>` block
  inside the template. Don't pull it out to a `.css` file or a
  detached `const css = \`...\``; that scatters the page across
  multiple definitions.
- **Use form-level handlers** with `onsubmit=${() => handler}` and
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

The journal app at `public/apps/journal/main.js` is the worked
example. If you see another app drift from this shape and the human
hasn't asked otherwise, gently bring it back.

## when NOT to use the h-heavy style

If the human partner has said they don't want to read the code (they
want a finished app, not a project to study), use `h` only when it
genuinely helps. Plain DOM manipulation, separate `.html` shells with
imperative `.js` files — all fine. The point of `h` is making the
code legible for someone who's going to read it.

`public/apps/hello-vanilla/` is a worked example of the alternative
shape: the same hello-world streamo app written without `h` at all,
the most vanilla DOM-API way possible. Useful as a side-by-side
reference when the partner asks "is `h` doing anything I couldn't do
with `createElement`?"

## the `on*` attribute trap

`onclick=${handler}` is the footgun. Mount calls `handler(el)` *once*
and assigns the return value to `el.onclick`. The handler runs during
mount, returns undefined, and you've effectively unbound the click.

Always wrap: `onclick=${() => handler}`. The cell returns the handler
function; mount assigns it to `el.onclick`; click events get to it.
Same shape for `onsubmit`, `oninput`, etc.

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

**Cross-recaller gotcha.** Each `StreamoComponent` instance gets its
*own* Recaller. Reactive cells inside the component register their
watchers against that local recaller. If those cells read signals
that live on the *outer* (app) recaller — like a module-level
`loggedIn()` or a `bridgeRegistry`'s `dep()` — the cross-recaller
subscription doesn't form: the outer recaller fires, but the
component's watcher never hears it. The component just doesn't
re-render. The journal app hit this when its entries list lived in
a `defineComponent` and read `loggedIn()`; entries stayed frozen on
the logged-out branch even after login flipped. Fix was to pull the
list back to a function-as-slot in the main mount, where it shares
the journal's single recaller. Until we build a real bridge from one
recaller into another (the `bridgeRegistry` pattern is the model),
keep `defineComponent` for cases that are genuinely self-contained
— don't reach into app-level signals from inside one.

## reactivity-only changes don't need component boundaries

If something needs to re-render reactively, a function-as-slot in the
existing h-template (`${() => { dep(); return … }}`) does it cleanly.
Wrapping that in a `defineComponent` adds machinery (shadow DOM, own
Recaller, cross-recaller dep tracking) for no gain. Use the slot.

---

(More notes will accrue here as preferences emerge. Each one is
something the human has named clearly; please don't add inferences
or general best-practices.)
