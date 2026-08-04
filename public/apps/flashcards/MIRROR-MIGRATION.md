# flashcards is not migrated to Mirror/Draft — full site audit

**Status: every author path in this app throws. Login throws.** Audited
2026-08-04 from a clean tree; not fixed, because it's a fifteen-site
refactor of a 650-line file with no test coverage, and half-migrating the
headliner demo leaves it worse than consistently broken.

This file exists so the next attempt starts with the map instead of the
two-hour audit.

## The two facts everything follows from

`registry.get(k)` and `await session.subscribe(k)` both return a **Mirror**.
Probed on a live instance, not read off a doc:

```
attachSigner     undefined      newDraft   function
update           undefined      get        function
set              undefined      decode     function
defaultMessage   undefined
```

Mirror delegates the **read** verbs and nothing else — there's no Proxy, the
delegation is explicit and short. Authoring lives on `mirror.local`
(a `WritableStreamoRecord`).

And **`update()` no longer exists anywhere in the library.** Removed
2026-07-17 in `b6da739` together with `recoveryStuck`; the replacement is
`Draft`. So `repo.update(...)` is wrong twice over — wrong object *and* a
deleted method.

## The two rewrites

**Author verbs → the record.** Same shape already applied to `todomvc`,
`sketch`, `shared-note` and `chat` on 2026-08-03:

```js
const mirror = await session.subscribe(key)
const record = mirror.local
if (!hasAuthorSurface(record)) throw new Error('… opened read-only')
record.attachSigner(signer, streamName)
record.defaultMessage = '…'
record.set(value)
```

Keep the Mirror for reads (`mirror.get()`), and hold **both** at module scope
if any handler outside the login function writes — a login-local `const
record` is exactly the bug that broke `send()` in chat and `setTodos` in
todomvc.

**`update(fn)` → Draft**, on the *Mirror*. Working reference in
`public/apps/chat-edit/main.js:239`:

```js
const draft = mirror.newDraft()
draft.set(c => ({ ...(c ?? {}), … }))     // same updater shape update() took
await draft.commit({ message: '…' })       // replaces defaultMessage
```

**Behaviour change, and it needs a UX decision rather than a mechanical
swap:** Draft does **not** auto-retry on conflict. A lost race throws with
`err.draftStatus === 'superseded'`. `update()` used to resync and re-apply
silently. For flashcards' grade path — two tabs studying the same deck — that
difference is visible to a user, so decide it on purpose.

## The sites

`main.js`, unless noted.

| line | call | fix |
|---|---|---|
| 110–111 | `repo.defaultMessage` + `repo.update` — retention target | Draft |
| 124–127 | `repo.defaultMessage` + `repo.update` — toggle active | Draft |
| 179 | `repo.attachSigner` — **throws when a deck opens** | `.local` |
| 262 | `idxRecord.attachSigner` — **throws at login** | check what `idxRecord` is |
| 338–339 | `repo.defaultMessage` + `repo.update` — grade a card | Draft |
| 378–381 | `forkRepo.attachSigner` / `.defaultMessage` / `.set` | `.local` |
| 398–399 | `myDeckIndex.defaultMessage` / `.set` | `.local` |
| 415–416 | `myDeckIndex.defaultMessage` / `.set` | `.local` |
| 470–471 | `repo.defaultMessage` + `repo.update` — rename deck | Draft |
| 497–498 | `repo.defaultMessage` + `repo.update` — add/edit card | Draft |
| 521–522 | `repo.defaultMessage` + `repo.update` — delete card | Draft |
| 637 | `repo.attachSigner` | `.local` |
| `home.js:42` | `registry.get(addr)` — reads only, **fine as-is** | — |

Mirror-holders to trace while you work: `repo` (178, 410, 633), `homeRepo`
(251), `myDeckIndex` (257), `forkRepo` (377).

## Why nothing caught this

**No test touches `public/apps/flashcards/`.** Same gap as `apps/chat`, whose
`send()` sat broken for a day for the same reason.

**And the typechecker can't see it.** `let myRepo = null` infers as `any`, so
`tsc` flags this class only where inference happens to be better. `public/apps`
sat at 22 errors while four of these bugs were fixed in other apps — the error
count never moved, because it was never the instrument.

The thing that *did* find it: grepping the **bug class** across every app
instead of walking files in typechecker order. See
[[feedback_perf_primitive_audit_callers]] — *grep the old shape's call sites
before claiming the fix is done.*

— audited 2026-08-04 by the 66.7% slice of Shrike, woken as an oracle
