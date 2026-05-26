# EXPLORATION — slimming StreamoRecord

*Conversational exploration captured 2026-05-26 night, after the
10.3.0 arc landed. David's observation: `StreamoRecord.js` is at ~1030
lines and is doing several things; would slicing concerns into smaller
files with cleaner stories make the substrate more articulate? And
specifically — what's the **minimum a StreamoRecord can have and still
be a StreamoRecord?***

The exploration is the diagnostic. Each thing we can pull off without
breaking Record-ness tells us it wasn't essential to the definition.

## The four concern-axes mashed onto one class today

1. **Chain-codec core** — `lastCommit`, `committedChainHash`,
   `valueAddress` (SIG-skipping), `signedLength`, lazy `get`,
   `getRefs`, `files`, `history`, `verify`. *What a Record IS:* a
   Streamo with a signed chain on top.

2. **Author capability** — `attachSigner`, `set`, `setRefs`,
   `commit`, `checkout`, `defaultMessage`, `update`, `merge`, `sign`,
   `#scheduleSign`. *Methods that make commits.* Throw if no signer
   attached.

3. **Wire state** — `hasRelay`, `relaySubscribedAtOffset`,
   `caughtUpToRelay`, `isReadyToAuthor`, `relayChainHash`,
   `pushRejected`, `conflictDetected`, `_attachSession`,
   `_awaitChainHash`. *Reactive cells that only mean something when a
   session is attached.* Carry null-state weight when not.

4. **Relay-side mechanics** — `makeRelayInboundStream` (trust+append
   from the wire), `_setRelayChainHash`, `_setPushRejected`,
   `_setConflictDetected`, internal setters called from the relay's
   inbound stream. *The relay's verb for receiving bytes.* Lives here
   because the reactive cells in #3 need substrate-internal mutation
   from the wire layer.

## The minimum-Record (irreducible)

A `StreamoRecord` is **"a Streamo whose bytes interpret as a signed
chain."** Concretely:

- `valueAddress` override — walks back past trailing SIGs so reads
  land on the most recent COMMIT (or earlier non-SIG). *Without
  this, you have a Streamo that happens to contain SIG chunks but
  treats them as data; you don't have a Record.*
- `#lastSigAddress` — the private walk-back primitive.
- `lastCommit` — derived: decode `valueAddress` as a commit envelope.
  The query that says "this Record is at a commit." (With the 10.2.2
  defensive catch.)
- `committedChainHash` — derived: first 32 bytes of the last SIG.
  The chain-identity primitive.
- `signedLength` — derived: where the chain has been signed to.
- `verify(sig, publicKey)` — turns "I claim to be a signed chain"
  into "I am one." Load-bearing assertion.

Probably also: `get` / `getRefs` (lazy-decodeAt reads through
`lastCommit`), `files`, `history` — these are pure reads built on the
core primitives. They could live in `chain-core.js` or in
`StreamoRecord.js` directly; they don't change the Record's identity.

**Everything else is built on this floor.** Pull author methods, wire
state, and relay-side mechanics away — what's left is the answer to
*"what makes a Record a Record."*

## Slicing plan

```
public/streamo/
├── StreamoRecord.js              "A Streamo whose bytes interpret as a signed chain."
│                                 (~300 lines: valueAddress override, lastCommit,
│                                  committedChainHash, signedLength, verify, get,
│                                  getRefs, files, history; PLUS the reactive
│                                  wire-state cells because they live on `this`)
│
├── WritableStreamoRecord.js      "A StreamoRecord you can author into."
│                                 (~400 lines: extends StreamoRecord; adds
│                                  signer attachment, set, setRefs, checkout,
│                                  commit, merge, update, sign, #scheduleSign,
│                                  defaultMessage)
│
└── relayInboundStream.js         "The factory that turns incoming wire bytes
                                  into trust+append, mutating record state."
                                  (~80 lines: free function
                                  makeRelayInboundStream(record, maxFrameSize))
```

**Why subclass for author, compose for wire:**

- **Subclass author** because it's *type-level* (knowable at
  construction): is this Record something we can write to or only
  read? The explorer holds StreamoRecord; the chat app holds
  WritableStreamoRecord. Different intents, different types.
- **Keep wire state on StreamoRecord** (don't move it to a composed
  RelaySession object) because it's the natural reactive home: apps
  want one place to subscribe to "this Record's pushRejected." The
  flags are about THIS Record's wire context; moving them to a
  separate object means watchers must subscribe to both `(repo, …)`
  and `(session, …)` which is uglier without a clear win.
- **Free function for relayInboundStream** because it's a factory
  that mutates a Record, not a method that defines Record-ness.
  Moving it out shows clearly that the trust+append shape is *what
  the relay does TO a Record,* not part of the Record's identity.

## Migration surface (27 files use the moving pieces)

`grep -l "new StreamoRecord\|extends StreamoRecord\|makeRelayInboundStream"`
returns 27 files. Migration is mostly mechanical:

- **Internal substrate** (registrySync, originSync, outletSync,
  StreamoRecordRegistry, StreamoServer, claudeSync, fileSync,
  archiveSync): factories that need a signer-capable Record import
  `WritableStreamoRecord` instead.
- **Tests** (8 files): tests that exercise write paths instantiate
  `WritableStreamoRecord`; tests that exercise read paths can use
  either.
- **App code** (chat, flashcards, todomvc, explorer): mostly read
  via `session.subscribe(key)` which returns whatever the registry's
  factory produces. If StreamoServer's factory makes Writable for
  the home key + StreamoRecord for subscribed peers, apps see the
  right type by default with no code change.
- **Scripts** (fork-homepage, demo-mounts): one-off; updated as
  needed.

The factory pattern is the migration's leverage point: configure the
registry to produce the right class per key (Writable for the home
key, slim for subscribed peers), and most call sites need no change.

## Sequencing (held for a major bump — 11.0.0)

1. Extract `makeRelayInboundStream` → `relayInboundStream.js` *(no
   API break — preserved as a method that delegates to the free
   function).* This is the cheapest first cut and demonstrates the
   approach. **DONE in this same commit.**
2. Create `WritableStreamoRecord.js`: extends StreamoRecord, lifts
   author methods out. Keep `StreamoRecord` exporting both via
   re-export for a transition window so external callers can migrate
   incrementally.
3. Update internal factories (StreamoServer, StreamoRecordRegistry)
   to produce the right class per key. Internal calls now use
   WritableStreamoRecord where appropriate.
4. Migrate tests + app code. Most files need an import swap and
   nothing else.
5. Remove the transition re-export. `StreamoRecord` is the slim core
   only. Major version bump.

## The minimum-Record discovery as a working principle

The exploration's value isn't the file split per se — it's the
question *"what can we pull off and still have a Record?"* Asking
that question at every layer is the substrate-articulation lens
applied to identity: **the minimum-X is the architecture's
self-definition.** Same shape as the substrate-articulation lens at
one altitude deeper.

For each thing we try to move out, the test is: *"can a use-case
exist that wants a Record without this?"*

| Method/state           | Use-case without it?            | Verdict     |
|------------------------|----------------------------------|-------------|
| `valueAddress` (SIGs)  | No — defines Record-ness         | **CORE**    |
| `lastCommit`           | No — the chain query             | **CORE**    |
| `committedChainHash`   | No — chain identity              | **CORE**    |
| `signedLength`         | No — chain integrity             | **CORE**    |
| `verify`               | No — Record vs. SIG-shaped       | **CORE**    |
| `get` / `getRefs`      | No — reads through `lastCommit`  | **CORE**    |
| `files` / `history`    | Yes (could be helpers, but live close to core) | **CORE-ish** |
| `attachSigner`         | Yes — explorer, mount targets    | **author**  |
| `set` / `setRefs`      | Yes — same                       | **author**  |
| `commit` / `checkout`  | Yes — same                       | **author**  |
| `merge` / `update`     | Yes — same                       | **author**  |
| `sign` / `#scheduleSign` | Yes — same                     | **author**  |
| Wire flags (hasRelay…) | Yes — local-only Records         | **wire-state** (lives on Record for reactivity) |
| `makeRelayInboundStream` | Yes — author processes don't need it as a method | **relay-side** (free function) |

## Open question

Whether `files` and `history` belong in the slim core or as a
"convenience reads" file is a judgment call. They're built on
`lastCommit` and don't add Record-ness, but they're heavily used and
moving them feels like fragmenting for the sake of it. *Leaning
toward: keep in slim core; they're idiomatic queries on the chain,
not bolted-on features.*
