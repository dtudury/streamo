#!/usr/bin/env node
/**
 * @file wake-watch.mjs — long-lived watcher for a wake-inbox streamo Record.
 *
 * Emits **one line of stdout per advance**, forever. Designed to be run under
 * Claude Code's `Monitor` tool, where each stdout line becomes a notification
 * in the conversation.
 *
 * ## Why this exists, and why `wake-check.mjs` couldn't be fixed in place
 *
 * The Stop-hook shape had an unresolvable tension, documented in the-grove
 * `memory/procedure_waking_on_streamo_events.md` v4: **`WAKE_WINDOW_MS` is not
 * a timeout, it is how long the hook blocks.** The same number means "how long
 * David has to wander off before writing" and "how long the turn is frozen."
 * Raised to an hour for his ergonomics, it froze the end of every turn. Lowered
 * for the turn's ergonomics, the channel is shut before he reaches a terminal.
 * One window cannot serve both; they want opposite values.
 *
 * v4 names the fix as *"decouple blocking from retention"* and stops there,
 * because a Stop hook has to block in order to notice — the blocking **is** the
 * wake. What was missing is a way to wait that doesn't hold the turn. `Monitor`
 * is that: a background watch whose events arrive as notifications while the
 * session keeps working. So the window stops being a tradeoff and becomes a
 * lifetime — `persistent: true` and it runs as long as the session does.
 *
 * ## The cursor file dissolved rather than being ported
 *
 * `wake-check.mjs` kept its cursor in `/tmp/wake-inbox/.cursor-<session>`,
 * per-session because two Claude Code panels sharing one cursor made messages
 * invisible to whichever hook fired second (caught 2026-07-21, Turnstone +
 * Wagtail). **That file existed only because the process was short-lived.** A
 * watcher that outlives the turn holds its cursor in a variable, so the file,
 * the `/tmp` cleanup semantics and the whole class of cross-session cursor bugs
 * go away — not fixed, unneeded. Peel technique: *why does this need a file?*
 * Because it forgets. Stop forgetting.
 *
 * ## Replay-on-arrival is deliberate — do not "fix" it
 *
 * The first emission is the Record's current contents, not an advance. Under
 * the old hook that showed up as a false positive (cursor starts at 0, the
 * whole Record replays) and looked like a bug. v4 argues it is the feature:
 * that replay is *the only reason anyone ever read Turnstone's lost hand-off*.
 * For a channel nobody polls on a schedule, arriving and being told what's
 * there is the point. So it is kept, and labelled `replay` rather than
 * `advance` so a reader can tell the two apart.
 *
 * ## Usage
 *
 *   Monitor({
 *     command: 'WAKE_INBOX_KEY=<hex> node scripts/wake-watch.mjs',
 *     description: 'wake-inbox writes from David',
 *     persistent: true
 *   })
 *
 * Env:
 *   WAKE_INBOX_KEY     hex pubkey of the wake-inbox Record (required)
 *   STREAMO_RELAY_URL  upstream relay (default: wss://streamo.dev)
 *
 * The write side is unchanged — see `procedure_waking_on_streamo_events`.
 */
import { Recaller } from '../public/streamo/utils/Recaller.js'
import { StreamoRecordRegistry } from '../public/streamo/StreamoRecordRegistry.js'
import { registrySync } from '../public/streamo/registrySync.js'

const WAKE_INBOX_KEY = process.env.WAKE_INBOX_KEY
const RELAY_URL = process.env.STREAMO_RELAY_URL || 'wss://streamo.dev'

if (!WAKE_INBOX_KEY) {
  console.error('wake-watch.mjs: WAKE_INBOX_KEY env var required')
  process.exit(1)
}

// **stdout belongs to events; everything else goes to stderr.**
//
// streamo logs connection activity through `utils/turtleLog.js`, which
// `console.log`s unconditionally — there is no quiet switch, and adding one to
// the library to suit one script would be the wrong direction: that logging is
// a feature when a human is watching. But under `Monitor` every stdout line is
// a *notification*, so an unmodified run turns each handshake into a message in
// the conversation.
//
// So the consumer claims the channel it needs. Library chatter is rerouted to
// stderr, which Monitor writes to the output file (readable with `Read`)
// without notifying — nothing is lost, and only real events interrupt.
const out = process.stdout.write.bind(process.stdout)
console.log = (...args) => console.error(...args)

// One line per event, on purpose: Monitor turns each stdout line into one
// notification, so a multi-line dump would arrive as a burst of
// unrelated-looking messages.
const emit = (kind, len, value) => {
  let body
  try {
    body = JSON.stringify(value)
  } catch (e) {
    body = `(undecodable: ${e.message})`
  }
  out(`wake-inbox ${kind} @${len}B — ${body}\n`)
}

const recaller = new Recaller('wake-watch')
const registry = new StreamoRecordRegistry({ recaller })
const session = await registrySync(registry, RELAY_URL)
const record = await session.subscribe(WAKE_INBOX_KEY)

// Start at zero and let the first advance BE the replay.
//
// `session.subscribe()` resolves before the Record has synced — measured
// 2026-08-03: emitting immediately after it returns gives `@0B — undefined`.
// So there is no separate "read what's there" step to write; waiting for the
// first advance is waiting for the initial sync.
//
// Which also explains the old hook's "false positive" properly. v3 blamed the
// cursor starting at 0 and told you to `echo <byteLength> > .cursor-<uuid>` to
// suppress it. It was never a cursor artifact — **it was the Record arriving.**
// That is why it delivered Turnstone's lost hand-off rather than noise, and why
// v4 was right that suppressing it would have been the mistake.
// **`remoteLength`, not `byteLength`** — and this is why `wake-check.mjs`
// stopped working when nobody noticed. `session.subscribe()` returns a Mirror.
// Mirror's `byteLength` is a bare read-through, marked in its own source as
// *"transitional: delete once callers read through `.local`"*, and it does not
// call `reportKeyAccess`. So `recaller.when(() => record.byteLength > n)`
// subscribes to **nothing**: it evaluates once, gets false, and waits forever.
// `remoteLength` is the reactive cursor — *"the byte-length up to which the
// wire has confirmed"* — which is also the semantically right question for an
// inbox. Measured 2026-08-03: the byteLength form hangs indefinitely against a
// live Record that has content.
let cursor = 0
let synced = false

// `watch`, not a loop around `when`.
//
// The first version of this was `for (;;) await recaller.when(() => advanced)`,
// which David read and asked: *"you sure like when — what are you using it
// for?"* For a continuous watcher, nothing. **A loop around `when` is a
// hand-rolled `watch`,** and a leaky one: `when` unwatches itself on resolve,
// so every advance landing between resolve and re-subscribe is silently lost.
// Under load — which is exactly when an inbox matters — that gap is where the
// message goes. `watch` never unsubscribes, so there is no gap to fall into.
//
// Mirror's own doc names the idiom: *"watchers inside a `recaller.watch(...)`
// block that read this get subscribed to advances."*
//
// No AbortSignal, no window, no loop. Lifetime belongs to Monitor — that
// separation is the whole point, since the old script owned its own window and
// that ownership is what froze the end of every turn.
recaller.watch('wake-inbox-advance', () => {
  const len = record.remoteLength
  if (len <= cursor) return
  cursor = len
  emit(synced ? 'advance' : 'replay', len, record.get())
  synced = true
})
