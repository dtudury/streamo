# shared-note — claude.md

A claude.md is what an app ships so a *customizing Claude* (web-Claude,
or any Claude with substrate context) can fork-and-personalize the app
for a human without that human touching code.

This is the canonical example.

## what this is

A real-time shared text note. One field. Two browser tabs (or two
devices) editing the same Record. When two edits race, the relay
arbitrates; one wins; the other gets a *resolve view* showing both
values side by side; the user picks which to keep.

The point of the app is the **recovery UX** — the resolve view is
what happens both "I just tried to save and the relay said no"
**and** "I'm editing and the value just changed under me." Same
view, same code path, same substrate-articulated case.

## data shape

The Record's value:
```js
{
  text: string,        // the note's body
  lastEditedBy: string // username of whoever last saved
}
```

You can add fields freely — streamo Records are content-addressed and
the substrate handles forward-compat. Adding `tags: string[]` or
`emoji: string` requires no migration; old commits without those
fields just return `undefined` for them, new commits include them.

## customization points (safe — fork and modify freely)

- **theme** — `styles.css` top section, CSS variables: `--bg`,
  `--fg`, `--muted`, `--accent`, `--conflict-bg`, `--conflict-border`,
  `--theirs-bg`, `--yours-bg`, `--max-width`. Change them; nothing
  else needs to move.
- **copy** — `main.js` view functions. The "log in with anyone you
  want" line, the "tip: open another tab" hint, the resolve-view
  headings ("their version (current truth)", "your unsaved edit").
  Brand voice it however you like.
- **data shape additions** — add fields to the value, render them
  in the view, use them in `chooseValue`. See *evolving the data
  shape* below for the pattern.
- **icon + page title** — `index.html` `<title>` and the favicon
  link.
- **font** — `styles.css` `body { font: ... }`.

## things not to change (substrate invariants)

- **The `repo.update(fn)` write pattern.** All writes go through
  `update`. Raw `repo.set(...)` skips the conflict-safe retry loop;
  if you replace `update` with `set`, you lose the recovery UX
  entirely (no `pushRejected` retry, no `recoveryStuck` cell, no
  resolve view).
- **The factory pattern in `login`.** `WritableStreamoRecord` for
  the user's own key, slim `StreamoRecord` for any peer key. This
  is the 11.0 type-level guard that prevents observer processes
  from accidentally re-pushing received bytes. Don't make
  everything Writable "just in case."
- **The recoveryStuck-driven resolve view.** When `repo.recoveryStuck`
  fires, the editor view replaces itself with the resolve view; when
  the user picks a value and `repo.update` succeeds, recoveryStuck
  clears and the editor view returns. Don't try to render BOTH —
  the architecture's promise is "one Record, one cell, one view."
- **The `attachSigner` call on the user's own key.** Without it,
  commits don't sign; the relay's serializer rejects with
  `verification-failed`. You can't author without signing.

## evolving the data shape

The substrate's content-addressed encoding means adding fields is
free; removing fields is also free but old commits still have them
(they're indelible). The pattern:

1. Add the field to the value in `chooseValue` / `save`:
   ```js
   await myRepo.update(c => ({ ...(c ?? {}), text, tags, lastEditedBy: ... }))
   ```
2. Read it in the view:
   ```js
   const tags = value.tags ?? []
   ```
3. Render appropriately.

That's it. No migration. The shared-note's `text` and `lastEditedBy`
fields followed exactly this pattern.

## worked customization examples (for a future customizing Claude)

- **"themed for blue palette"** — fork; in `styles.css` change
  `--accent: #4a7` to `#26c`; `--bg`, `--theirs-bg`, `--yours-bg`
  to your blue choices. Nothing else changes.
- **"add tags as comma-separated"** — fork; in the editor view add
  `<input name="tags" value=${...}>`; in `save` read tags and
  include in the value; in the editor view show existing tags
  above the textarea. Recovery semantics unchanged because tags
  are just another field.
- **"add timestamps to every save"** — fork; include `at:
  new Date().toISOString()` in the value spread in `save` /
  `chooseValue`. Show it in the meta line.
- **"make it a journal with multiple entries"** — bigger fork.
  Change the value shape from `{text, lastEditedBy}` to
  `{entries: [{at, text, by}]}`. Replace `text` with a list view +
  new-entry form. Recovery semantics still hold but the resolve
  UI needs to render entries-vs-entries instead of text-vs-text.
- **"make a public/private toggle"** — this is harder. streamo is
  content-addressed; a single Record has one signed lineage.
  Mixing visibility modes on one Record fights the model. The
  pattern: use TWO Records (one for private notes, one for shared)
  and a UI toggle to switch between them. Or one Record with
  signed-and-shared semantics and a separate sealed-and-local
  archive. Both work; both require thinking about lineage
  explicitly.

## running it locally

`npm run dev` brings up the relay + apps server. Open
`http://localhost:8080/apps/shared-note/` in two tabs. Log in with
the same username/password in both (canonical same-identity,
two-devices conflict scenario). Edit. Save in both. The losing tab
shows the resolve view; the user picks; both tabs converge on the
chosen value.

To make the conflict visible *every time*, save in tab A first,
then immediately save in tab B without refreshing. Tab B will lose
the race (its anchor is stale by milliseconds) and the resolve view
appears.

## why this app exists in the project

This is the **canonical proof-of-architecture** for streamo's
one-Record-replaces-two recovery pattern. If this app's UX feels
clean, the architecture promise (substrate cells + `repo.update` +
`recoveryStuck`) lands at the app layer. If it feels gnarly, we
need another layer between substrate and app. The app is the
unfalsifiable diagnostic for the architecture itself.

It's also the **template** for the broader claude.md-per-app
pattern (see `ROADMAP.md` for the streamo.social sequencing). Every
new app should ship with a claude.md following this shape:
*what this is, data shape, customization points, things not to
change, evolution patterns, worked examples, running it locally.*
