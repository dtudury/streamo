# Philosophy

Streamo makes specific trades. Some of them you'll like; some will rub. This
file is the honest record — what you pay, what you get, and what's coming
that would soften the costs.

We're not going to try to talk you out of the costs. They're real. If a
trade isn't worth it for your project, run another stack — that's a
legitimate conclusion and we mean no shade. If the trade IS worth it,
this is what you're signing up for, and this is what you get.

---

## what you're trading

### no static type-checking of templates or handlers

*If you typo `onCick` in an attribute, nothing will tell you until runtime.*

TypeScript + JSX users get autocomplete on prop names, "rename this
everywhere" refactors, and red squiggles when a handler reference goes stale.
Streamo's `h\`\`` tagged template literals are just strings to your editor
until they're evaluated. The parser inside `h.js` doesn't run at write-time,
and there's no language server.

This is fine for a codebase one or two people hold in their heads. It's a
real productivity tax for a team of ten with high churn. Tests have to be
load-bearing where types would be elsewhere.

### components default to closure-scoped state

*Function components in streamo read state from outer scope, not from props.
Mounting a component in isolation requires standing up the world.*

By convention, a streamo function-component closes over the recaller,
the repos, and the helpers it needs from its enclosing module. Pass `todo`
in as a prop, sure — but `editingId`, `myRepo`, `toggleTodo` are typically
captured from scope.

React's convention is the opposite: components receive everything via
props, so they're unit-testable in isolation. Streamo's lets you skip the
prop-drilling, which makes most code shorter and most refactors smaller —
at the cost of needing extra work to test a component without its world.
When you want a component to be isolatable, you can refactor it to accept
everything as props (the same way you would in React); the convention
doesn't fight you, it just doesn't enforce.

### the style is convention-heavy with footguns

*"That HTML attribute pattern is a trap; that one isn't; this list needs
data-key, that one doesn't" — newcomers have to learn which conventions
are load-bearing and which are taste.*

The known footguns are documented in `CLAUDE.md` and the same ones bite
both contributors and AI assistants until the patterns are internalized.
The biggest historical ones — `onclick=${fn}` as a reactive cell, function
components without `data-key`, recycling-by-tag mixing semantically
distinct elements — are real and have all bitten this project. The
`handle()` helper exists specifically to make one of them stop hurting.

React has its own footguns (stale closures in useEffect, key warnings),
but they're documented to death across the web. Streamo's are documented
in one repo, by mostly two minds. New contributors have to read the docs
to know which conventions are load-bearing; in another stack they might
have learned them via Stack Overflow before they wrote a line.

### editor tooling is thin

*No editor I know of syntax-highlights inside `h\`...\`` tagged templates
the way every modern editor highlights JSX.*

No "go to definition" jumps from `<${TodoItem}/>` to the function. No
"find references" works on attribute names. For developers who lean hard
on IDE features, this feels like working blindfolded. The mitigating
factor is that the markup looks like HTML and reads like HTML — so the
muscle memory of "I'm in a template, this is markup, I know what these
tags do" carries you further than it would in invented syntax. But only
some of the way.

### markup and behavior live together

*A skeptic from the unobtrusive-JavaScript tradition will look at
`onclick=${handle(() => toggleTodo(todo.id))}` and feel viscerally that
we've reinvented the 1998 mistake of mixing JS into HTML.*

The honest counter is: *the JS isn't dropped into HTML — it's interpolated
into a virtual tree at template-construction time*, and the resulting
handler is scoped to the function-component that built it, not in a
global namespace. The output is functionally equivalent to React's `onClick={...}`,
just with curly-brace-and-template-literal syntax instead of JSX braces.

The visual resemblance to inline event handlers IS real, though.
Some readers will not get past it. They have a defensible aesthetic
position, even if the underlying mechanics aren't what they fear.

### re-render granularity is coarse

*One watcher per mount; on any reactive change, the whole vnode tree
re-evaluates and the recycler reconciles the DOM. SolidJS-style
fine-grained signals would update only the exact DOM node that depends
on the changed value.*

For small apps, the recycler closes the gap — recycled elements don't
tear down, attrs don't reapply when they didn't change, watchers don't
re-register on stable subtrees. For a 10,000-row table updating 60 times
per second, our coarseness will show. We aren't building that, but a
skeptic asking "does this scale?" deserves the answer: *not to that
case without further work.*

The shape of the further work, when it's needed, is to introduce
function-component boundaries around expensive subtrees — each
component becomes a watch boundary, and unrelated state changes don't
re-evaluate inside it. This is the same design pressure React puts on
its users (`memo`, `useMemo`, fine-grained component splits); we don't
escape it, we just defer it.

For truly extreme workloads — 600k updating values per second, real-time
visualizations of complex state — the play is the same as every other
framework's: hand off to a Canvas/WebGL component for the hot path,
keep streamo around the shell. We don't compete with the hot loop; we
own the rest.

### bus factor and ecosystem

*Nobody on Stack Overflow has answered a streamo question. New
contributors learn `h`, `mount`, `Recaller`, `Repo`, `RepoRegistry`,
`registrySync`, `liveValue`, `handle` — not one library, a small
constellation.*

For streamo's pitch ("your data, your code, your tools, your fate"),
this is the price of the ticket. You can't have full ownership AND
community-of-millions support for free. We can mitigate by writing
clearer docs, by being welcoming when people show up with questions
(see [tools we'd welcome](#tools-wed-welcome) below), and by keeping
the implementation small enough that one person can read it in a
sitting. We can't make it not-a-cost.

---

## what you get in exchange

### real HTML legibility

The markup in a streamo template is HTML. Not "JSX, which transpiles to
JS, which constructs elements." Not a custom DSL with `v-for` directives.
The tags, the attributes, the structure all map to the DOM that comes
out the other end. When you read the template, you're reading the page.

### zero build step

`<script type="module" src="./main.js"></script>` and your app runs. No
bundler, no transpiler, no webpack config to debug at 11pm. The
production deployment is the same files the dev deployment is. The
"works on my machine" / "doesn't work in prod" gap collapses, because
there's no transformation between the two.

### append-only signed history, for free

Every write your app makes is automatically a commit: message, date,
data, parent. Auditable. Replayable. Forkable. The history that
production-grade systems retrofit with event sourcing is streamo's
default. Undo is a UI feature on top of free infrastructure.

### identity that travels with you

Username + password → deterministic keypair. Same credentials, same
keys, on every device, forever. No accounts table. No "I lost my
recovery codes." No OAuth round trips. Your identity is portable
because it's derived, not stored.

### server as relay, not gatekeeper

The server forwards bytes. It doesn't validate your business logic.
It doesn't decide what's allowed. If it disappears, your data is
still on your devices, signed, fork-able to any other relay. The
authority gradient that most systems centralize at "the API" — streamo
flattens.

### full ownership of data and runtime

Your data: signed by you, stored anywhere, served by anyone with the
bytes. Your runtime: the implementation fits in ~2k lines and was
written in a way that someone could reasonably reimplement in another
language over a weekend. You aren't renting a future from streamo;
you're owning a primitive.

---

## future of these trades

The costs in the [trading](#what-youre-trading) section have known
softening paths. These aren't promises — they're sketched directions
with rough effort estimates, mostly waiting for "someone hits this
hard enough to want to build it."

### a focused linter (phase 1)

The 80% case for catching common mistakes is achievable in a long
weekend of focused work. ~500–800 LOC of ESLint rule reusing the
existing `h.js` scanner. Would flag: `onclick=${nonCurried}`,
function-component-in-list missing `data-key`, recycling collision
between sibling `<input>`s without keys, attribute-name typos against
a known-good list, unknown tag names. Catches most of the footguns
we've actually hit.

### a real Streamo language server (phases 2–3)

Phase 2 — completion, go-to-definition, find-references for component
names — is a couple weeks of focused work for someone who knows
language servers. Phase 3 — type inference on attrs, handlers, and
props — is the real "Streamo IDE," and that's months. We aren't
committing to building either; we'd happily merge them.

### explorer-as-isolatable-components experiment

The explorer app is a natural target for an experiment: rewrite it so
every component takes everything as props (no closure capture). Result:
a worked example of the "isolatable testing" pattern for newcomers who
want it. Mid-priority; would land as its own arc.

### everything else listed in [ROADMAP.md](./ROADMAP.md)

Caching relay, service-worker relay, stream-commitment crypto,
StreamoComponent demos, presence polish. Some of these soften the
scaling critique; some open new applications entirely.

---

## tools we'd welcome

Streamo is small, the implementation is readable, and we are *delighted*
when people show up to help build the surrounding ecosystem. Specifically:

- **A linter / ESLint plugin** — sketched above. We'd help review and
  iterate on the rule set as we use it.
- **An editor extension** — syntax highlighting inside `h\`\``, snippet
  expansion for common patterns, formatter integration.
- **A TypeScript-aware variant of `h`** — if you'd like to bring static
  types into templates, there are interesting paths (template literal
  types, a transformer for the slot positions).
- **Translations** — these docs into your first language, examples
  adapted for other domains.
- **A streamo client in another language** — Python, Rust, Go, Swift,
  Elixir. The protocol is small. We'd love to see this happen.
- **Demos that show streamo at scale** — virtualized lists, real-time
  collab on long documents, the embedded-Canvas-component pattern for
  data-heavy apps.

If you're thinking about building any of these, **tell us what you
need.** Open an issue, file a PR, or just email — we'll help you
understand the corner you're working in and merge your work when it
fits. The goal is that streamo grows a circle of people who feel like
co-owners, not consumers. Your name in `CONTRIBUTORS.md` is a small
gesture in that direction; bigger gestures will be invented as the
circle widens.

---

## what we won't promise

- **We won't match React's tooling ecosystem.** It has a 10-year head
  start, dozens of full-time engineers, billions in adoption pressure.
  Even if streamo were 1000× better technically — which it isn't —
  the gravity of the ecosystem wouldn't budge.
- **We won't auto-magic the static-type story.** Templates as strings
  is a real constraint on type inference; partial solutions exist but
  they're partial.
- **We won't add features just to keep up with frameworks.** Each
  feature has to earn its place against the "implementation fits in a
  sitting" promise. The primitive surface should stay small and the
  abstractions should stay readable.

What we *will* commit to: keeping this document honest, keeping
contributors welcome, keeping the conversation open. When new
objections show up, they'll land here, not get swept under the rug.

---

*This document is alive. If you spot a critique we haven't honestly
named, file an issue or open a PR. Real objections make streamo
sharper.*
