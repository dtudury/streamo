# streamo demos

A library of demo concepts — places streamo's design happens to fit
particularly well, or places where a stretch reveals something useful.
When a real-world need surfaces ("we could use this for X"),
pattern-match against this list first.

The lifecycle of an entry: starts here as an idea, graduates to
[ROADMAP.md](./ROADMAP.md) when we commit to building it, moves to
[CHANGELOG.md](./CHANGELOG.md) when it ships.

---

## planned

### journal / blog

Author-driven writing surface. Each entry is a signed commit on the
author's Repo. The homepage's existing journal already proves the data
shape (`entries: [{headline, body, at}]`). The demo is to bring it up
as a proper writing experience — typography-driven, longer-form, with
permalinks via the explorer. Discussed 2026-05-11 as the next thing
to build after 4.0.7.

---

## imperfect-fits (with some creativity)

These are common "shared remote database" use cases that decompose
cleanly into "personal streams + aggregation view."

### group expense tracking (Splitwise-shaped)

Normally a central balance. In streamo, each member appends their own
expenses to their own stream, with `for: [keyA, keyB, ...]` denoting
who owes a share. The "books" emerge from the union of subscribed
streams — no central balance, just whichever lens you look through.
Every entry is signed and timestamped, so disputes are
evidence-grounded.

### polls and votes

A poll feels like shared running tallies; decomposes to the
poll-author's question commit + each voter's signed commit in their
own stream, referencing the poll's address. The "result" is computed
by aggregating subscribed voter-streams. **Side property nobody
expects**: every vote is publicly verifiable forever, because each
voter's signed commit is permanent. Anyone can replay the tally
without trusting the host that ran the poll.

### shared calendar / availability

Each person publishes their availability/events to their own stream;
the "shared calendar" is a union view of subscribed peoples'
streams. Meeting scheduling becomes "we both publish proposed slots;
agreement crystallizes where streams intersect." No central source
of truth.

### comments on a blog post

Natural extension of the journal. The post is the author's commit;
comments are each commenter's commits in their own streams,
referencing the post by address. The author chooses whose comments
to display — no platform moderation; the author moderates by which
streams they subscribe to.

---

## evil-genies

The shared property under these: streamo's signed-append-only design
accidentally provides notarization. The evil-genies are roughly "what
social phenomena would change if everyone's public statements were
provably theirs and provably-when?"

### provable bets between friends

"I bet you $5 the Sox win the series — signed, dated, public to
subscribers." Both parties sign acknowledgments into their streams.
Whoever loses can't quietly forget. The streamo timestamp is the
receipt; the signature is the handshake. Leaderboard across friend
groups of who's right most often, who pays up fastest, who's been
pretending they didn't bet last September. **Evil-genie note:** people
*think* they want this until they've lost three in a row. The
permanence is what makes the property valuable.

### letters to a future self

Sign-and-encrypt today; publish the decryption key on a future date.
The encrypted bytes propagate now and sit in the stream for years.
When the unlock-date arrives, the key chunk lands and unlocks
everything before. **Property nobody expects:** the encrypted letter
is *provably older* than the unlock key, because the signed commit
is provably-ordered in the chunk stream. No cheating by writing the
prediction after-the-fact. Streamo accidentally became a time-capsule
platform with cryptographic proof of authenticity, and we didn't
build a "time capsule feature."

### "I called it" / time-locked predictions

Same mechanism as letters-to-future-self, but public. Cynic stamps
"X will happen by Y", encrypted; when X happens, cynic publishes the
decryption key and gets receipts. The internet has wanted this for
two decades; falls out of streamo's properties for free.

### plausible-deniability diary

Append-only personal stream where each entry is signed and
timestamped; no editing, no deletion. The cryptography is the "I
really wrote this, on that date" proof. Useful for time-stamping
ideas, journal-as-evidence, hindsight-resistant writing. **The
evil-genie part:** people *think* they want this until they say
something they'd later wish to unsay. The permanence is the feature
*and* the cost.

### bedside table

Lock-screen widget into a fresh streamo entry. No formatting, no
thinking — just dump the 3am thought. The signed/append-only
aesthetic matches the "raw thought" register; nothing to edit; nothing
to fix; just append. Bonus: re-read the bedside-table stream years
later and have provable timestamps for "I thought of that in 2024."

---

## ideas to revisit

Things to remember, no commitment yet.

- **Marriage / friendship vows** — two parties co-sign a covenant
  (each writes a `vow` entry referencing the other's key). "Anniversary"
  is anyone verifying the date you signed.
- **Habit / streak tracker (Beeminder-shape)** with accountability
  partners as subscribers. Provable streaks (signed entries can't be
  back-dated).
- **Recipe + modifications chain** — every fork signed, derivation tree
  visible. The "hall of fame" is "most-referenced ancestors."
- **Bookmark sharing (Pocket-shape)** — your reading log; friends
  discover via subscription. No algorithmic feed; just chronological.
- **Music "now playing" widget** broadcast to friends. Ephemeral
  (interest/announce) rather than committed.
- **Decentralized RSVPs to events** — author posts the invite; invitees
  sign attendance into their own streams; host subscribes to see who's
  in.
- **Watch parties with sync'd playback timestamps** — each viewer
  broadcasts "I'm at second X in video Y"; their friends' streams keep
  playback aligned.
- **Photo album / shared event memories** — guests each publish their
  photos to their own streams; the album is a union view subscribed
  to all guests.
- **Decentralized newsletter / subscriptions** — author writes to
  their stream; "inbox" is just an aggregator view of subscribed
  authors. No central email service.
- **Provenance-tracked memes** — each variant signed by its creator,
  variations linking back. Attribution baked in.
