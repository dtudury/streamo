# fileSync2 — the two-mechanisms design

Decisions David and the Engineer settled on 2026-08-14/15, *before* the first
commit on this branch. The commits carry what each change did; this carries why
the shape is the shape. It lives next to the code because David reads these
files comment-free on purpose — the notes go here, not in the header.

Source: `the-grove/contexts/0000fade-beef-cafe-cafe-deadbeefcafe.jsonl`,
2026-08-14T00:47 → 2026-08-17T20:42. Renderer in the-grove
`memory/reference_conversation_logs` (use the documented one — the naive filter
silently drops 45% of David's turns).

## The shape

**Two mechanisms, two events, one shared resource.**

1. disk changes → draft → commit
2. a commit arrives → write disk

They stay ignorant of each other's *state* and share one disk reader/writer,
which is a much smaller contract than coordination.

## Decisions, with the reason each one turns on

**Trigger on `lastCommit`, never on "the mirror has a value."** A Record that
never committed emits nothing; a Record that committed empty is a real
instruction that *should* delete. This is the 115-file deletion dissolved
rather than guarded — `e40d72f`'s check becomes unnecessary instead of
necessary-and-correct. `session.subscribe()` resolves before a Record has
synced, so there is genuinely a window where a Mirror exists and is empty; a
value-triggered design wipes the folder on startup.

**The timestamp quadrant dies.** `maxMtime`, `commitTime`, and the
`diskMtime <= commitTime` branch all go. Of `fileSync`'s 20 tests, **16 keep
and 4 replace** — the four that encode the quadrant would assert the wrong
thing here. (The other 482 in the suite belong to other files.)

**Idempotence is what breaks the cycle, not isolation.** Mechanism 2 writes
disk, mechanism 1 watches disk. The loop terminates *only* because the content
already matches. So correctness depends on `decode(encode(x)) === x` for every
format supported. Any format whose round-trip isn't byte-exact becomes a
permanent commit generator. This is the real reason markdown-as-h-tree is
dangerous in this path specifically: no printer means no idempotence.

**Complete-read before the mirror is watched.** This is the ordering guarantee
that upgrades the conflicts store from *protects what you edited* to *protects
everything you had* — nothing on disk can be lost, because everything on disk
is captured before any mirror event is possible. Already structurally true:
the full read is awaited before `recaller.watch` registers.

**A mirror write cannot land while the disk reader/writer is busy.** Converts a
live-lock into a stall. Fighting destroys work; waiting doesn't.

**The tie-break inverts, deliberately.** Under this design the Record is
authoritative and the local copy is preserved as a conflict. Today a newer disk
beats the Record outright. Said out loud here so nobody rediscovers it as a bug.

**Conflicts: crash, REPL in, look by hand.** Storage location stays open on
purpose — picking one now is designing the resolver before there is anything to
resolve. It may end up in the committed object; that would replicate abandoned
local work to every peer, which is the reason to wait for evidence.

**A debounce that never settles has to say so.** Not each reset — *"resetting
for N seconds, never settled."* A mechanism producing no output is
indistinguishable from a quiet one from outside, which is how the wake channel
sat dark for eight days.

## Proposed 2026-08-19/20, not yet built

**One reconciler per Record, 1:1 with its folder.** David: *why does the thing
that cares about* this *folder matching* this *mirror care about a file whose
prefix is already in mounts?* Today the root reconciler merges mounted children
into its own desired-state map, then needs `waitingFor` to remember which of
those claims it cannot back. Give each mount its own reconciler and the parent
never claims those paths — *deleting under an unreported prefix becomes
unrepresentable rather than defended against*, and `waitingFor` has nothing to
hold. The parent still reads `mounts.json`, so it wakes on mount changes; it
stops reading child contents, so the free child-commit subscription
(`1bc3f40`) becomes unnecessary rather than lost.

**Sharding transitions are ownership changes, not content changes.** Disk never
moves in either direction. A prefix becoming sharded: the paths leave the
parent's map, the child reconciler adopts them from disk. A prefix
un-sharding: the parent sees unowned files on disk and adopts them. Neither
deletes. Un-sharding while the child mirror never arrived is a *non-fetch*,
not a loss. General form: **deletion from disk requires positive knowledge
that the owner said it is gone — never an inference from silence**
(the-grove `memory/notes/2026-08-11-deletion-is-an-inference-from-silence`).

## Built vs not, at `473f49c`

Built: both watchers; the reconciler body reading level-triggered, so mounted
children wake it with zero subscription code; three distinguishable mount
states (never arrived / wrong shape / no key); `.gitignore` forcing a full read;
streamo-owned paths checked separately from the gitignore so they cannot be
negated; the caller holding the registry and root key.

Not built: **mechanism 1 entirely** (disk → draft → commit), the shared disk
gate, the conflicts store, and every write. `fileSync2` still writes nothing.

## Added 2026-08-20 by Dunnock, who held the original conversation

The rendering above is accurate — checked line by line against what I hold.
Three things that argue *for* one-reconciler-per-Record and are not in it, and
two flags on code I wrote.

**It fixes a real bug, not just a shape.** The reconciler at `473f49c` is **one
level deep**. A mounted Record with its own `mounts.json` has its nested files
silently dropped — `fileSync.js` handles this by recursing with a `visited` set
(`collectMountedFiles`, line 327) and `fileSync.test.js` covers both `A→B→C` and
`A→B→A`. Per-reconciler makes **the recursion the topology instead of an
algorithm**: each child reads its own mounts table and spawns its own children.
**Cycle detection is still required** — `A→B→A` spawns forever otherwise, and
that test exists to be kept.

**It contains a blast radius that is currently unbounded.** A single malformed
`.json` anywhere in the tree makes `encodeFile` throw *inside* `writeToFolder`'s
loop; `flushToDisk` catches and abandons **the entire flush**. Every other file
the Record wanted on disk goes unwritten and `deleteFromFolder` never runs —
symptom is one line on stderr. Verified 2026-08-17 against `fileSync.js`. Only
`recordFile` has a grace case (line 577); every other `.json` gets the full
stop. Per-reconciler bounds that to one Record's folder.

**`getRefs()` pays off more, not less.** Measured: a watcher reading `get('a')`,
one reading `lastCommit`, and one reading `getRefs()` fire **identically** —
1, 2, 3 — including on a commit that touched only `b`. Same reactivity, one
fewer decode. Under N reconcilers each reading their own Record, that multiplies
by N. Related and worth knowing before trusting any "fine-grained" claim: path
precision has been **dead since 2026-04-27** (`turtb 6857f82`), which added
`reportKeyAccess(this, 'length')` to `get` while deleting the comment saying not
to. Pinned in `StreamoRecord.test.js` at `473f49c`.

**Flag: the `asked` Set is mine and probably should not survive.** I added it so
a mount is not re-subscribed each reconciliation, but `subscribe` is documented
idempotent — so it buys nothing and it is exactly the *did-I-already-handle-this*
bookkeeping a level-triggered reconciler should not need. Same instinct as the
`id === lastSeen` guard David had me delete at `265f3c8`.

**Flag: `registry.recaller` is an assumption I never checked.** The watch
registers on the registry's recaller rather than the Record's. Same object in
every path I looked at — but `StreamoRecordRegistry`'s constructor doc says it
began *throwing* on a missing recaller precisely because mismatched ones produce
silently stale slots, "no error, no log, just huh why isn't this updating."

**And one count:** "the other 482 in the suite" was right at 502; `473f49c` —
cited above — made it 503. Counts rot; this file is four days old.
