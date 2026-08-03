# deprecated apps

Not mounted in `public/mounts.json`, so they were never served — moving them
here makes that visible instead of leaving eight directories under `apps/`
where six are live.

Moved 2026-08-03, only the ones with **zero** references anywhere in either
repo:

- **gallery** — 4 files
- **shards** — 3 files
- **notes** — 2 files. Also broken: its UI renders
  `node scripts/streamon-do.mjs ping` as the startup instruction, and that
  script was deleted in `ff4d1cc`.

**Deliberately left in `apps/`** despite being unmounted, because "unreferenced"
was the wrong test for them:

- **chat-edit** — the only working `mirror.newDraft()` example in the repo.
  sketch and shared-note were migrated off the removed `update()` by copying
  it on 2026-08-03.
- **passgen**, **shared-note**, **sketch** — referenced from the corpus, and
  the last two had live bugs fixed the same day.

Recover any of these with `git mv` back; nothing about the move is
destructive.
