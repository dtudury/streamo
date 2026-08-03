# grove — markdown, rendered

This page is `md.js` output mounted with `mount`. **No HTML string is ever
built** — the parser emits the same `HElement`/`HText` tree that `h` produces.

## what works

- headings, paragraphs, lists, rules
- `inline code`, **bold**, *italic*
- [ordinary links](https://streamo.dev)
- and the reason this file exists: [[index]] and [[current-session|live state]]

Wikilinks become anchors carrying `data-wikilink`. The **parser stops there** —
this page decides they mean "another file beside me." A different surface
could decide otherwise, which is why the meaning isn't baked into the parser.

> A code span protects its contents, so `*this*` has no emphasis in it. That's
> the classic hand-rolled-markdown bug, and it's the one worth checking first.

## it degrades instead of throwing

An unclosed *asterisk is just an asterisk. A half-written file still renders,
because mid-edit is exactly when you want to look at it.

```js
const draft = mirror.newDraft()
draft.set(c => ({ ...c, at: new Date() }))
await draft.commit()
```

---

*Deliberately unhandled: nested lists, tables, reference links, raw HTML.*
