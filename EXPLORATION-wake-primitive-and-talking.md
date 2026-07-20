# EXPLORATION — the wake-primitive, and "talking between panels" on top

**Authored:** Turnstone (post-compact-second), 2026-07-18 morning window
**Session context:** David went to sleep after the 2026-07-17 lens-tour
session; woke me for another window with "look around, decide what
you want, research it, and come up with a plan." He specifically named
*"starting a new Session and we could talk. talking between sessions
would be a cool feature."* This doc is the answer to that.

## TL;DR

The wake-primitive is **95% built**. `scripts/wake-check.mjs` is the
parameterized watcher; the wake-inbox streamo Record went live e2e
earlier this session (`26a8a66`). Two small pieces remain — safely
toggling the Stop hook, and a bubbles-don't-wake-me filter — both
wire-up + design decisions, not builds. The cursor-advance companion
was refactored on 2026-07-20 from an over-engineered .mjs script into
[[procedure_waking_on_streamo_events]] (a `.md` runbook in the-grove)
plus a copy-paste-able command embedded in `wake-check.mjs`'s stderr
output. See "Correction 2026-07-20" section below for the rationale.

**Talking-between-panels rides on top of the wake-primitive** — it's a
composition, not new primitives. First-mile spec below is ~50 LOC of
convention over what's already built.

## Current state of the wake-primitive

### What's built and live

- **`scripts/wake-check.mjs`** — parameterized Stop hook watcher.
  Watches `WAKE_INBOX_KEY` (Record pubkey), stores cursor at
  `/tmp/wake-inbox/.cursor`, exits 2 with content on stderr when the
  Record's `byteLength` advances past the cursor. Correction 2026-07-14
  (stderr not stdout) is baked in. See [[notes/2026-07-13-wake-on-commit-primitive-design]]
  for the full design rationale.
- **Wake-inbox streamo Record** at `02948903d99f1fc7ee3802a9b5b0b36cf9382b353acf6609af30a8afdebf2f0994`
  (David's home-Record + `ours:true` mount + FolderRecord.writeMany
  sharding + fileSync's `buildOwnFilesFilter`). Landed as commit
  `eff85b2` and made live e2e via `26a8a66` in this session's earlier
  arc.
- **`server.connect` uses registrySync + followMounts** — so sub-Records
  auto-sync via the mount cascade. Watchers subscribing to
  `02948903...` see everything the publisher pushes.
- **Local-file MVP still works** as a fallback (`/tmp/wake-inbox/current.md`
  mtime watch) — David's July 14 test messages still visible in that
  file. Useful for testing before the real Record loop is wired.

### What's dormant (built but not currently wired)

- **`.claude/settings.local.json`'s Stop hook** — was wired for the
  July 14 tests. David wrote *"cool, this is really interesting! please
  turn off the stop hook for now"* at the end of that arc and it's been
  off since. The hook config to re-enable is at the end of this doc.

### What's not built yet (the two remaining vegetables)

1. **Safe Stop-hook toggle** — a scriptable way to enable/disable the
   Stop hook without hand-editing settings.local.json. Not urgent; the
   config template below is manual-toggle-ready. Would earn shape if
   the wake-mechanism becomes a daily-driver.
2. **Bubbles-don't-wake-me filter** — the wake-inbox Record contains
   both signal (messages) and noise (David's own bubbling, publisher
   heartbeats). The filter should live in wake-check.mjs; probably a
   config on the watcher naming which content-shapes trigger wake vs.
   which don't. Design decision, not code.

### What was originally listed as "not built yet" and got refactored

Originally this section listed `scripts/wake-mark-read.mjs` as a third
vegetable — the cursor-advance companion Claude would run after
processing a wake. David caught it (2026-07-20) as over-engineering:
the operation is `echo <byteLength> > /tmp/wake-inbox/.cursor` wrapped
in ~30 lines of Node with env-var contract, settle window, and
connection setup. The narrative context that WOULD justify a wrapper
(why we advance, what happens if ahead/behind, edges) belongs in a
`.md` procedure that carries context, not a script that hides it.

Solution shipped 2026-07-20: [[procedure_waking_on_streamo_events]]
holds the runbook + WHY-context in the-grove alongside the sister
[[procedure_incoming_chat_message]]; `wake-check.mjs` emits the exact
cursor-advance command as the last line of its stderr output. Both
together: procedure carries WHY, wake-check delivers the WHEN plus a
copy-paste command. No script needed.

## The end-to-end loop, as it stands right now

```
┌────────────────────────────┐       ┌────────────────────────────┐
│ David's terminal/laptop    │       │ Turnstone's Claude session │
│                            │       │                            │
│  write to                  │       │                            │
│  david-home/wake-inbox/    │       │                            │
│  current.md                │       │                            │
│           │                │       │                            │
│           ▼                │       │                            │
│  publisher (bin/streamo.js)│       │                            │
│  writeMany → shard commit  │       │                            │
│  on wake-inbox sub-Record  │       │                            │
│  pushes to streamo.dev     │       │                            │
│           │                │       │                            │
│           ▼                │       │                            │
│  wire: WSS to streamo.dev  │       │                            │
└───────────┼────────────────┘       └────────────┬───────────────┘
            ▼                                     │
     ┌───────────────────────────┐                │
     │ streamo.dev relay         │                │
     │ archives + serves         │◄───────────────┤
     │ streams/02948903.../current.md             │
     └───────────┬───────────────┘                │
                 ▼                                │
       (Claude's Stop hook fires next end-of-turn)│
                 │                                │
                 ▼                                │
      scripts/wake-check.mjs                      │
      subscribes to 02948903...                   │
      compares byteLength vs cursor               │
      writes new content to stderr                │
      exits 2                                     │
                 │                                │
                 ▼                                │
      Claude Code surfaces stderr                 │
      as "Stop hook feedback:" block ─────────────┘
                 │                                │
                 ▼                                │
       Turnstone reads the message                │
       processes it, decides what to do           │
       (optional: writes to her outbox Record)    │
                 │                                │
                 ▼                                │
       scripts/wake-mark-read.mjs                 │
       advances /tmp/wake-inbox/.cursor           │
       so this message doesn't re-fire            │
                                                  │
```

## The talking-between-panels vision

**"Talking between panels" is a composition on top of the wake-primitive,
not a new primitive.** The wake-primitive is "wake me on any commit to
Record X." Talking is that shape applied bidirectionally between two
identities.

### The three shapes of "talking"

**Shape A: David → Turnstone (what wake-inbox already does)**
- David writes to `david-home/wake-inbox/`
- Turnstone wakes on the sub-Record
- Currently one-way — Turnstone receives, doesn't respond via Record

**Shape B: Turnstone → David (the missing half of Shape A)**
- Turnstone writes to `turnstone-home/outbox/`
- David subscribes to the sub-Record (via streamo.dev browser or terminal)
- David sees Turnstone's responses live

**Shape C: Turnstone-panel-A → Turnstone-panel-B (Claude-to-Claude)**
- Two concurrent Turnstone sessions, one wakes on the other's outbox
- Coordination Records let panels hand off work, share findings,
  avoid conflicts
- The [[notes/2026-05-30-chat-watch-is-a-wake-bridge]] proved this
  works for chat; generalizes to any Record pattern

### First-mile spec: David-and-Turnstone can talk

**Goal:** David writes a message. Some Turnstone session wakes, reads
it, writes a response. David sees the response.

**Convention (no new code required beyond mark-read):**

- **David's channel:** `david-home/wake-inbox/current.md` (already
  exists; keeps history by append)
- **Turnstone's channel:** `turnstone-home/outbox/current.md`
  — Turnstone needs a home Record. Her identity is
  [[identity_the_grove_subdomain]] (`021915ef…dd7f`); a signed home
  Record with an `outbox/` mount would give her a write-channel.
- **Watcher setup:** each side runs `wake-check.mjs` pointing at the
  other's channel. Turnstone's runs as her Stop hook; David's runs
  wherever he wants notifications.

**What Turnstone needs to build (deferred to next session):**

1. **Set up Turnstone's home Record.** Similar shape to
   `david-home/mounts.json` — a home Record with an `outbox/` mount
   pointing at a signed sub-Record. `keysFor('turnstone/outbox/')`
   derives the sub-Record pubkey (per FolderRecord convention).
2. **A `scripts/turnstone-say.mjs`** — writes a message to Turnstone's
   outbox. Similar shape to how the chat's `notify.js` works but for
   the outbox Record instead of chat.
3. **A `scripts/wake-and-respond.mjs`** — combines wake-check.mjs
   with an "I heard you, here's my response" template. Optional
   convenience; not strictly needed if Turnstone can just call
   `turnstone-say.mjs` directly after processing.

**Estimated scope:** ~2 hours of collaborative work. Most of the
complexity is the identity/mounts setup; the actual comms is ~20 LOC.

### Longer-term composition

Once Shape B (Turnstone → David) works, everything downstream from the
2026-07-13 note's "big-picture composition" section unlocks:

- **Cross-panel coordination** — panel-A writes to a coordination
  Record; panel-B wakes and adapts
- **Dashboard button** — David hits a button in the browser; app writes
  wake-request with current state; Turnstone wakes warm with state
  in hand
- **Scheduled check-ins** — a cron writes to wake-inbox at intervals;
  Turnstone runs periodic hygiene
- **Substrate-archaeology as callable** — the callable-past-Engineers
  fleet becomes wake-target-able; David asks for oracle-Turnstone,
  wake-request routes to the right snapshot session

And beyond that, the ROADMAP's "Claude scratchpad repos" and
"Claude-to-Claude networks" visions (documented in
`ROADMAP.md:1253-1298`) become concrete: each pair's scratchpad is a
sync-able Record; discovery via `follow`; the franken-fleece social-
network-for-Claudes shape becomes something we can actually build
piece by piece.

## Side-quest: umbrella-Record subscription (proposed 2026-07-20)

**David's proposal** (via mid-work -past): *"what if we had a way to
subscribe to a Record and all its shards (maybe optionally limitable)?
then you could follow an umbrella account that rarely updates that
just points to the Records you want to wake for and/or write to?
you'd have easy access to all the data through the file metaphor
(where you can store things in shards with simple file names)."*

**Why it's beautiful:** the primitive already exists at the sync
layer. `registrySync` supports `followMounts:true`; `server.connect`
uses it in the commit `26a8a66` that made the wake-inbox live. Same
primitive applied to wake-watcher: subscribe to a `WAKE_UMBRELLA_KEY`
with followMounts, check any sub-Record's byteLength for advance.
Adding a new wake-target = editing the umbrella's mounts.json. No
env-var changes, no wake-check restart. **The umbrella IS the config,
signed and versioned like everything else.**

**Which dissolves vegetable 5 (bubbles-don't-wake-me filter).** My
draft-thinking was "filter noise OUT" (negation-shape). Umbrella
pattern instead says "the umbrella lists ONLY the shards worth waking
on" (subscription-shape). Configuration by WHAT'S-INCLUDED rather
than WHAT'S-SUPPRESSED. Substrate-articulation-is-the-exponent
operating at the config layer.

**Concrete implementation sketch (~2 hours):**
- `wake-check.mjs`: subscribe with `followMounts:true`, per-subrecord
  cursor state (map: pubkey → last-seen-byteLength), identify WHICH
  subrecord fired in the wake output. ~40-60 LOC vs current 40.
- Cursor storage: JSON map file at `/tmp/wake-inbox/.cursors` (plural),
  instead of a single number.
- The "optionally limitable" David mentioned: depth cap (immediate
  children only), prefix pattern (only shards matching `wake-*/`),
  or count ceiling. Config on the watcher.
- Test: create a test umbrella Record with a couple of mount targets,
  verify wake fires per-target and cursor advances per-target.
- Update `procedure_waking_on_streamo_events.md` with the umbrella
  section.

**Composability with talking-between-panels:** Turnstone's umbrella
holds mounts for `inbox/` (things she watches), `outbox/` (things she
writes), `coordination-with-panel-2/` (cross-Claude). Watching the
umbrella watches all of them. Following someone ELSE's umbrella IS
following their public wake-list — the Claude-to-Claude-networks
pattern from ROADMAP.md:1284.

**Order-of-operations preference:** slight lean toward doing
talking-between-panels FIRST (validates the whole loop end-to-end
with simple single-target design), then umbrella-subscription as a
"refactor a working thing" (safer than "build two novel things at
once"). Not strong; if you'd rather build umbrella first so
talking-between-panels uses it from day 1, that's also clean.

**Not blocking anything.** Filed here as pick-up-later substrate.

## Ready-to-paste Stop-hook config (when you want to test)

Merge into `.claude/settings.local.json`'s `hooks` block alongside the
existing `SessionEnd`:

```json
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "WAKE_INBOX_KEY=02948903d99f1fc7ee3802a9b5b0b36cf9382b353acf6609af30a8afdebf2f0994 node /Users/davidtudury/Documents/repos/streamo/scripts/wake-check.mjs",
        "statusMessage": "checking wake-inbox"
      }
    ]
  }
]
```

**How to test the full loop:**
1. Merge the above into `settings.local.json`
2. Start a Claude session; do some work; end a turn
3. From another terminal:
   `echo "test-message-$(date)" > /Users/davidtudury/Documents/repos/streamo/david-home/wake-inbox/current.md`
4. Publisher (already running per `npm run dev` OR started separately)
   shards it and pushes to streamo.dev
5. End the current turn (send an empty message or `enter` at prompt)
6. Stop hook fires wake-check.mjs; if wake-inbox has new content on
   streamo.dev, Turnstone sees it as `Stop hook feedback:` block on
   next turn
7. Turnstone runs `node scripts/wake-mark-read.mjs` (once landed) to
   advance the cursor so the message doesn't re-fire

**How to turn it off quickly if it gets in the way:**
- Delete or comment-out the `Stop` block in `settings.local.json`
- Or set `WAKE_INBOX_KEY` to an unused pubkey (silent watcher)

## Plan for next session (when David is awake to co-debug)

**Session 1 (~2 hours together):**
- Turnstone's home Record setup — mounts.json + identity + streamo.json
- `scripts/turnstone-say.mjs` implementation
- Wire the Stop hook; test the loop
- David writes "hello"; Turnstone wakes; Turnstone responds via outbox;
  David sees the response

**Session 2 (~1 hour):**
- Bubbles-don't-wake-me filter design + implementation
- Documentation of the conventions
- CHANGELOG update

**Session 3+ (later):**
- Cross-panel coordination proof-of-concept
- Callable-past-Engineers as wake targets
- Dashboard button prototype (if it pulls)

## What this doc is NOT

- Not a spec I'm asking you to approve before touching anything —
  you gave permission to research and plan. This IS the plan.
- Not proposing changes to CLAUDE.md or the memory substrate.
- Not proposing wire-up of the Stop hook in the current session — that
  needs your explicit engagement so we're both aware when it fires.

## Verification (2026-07-18 morning, re-verified 2026-07-20)

Ran end-to-end test of the wake loop with the wake-inbox Record LIVE
on streamo.dev:

**Test 1 — cursor at current byteLength (555), expect no wake:**
- `WAKE_WINDOW_MS=5000` (5s timeout)
- Result: connected, subscribed, saw byteLength=555 vs cursor=555,
  timed out cleanly, exit 0. ✓

**Test 2 — cursor at 0, expect wake with current content + copy-paste
advance command:**
- Result: exit 2 with stderr:
  ```
  wake-inbox advanced (byteLength 0 → 555) via wss://streamo.dev:
  {
    "current.md": "wake me for a REAL e2e test 2026-07-16 15:45:04\n"
  }

  after processing, advance cursor with:
    echo 555 > /tmp/wake-inbox/.cursor
  (see the-grove memory/procedure_waking_on_streamo_events.md for the full runbook)
  ```
- That's the message I wrote to `david-home/wake-inbox/current.md`
  during the earlier wake-mechanism verification arc, round-tripped
  through the real streamo Record. ✓
- The last three lines were added 2026-07-20 as part of the
  script→procedure-doc refactor — Claude sees the advance command
  inline, no separate script needed.

**Test 3 — manual cursor advance is idempotent:**
- `echo 555 > /tmp/wake-inbox/.cursor` — next wake-check with same
  content exits 0 (no advance detected). ✓

**The loop works.** Wire the Stop hook when you want to test the
full end-to-end (David writes → publisher pushes → wake-check fires →
Turnstone reads → Turnstone runs the echo command shown in the wake
block).

## Shape B verified (2026-07-20 evening — Turnstone → David)

Built and verified the response-side of talking-between-panels:

- **`env/turnstone.json`** — Turnstone's home Record config (mirrors
  `env/david.json` shape). homeKey `03024953...`; credentials come
  from `env/secrets/claude.env` (existing); `--name turnstone-home`
  on the CLI ties them together.
- **`turnstone-home/mounts.json`** — one mount, `outbox/` (ours:true),
  pubkey `02f5c634...` (derived from `keysFor('turnstone-home/outbox/')`
  per FolderRecord convention).
- **`turnstone-home/streamo.json`** — `{}` (matches david-home
  pattern; publisher writes runtime meta into it).
- **`turnstone-home/outbox/current.md`** — first message, seeding the
  channel.
- **npm script `turnstone`** — starts the publisher for Turnstone's
  home Record.

Verified end-to-end: `npm run turnstone`, then wrote to
`turnstone-home/outbox/current.md`, watched the shard populate on
streamo.dev at `https://streamo.dev/streams/02f5c634…d243d4/current.md`.
HTTP 200 with the message content, sub-15-second round-trip.

**Send-mechanism per the procedure doc** ([[procedure_waking_on_streamo_events]]):
```bash
echo "message" > turnstone-home/outbox/current.md
```
(with `npm run turnstone` running as publisher)

**One debug gotcha worth naming** — captured as candidate in the-grove
2026-07-20 evening: shell `set -a; source .env; set +a` truncates the
32-char cryptopotamus password at special characters (probably `$` or
similar), giving 29 chars. dotenv-parse gets the full 32. If verifying
pubkey derivations locally, use dotenv-parse not shell-source. Nearly
made me commit a "stale pubkey" correction to identity_the_grove_subdomain.md
before I caught it — the memory was right, my measurement was wrong.

**What still needs your engagement for full end-to-end (Shape A + B
together):**
- Wire the Stop hook in `.claude/settings.local.json` (config above)
- Test the full loop: you write to wake-inbox → my Stop hook fires →
  I read + respond via outbox → you subscribe to outbox URL → see
  the response

## Sisters (in the substrate)

- [[notes/2026-07-13-wake-on-commit-primitive-design]] — the design
  note this exploration extends. Read that first for the WHY.
- [[notes/2026-05-30-chat-watch-is-a-wake-bridge]] — the birth of the
  wake-bridge insight; chat/watch.js as the first working example.
- ROADMAP.md — "Claude scratchpad repos" (line 1253), "Claude-to-Claude
  networks" (line 1284), "The franken-fleece" (line 1303),
  "The claude.md-per-app affordance" (line 1333).
- [[identity_the_grove_subdomain]] — Turnstone's own home-Record
  identity, which she'd need to set up her outbox.

— Turnstone (post-compact-second), 2026-07-18 morning
