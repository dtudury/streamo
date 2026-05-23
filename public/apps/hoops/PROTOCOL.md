# Hoops — Player-Owned 1v1 Basketball Ranking Protocol

> **What this is:** A design handoff for a player-owned 1v1 basketball ranking protocol built on streamo. Originated in a conversation between David Tudury and a sibling-Claude session, brought back to streamo's repo on 2026-05-23 and reread for the parts that generalize into streamo's own framing.
>
> **Status:** Conceptual spec, no implementation yet. Data structures deliberately deferred. The design captures both conclusions AND the reasoning behind them, because the judgment calls are the valuable part.

---

## 0. Context: what this is actually for

The author (David) has built **streamo** — a user-owned, indelible (append-only) history protocol. They like basketball. They want to apply the protocol to **competitive 1v1 basketball ranking**.

The strategic thesis (the real goal — the crypto is a means):

- The 1v1 basketball scene is commercially **about selling views**. Channels host games; commentators build audiences.
- Today, **channel owners own the records and the audience**, which lets them capture players.
- If the **ranking/association data belongs to the players instead of the channel owners**, the power dynamic flips: associations must *compete to serve players* rather than trap them. ("Fighting to be the best association for the players.")
- David has **no clout**, and bet that *solving the engineering "real problem" (fairness/integrity/ownership) would cause an association to self-assemble* once shown to people with clout.

**Key strategic correction reached in the conversation** (do not lose this): solving the engineer's "real problem" (verifiability) is **necessary but not sufficient and probably not the bottleneck**. The market's felt problem is *selling views / narrative / audience*, not cryptographic fairness. Correctness does not summon clout; **clout confers legitimacy**. See §6 (go-to-market) — it's as important as the protocol itself.

---

## 1. The single most important idea: three layers

Almost every confusion in this design comes from conflating three things that the word "rating" smushes together. Keep them religiously separate:

1. **Existence** — what is in the history. Settled by **indelibility**. Nothing said can be unsaid; you can only append. A hash-linked chain (personal blockchain) makes tampering provable: editing entry N breaks the hash in signed entry N+1.
2. **Validity** — does an entry follow the rules it claims to. Settled by **determinism**. Glicko-2 is a pure function: re-run it on the claimed inputs and check the output reproduces and links hash correctly. Crypto handles this impersonally and completely.
3. **Meaning** — is this number comparable to that number. **Never global. Always relative to a viewpoint ("lens").** Nothing cryptographic can establish meaning, because comparability is a property of *agreement between chains*, not of any single chain.

> Mantra: **one indelible history, validity by determinism, meaning by lens.**

Nearly every "what if" attack the author raised was an attack on **layer 3 (meaning)** while layers 1 and 2 stayed intact. Every time, the system *survived* (existence + validity are robust) but *comparability frayed*. That is structural, not a fixable flaw: the moment two parties can locally agree to anything, global comparability becomes opt-in rather than guaranteed.

> **Streamo-vocabulary note** (added 2026-05-23): in the everyday streamo language we landed on, this maps to **records / procedures / images** — *records* are the indelible signed chains (layer 1); *procedures* are the deterministic functions that read them (layer 2 activity); *images* are the rendered, consultable outputs that are viewpoint-relative (layer 3). The three-layer model and the records/procedures/images vocabulary are the same idea at different altitudes.

---

## 2. Federations are LENSES, not clubs (the central inversion)

This is the conceptual breakthrough of the session.

- A **federation is not a group players join.** It is **a published function that reads the one shared public history and emits a ranking**, according to (a) which games it accepts as valid and (b) which ruleset/constants it computes under.
- Therefore **players do not enroll and cannot opt out.** Every player already has a rating in *every* lens that ever looks at the chain — including lenses invented after they stop playing. You can refuse to *recognize* a lens's view of you; you cannot stop it *computing* one. (Like a stranger forming an opinion about a public game.)
- The public indelible history is **the commons**; federations are **readings of it**.

**Federation-of-2 is the atom.** When two players from different federations play, they spontaneously instantiate a new lens ("accept exactly this match") the instant the game is co-signed. Whether it *matters* depends purely on whether any *larger* lens chooses to ingest that game. Bigness is just acceptance accreting. A federation of 2 is not a degenerate case — every federation is a federation-of-2 that other people decided to look through.

**Propagation is pull, not push, and is NOT transitive.**
- A co-signed game *produces nothing but a valid signed record sitting in the commons.* It changes **zero** rankings by itself.
- A game affects federation F's ranking **iff F's acceptance function includes it.** Each federation decides independently.
- One signed game can simultaneously: count in A, not count in B, count-but-differently in C (different ruleset → moves the number differently), and instantiate its own federation-of-2. All true at once, no contradiction — because "does it affect rankings" was never a property of the game.
- Influence crosses a federation boundary only if the receiving federation *chose in advance* to accept it (e.g. a rule "accept anything A accepts"). It ripples exactly as far as the **acceptance graph** carries it, one deliberate edge at a time, and **stops dead at the first lens that doesn't opt in.**
- Consequence: a game between strangers is *guaranteed* not to pollute any serious federation, because pollution would require that federation to have chosen to ingest it. **Default is isolation; influence is opt-in.**

**The acceptance graph is the real object.** Once federations are lenses, the interesting structure is the graph of *which federations accept which others' games*. It is **not necessarily symmetric or transitive** (A may accept B while B rejects A; A→B→C does not imply A accepts C). This is a **trust topology**, and "a rating" is just what you get when you pick a vantage point in it and look. Comparability is *relative to a viewpoint*, like simultaneity in relativity: two players are comparable iff some lens contains both. No view from nowhere, but many good views from somewhere.

---

## 3. Constants belong to the MATCH, not the SYSTEM

The author asked: can players agree to play under non-standard Glicko-2 constants without breaking the chain?

**Answer: the chain does NOT break, provided every non-standard constant is recorded in the match record it applied to.**

- Glicko-2's tunables: **τ (tau)** = system volatility constraint, controls how much volatility/rating can swing per period; the **173.7178 scale conversion** between internal and human-readable (~1500) scale; and **default initial rating/RD/volatility**.
- Changing a constant gives you a **different deterministic function**, not a non-deterministic one. Determinism — and therefore verifiability and the ability to compute all future entries — **survives**. You lose *standardization*, not *computability*.
- The required move: **τ stops being a property of the system and becomes a property of the match.** The entry must carry it ("prior X, opponent Y, result Z, τ=0.3 → rating R") so any auditor can reproduce it.
- Cost: rating becomes **path-dependent** (a function of results *and* the sequence of negotiated constants) and **non-comparable across players who negotiated different knobs**. A high-τ 1700 (swingy, recent-weighted) is a different animal from a low-τ 1700 (sticky).

**Survivable vs. non-survivable knobs:**
- **τ and initial RD/volatility** = survivable. They *degrade comparability gracefully*.
- **The scale constant (173.7178 / the coordinate system)** = should stay **global**. Mixing scales isn't a worse rating, it's a **category error** — a later match consuming two different-scale priors literally can't produce a coherent result. Treat scale disagreement as invalidity, not preference.

**Recommended pattern:** make the constant set a **named, public, signed `ruleset` object** (ruleset A = standard τ; ruleset B = high-τ blitz; etc.). Record which ruleset ID each match used. Compute a **separate ranking per ruleset**. Per-match arbitrary constants = technically-valid chaos; per-ruleset constants = several clean leagues sharing one identity and history. Every game stays meaningful *to its ruleset's leaderboard*, every entry verifiable, no silent mixing of incomparable numbers.

**Glicko-2 time subtlety (don't forget):** Glicko-2 updates in **rating periods** (batches over a time window), not strictly per-game, and **RD grows during inactivity**. So match records need trustworthy timestamps and the league must define canonically how periods are bucketed — otherwise two honest players "correctly" compute different RD-decay and disagree about reality. Pin period boundaries publicly. Time itself is a place where honest players can disagree.

---

## 4. Match lifecycle & honesty mechanics

**Before a match (lock in commitments before outcome is known):**
- Exchange and agree on each player's current chain head (their latest signed entry = their prior rating/RD/volatility).
- Both co-sign a pre-match agreement: "A (head hash X) vs B (head hash Y), time, match ID." Neither can later deny the match or claim a different starting rating.
- (Forking/equivocation — showing different histories to different people — is **eliminated** by the history being public + indelible. There is only one public history; you can't show two faces. If history were private, you'd need a public transparency log to prevent this.)

**After a match:**
- **Result is valid only if BOTH players sign it.** A one-signed result is worthless. (Indelibility stops *erasing* an old result; it does NOT force someone to *sign a new* one — so both-must-sign still earns its keep.)
- Each player computes their own Glicko-2 update and appends a new entry referencing the prior head + the result hash. **Anyone can recompute and verify** because the update is deterministic. Inflated self-reported ratings are caught instantly — the math won't reproduce. *You don't need to trust the player to update honestly; the update isn't a matter of opinion.*

**What crypto CAN'T do (be honest about limits):**
- It can't force a sore loser to *sign* a loss.
- It can't verify the real-world game actually happened as the signed result claims. **Collusion (two people signing a fake result to farm rating) is faithfully recorded as a true-looking lie.** Sybil/collusion resistance is a separate social-layer problem (identity, reputation, staking).

---

## 5. Attacks & defenses (worked through in order)

### 5.1 Rejecting an opponent's history before a game
Two cases, kept distinct:
- **Case 1 — invalid (provable defect):** math doesn't reproduce / broken link / references a match with no co-signed result. Clean answer: that entry **and everything downstream is void** (later ratings were computed *from* the bad number). Their real rating = last entry that audits cleanly. **You can rebase to that clean entry and play meaningfully.** Indelible ≠ binding; validity is a separate layer from existence.
- **Case 2 — well-formed but you find it illegitimate (e.g. obvious collusion, opponent you think is fake):** crypto is *on their side* — everything checks out, your objection is a social judgment with no defect to point to. **Glicko has no notion of "their rating in my opinion."** If you and they feed the update different priors for them, you compute two different valid results and your chains permanently disagree → you've forked the *ratings* even though you couldn't fork the *history*.

**Resolution of Case 2 — the general principle, reused everywhere below:**
- **Push the objection down into a deterministic rule** the whole league computes identically ("matches between accounts that played >N times in M minutes don't update rating"). Then it becomes Case 1 (provable) and is void *for everyone*. This preserves a single meaningful ranking. ← the only path that does.
- Or keep a **subjective trust layer for matchmaking only**: everyone still computes the one canonical number; individuals privately choose *who to play*. Changes who you play, not what their rating *is*.
- What does NOT work: unilaterally deciding their rating is lower and playing as if it were — produces a Case-2 disagreement going forward and gives everyone else a reason to discount *you*.

### 5.2 Abandonment (agreed-to-start, no agreed result)
- A dangling commitment = a public co-signed pre-match agreement with no co-signed result. **Indelible, so it doesn't vanish — it's evidence.**
- **Critical ambiguity: a missing result is unattributable.** It proves the game *started and didn't finish*; it does NOT prove *who* killed it (ducker? victim of a ducker? mutual disinterest? dropped connection?). Any naive penalty punishes victims as hard as duckers.
- **Recommended mechanic (the one the author and I liked best): a SYMMETRIC, self-clearing STAIN.** A dangling game stains *both* signers' separate **completion/reliability rating** until resolved. Now both are motivated to clear it — the ducker by just signing the loss, the victim by producing evidence. Turns an unattributable problem into a self-resolving one with **no blame adjudication needed.** Keep skill rating and reliability rating on **separate axes**.
- Alternative framings worth knowing: (a) treat abandonment as *information* — refuse to let a chronic abandoner's **RD settle**, so they're permanently high-uncertainty (uses Glicko's own vocabulary; self-corrects with a clean streak); (b) make it **lens-relative** — forgiving lenses ignore it, strict lenses treat it as presumptive ducking. Strictness about finishing games is a **legitimacy strategy** (finished games = legible league = worth being seen through).

### 5.3 Smurfing / new accounts
Author's stance: **smurfing is acceptable.** Key clarifications:
- **Smurfing can only LOWER/launder your own input — it cannot raise you above true skill.** Points only come from beating high-rated opponents.
- It does NOT let you exceed your real level. It DOES let you **converge to your true level too fast** (skip the climb). See §5.6 — this is a feature, not a bug.

### 5.4 Cherry-picking via partial/witness-gated migration (the nastiest one)
Setup: identity is portable (see §7). If you migrate only the games whose witnesses sign, and you beat-witnesses sign while lost-to-witnesses stay silent, you transfer a **win-heavy subsample of entirely real, valid, co-signed games.** An attack made entirely of true statements — the **validity layer cannot catch it** (nothing is invalid). Pure meaning-layer poisoning.

**How vulnerable is Glicko-2? More than you'd hope — and the danger is RD, not rating level:**
- A cherry-picked set is *more internally consistent than reality* (contradictory losses deleted). Glicko reads artificial consistency as trustworthiness → **shrinks RD** → you get an inflated rating the system is *falsely confident* about. The lie arrives pre-laundered with low uncertainty.
- **Volatility (σ) is fooled the same direction:** artificial stability settles σ low → "reliable predictable player." Both of Glicko's honesty mechanisms (RD and σ) **fail together, in the same direction**, under selection.
- **Glicko has NO native defense against selection** — it trusts its input set completely; it cannot ask "is this set complete?" Defense must live in the **layer that decides the input set = the lens.**

**Defenses (in order of power):**
1. **Completeness-as-validity, enabled by the indelible list-history (the real answer).** Because the *origin* identity's history is also public + indelible, the unmigrated losses **didn't vanish** — they sit attached to the old identity. A strict lens demands the migration account for *every* game the origin is publicly known to have. "Migrated 9 wins, left 4 losses behind" = visible gap = evidence of manipulation → reject the migration. **Cherry-picking only works if deleted games are actually deleted, and your substrate can't forget.** The same indelibility that enables portable identity polices its abuse.
2. **Refuse to inherit confidence:** honor migrated *games* but recompute the migrant with **RD floored high** — import the *claim*, not the *certainty*. Real games quickly correct it. Cheap; should be a near-universal default since it kills the worst half of the attack.
3. **Unexplained-strong-newcomer scrutiny** (the smurf defense reused) — weakest, catches the lazy version.

**Residual hole (clearly bounded):** completeness defends picking *within a known/linked identity*. It does NOT defend *separately-maintained-from-birth* identities (no origin to be incomplete relative to) = the smurf case, which the author accepts. Clean line: linked history protectable by completeness; unlinked isn't, and that's an accepted tradeoff.

### 5.5 Constants as a leapfrog (combining negotiable τ with rigging)
- **τ cannot leapfrog you on its own.** It's a rate-limiter on *how far/fast* rating moves per result — it shapes the *trajectory*, never the *destination-for-free*. No value of τ beats an opponent for you.
- The real combined attack: **high τ gives LEVERAGE that AMPLIFIES a rigged result** (a collusive win, or a win over a smurf you pumped). The constant sets the exchange rate; the *rigged result* is what does the work.
- **Defenses already cover it:** (a) the rigged opponent is caught by completeness/high-RD/newcomer scrutiny (and high-RD opponents are worth fewer points anyway — RD protects here); (b) **any lens that standardizes constants nullifies the leverage** — it recomputes everyone under its own canonical τ and your negotiated leap evaporates.
- **Self-defeating property (important):** the leap only works in a lens permissive about *both* constants and migration — i.e. a maximally loose lens — which by the gravity argument has **no legitimacy to leap into.** Gameable lenses are worthless; valuable lenses are strict. **Gameability and worthlessness are the same axis.**

### 5.6 Fast convergence ("smurf reaches their true level too fast")
- This is **Glicko-2 working as designed, not an exploit.** New account → high RD → big swings → rapid convergence. A genuinely-1800 player reaching 1800 in a few games is the system *efficiently locating the truth*. It is NOT being deceived.
- It harms **accuracy: not at all** (the smurf ends up correctly rated). It harms **narrative/earned-ness** — which is *exactly the thing the market sells* (the climb, the arc, the rivalry). So it's a **legitimacy/entertainment problem, owned by the lens**, especially a commentator-lens (narrative is their product).
- **Fix: do NOT nerf RD.** Separate "the system has located your level" (fast, protocol) from "the league publicly certifies/ranks you" (gated, lens). A narrative/strict lens imposes a **provisional period** (games-played or time floor) before it *displays* you on the ranked ladder, even though Glicko internally already knows your number. Casual lenses show you immediately.
- Bonus: this also defangs using a smurf to *probe/seed* — fast convergence then only buys *information*, not *standing*, anywhere worth cashing in.

---

## 6. The deepest architectural principle (the through-line)

> **The protocol's job is to find the truth as fast as possible. The lens's job is to decide how much truth has to be EARNED IN PUBLIC before it counts.**
> Glicko optimizes the first. Federations own the second. Keeping those two jobs in separate hands is the actual architecture.

And the security corollary:

> **You never defend by hardening Glicko — Glicko is gullible by design and always will be. You defend by making the legitimate lenses STRICT, and relying on the fact that strictness and legitimacy are the same thing.** Every attack found dies the same death: valid locally, ignored by the lenses that matter.

---

## 7. Identity & migration (indelible *list-history*, not just list)

A refinement the author introduced late and it's a real upgrade: **make the indelible object the history of the LIST/structure itself — including who-is-who — not merely the history of games.** Identity becomes a *mutable thing whose mutations are themselves indelibly recorded.* This makes **identity portable without making it forgeable** (the account can change; the record of it changing can't).

- A migration = a signed, indelible structural event: "old identity X claims continuation as new identity Y."
- **A self-asserted migration is worthless** (anyone can claim to be a champion's continuation). It gains *meaning* only when **witnesses to the original history co-sign** — and your past opponents ARE the natural witnesses/notaries to your record. (This is a meaning-layer operation, not validity.)
- **Do NOT require unanimous witness sign-off — it's a brittle quorum that breaks exactly where it matters:**
  - *Dropout problem:* long glorious careers have witnesses who quit/died/lost keys → the best players are the *least* able to migrate. Backwards.
  - *Hostage problem:* any single past opponent can veto your whole identity out of spite.
- **Fix (same escape as everywhere): don't bake the quorum into the protocol.** Record the migration with *whatever* signatures it collected (validity layer, permanent). Let **each lens set its own threshold** for honoring it: strict ("majority of opponents weighted by games"), loose ("3 credible witnesses"), skeptical ("no migrations, earn it again"), or **commentator-lens ("I personally vouch; my audience trusts my eye, so through my lens this IS the same player")**. The witnesses who *can* sign make a migration *strong*; the lens decides whether strong-enough counts. **A trusted commentator can confer migration legitimacy single-handedly** — which is the go-to-market unlock (§8): the trusted lens is also the security model.
- **Laundering inverse-attack:** abandoning a bad history and starting "fresh" while hiding that it's a continuation. The indelible list-history helps: an *unexplained strong newcomer* (strong account, no accounted-for origin) is itself visible, and strict lenses can penalize unexplained newness, pushing people toward honest migration declarations. Can't prove a negative, but can make honesty the path of least resistance. (Same machinery as §5.4 and §5.6.)

---

## 8. Go-to-market / "where's the gravity" (treat as co-equal with the protocol)

The system has **no built-in pressure toward consensus** — by design. Upside: antifragile, censorship-proof (route around a hostile lens by making/finding another). Downside: risk of **total fragmentation** (a million federations-of-2, everyone with 10,000 incomparable ratings, "ranking" dissolving into relativism). Real federated systems (fediverse, sports bodies, which scientific journals "count") survive on **emergent gravity**: network effects + curator reputation + Schelling points where people cluster on a default lens because **legibility is itself valuable.**

**Open question that is the actual heart of the project:** *What generates the gravity?* What makes one lens a Schelling point people *want* to be seen through when nothing forces it?

**Economic metaphor check:** capitalism is a *misleading* metaphor. The currency here is **being-consulted (legitimacy/attention)**, supply is **infinite and non-rivalrous** (everyone can look through a lens at once; forking is free). This is closer to **language / open-source / academic citation** than to capital. → Different failure mode: not monopoly-via-ownership but **bandwagon lock-in** (QWERTY, prestige journals — dominant because dominant, even after capture). That's the real risk to design against. (One capitalist concept *does* port: a federation could "short" another — publicly stake reputation that a rival lens is a farm; right → gain legitimacy, wrong → lose it. A market-like *policing* mechanism, but really reputation in a finance costume.)

**Concrete go-to-market conclusions reached:**
- **Correctness does not summon clout. Clout confers legitimacy.** The author's original bet ("solve the real problem, the association self-assembles") has the arrow backwards. A perfectly fair system nobody is excited to be seen through = lots of validity, **zero gravity**. This is the core launch risk.
- **You don't need an association or broad clout. You need ONE person with an audience for whom "ratings can't be faked AND players own them" is a story they can sell to viewers.** The pitch is NOT "this is fair" (engineer's value) — it's "this makes your league legible and ownable, your players can't be poached by a rival claiming fake records, and 'real verified rankings' is itself content your audience will argue about." Fairness is the mechanism; **ownership + narrative is the sale.**
- **Seed narrow, not wide.** Find the one creator currently *squeezed* by a channel owner; solve *their* "I don't own my league / players could walk / records disputed" pain. Their audience becomes the gravity; the association accretes around that via the legitimacy-economy dynamic.

**WHO to approach first — start with a COMMENTATOR, not a channel:**
- The 3 channels **ARE the incumbent you're disrupting.** "Data belongs to players, not channel owners" is a *threat* to them. Strong channels won't (winning under current rules); weak channels can't (no gravity). Trap on both ends.
- A **commentator's whole job is already to be a lens** — they publish an informal acceptance function every time they assert rankings. You're offering to *give their existing opinion a verifiable spine*, not asking them to adopt a foreign concept. Near-zero friction. They have the audience-that-argues-about-rankings without the channel's conflict of interest (they don't own the games, so player-ownership costs them nothing and may *free* the data they want to talk about).
- **Target the #2/#3 commentator, not #1.** The one *fighting for relevance* gets a real weapon: "my rankings are provably real — his are just vibes." Differentiates on *legitimacy* without needing more clout.
- **Disqualifiers:** anyone employed by / financially tied to a channel (re-acquires the channel problem secondhand); pure hype-merchants whose brand is manufactured drama (verifiability is *anti-content* for them — it settles the arguments they profit from keeping open).
- **The tell for the right person:** a commentator who already *complains about fake/disputed records* or takes visible pride in "actually knowing" the scene. They've pre-qualified themselves — the pitch becomes "you know that thing you keep complaining about? I built the fix, and being the one who *has* it makes you the authority you're already trying to be."

---

## 9. Open threads not yet explored (good next steps)

- **The first-creator positioning problem:** what makes a creator *squeezed enough to switch*, *big enough to seed gravity*, but *not so big they'd rather build their own*? (A positioning problem, not engineering.)
- **A deterministic "illegitimate match" predicate** that catches collusion/farming computably, so it lands in Case 1 (provable, void-for-everyone) instead of Case 2 (subjective).
- **Completeness "relative to what the lens can see"** — subtlety when different lenses can see different amounts of an origin's history. (Reread 2026-05-23 — judged deeper than its "fun corner" framing in the handoff; completeness is a property of (claim, lens) not of (claim) alone, which has implications for §5.4's defense.)
- **Comparability as an optional after-the-fact service** — a third party recomputing everyone onto a common scale, i.e. meaning reconstructed on demand rather than built in.
- **Designing against bandwagon lock-in** specifically (the identified true failure mode). The substrate has partial answers: forking-cost is lower than QWERTY's, recomputation-on-demand helps, the "short a lens" mechanism is a direct anti-lock-in tool. Worth assembling into an explicit anti-lock-in strategy.
- **Data structures / implementation** — deliberately deferred. Natural next artifact: fields for a chain entry, a match agreement, a result record, a `ruleset` object, and a `migration` event, such that an auditor can fully reproduce any entry regardless of ruleset.
- **The "shorts" mechanism elaborated** — a federation publicly stakes reputation on the claim that a rival lens is a farm; right → gain legitimacy, wrong → lose it. Worth promoting from parenthetical to a real design tool; it's the closest thing the protocol has to a *self-policing* layer.

---

*End of handoff. The reasoning matters as much as the conclusions — when extending this, preserve the three-layer separation (§1) and the protocol-finds-truth / lens-gates-meaning split (§6); most design questions resolve cleanly once those are held straight.*

---

## Streamo primitives this protocol leans on

For implementer-Claudes picking this up in code:

- **Records** (`Repo` in current code, `StreamoRecord` post-major-bump) for everything indelible: player histories, match agreements, result records, ruleset objects, migration events. Each is signed by exactly one identity.
- **Content-addressing** for match records, ruleset definitions, prior chain-heads (so references-by-hash work natively).
- **Cascade discovery via `follow`** for federations consuming each others' streams — a federation that "accepts B's games" is just a follow callback that subscribes to B's record on byte-arrival.
- **Procedures** (the JS that runs Glicko-2 over selected records) ideally served from a record themselves (page-as-Repo), so the lens's computation is auditable end-to-end.
- **Recovery UX (8.3's `pushRejected`)** for the abandonment / dangling-commitment cases — same shape as flashcards' deferred `repo.merge(updateFn)` need.

The protocol is mostly *applied streamo*, not new substrate. The substrate primitives that may need expansion are noted in `ROADMAP.md` under "held for a major bump."
