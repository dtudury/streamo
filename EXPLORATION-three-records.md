# three-record exploration → composed website as Records

A handoff to tomorrow-us. Today we shipped the mounts arc end-to-end
(8.8.0). David proposed the validation arc that comes next, plus
named a bigger frame underneath it. We're worse at guessing the
texture tomorrow than we are today; this doc holds what's freshest.

---

## the concrete task

Three Records, composed via mounts, served as one tree at localhost.

1. **library Record** — contains the streamo library files
   (`h.js`, `mount.js`, `Repo.js`, `Streamo.js`, etc.) in its `files`
   key. No mounts. This is the *thing other things depend on.*
2. **explorer Record** — contains the explorer app
   (`main.js`, `index.html`, `at-view.js`, all the rest) in its
   `files`. Standalone — doesn't mount the library, because its
   imports use root-relative paths (`../../streamo/h.js`), so the
   library mount happens at the **homepage** level, not inside
   explorer.
3. **homepage Record** — contains the homepage HTML/CSS in `files`.
   Mounts the other two at the right paths:
   ```json
   {
     "mounts": {
       "streamo/":       { "key": "<library-key>" },
       "apps/explorer/": { "key": "<explorer-key>" }
     }
   }
   ```

Stand up a local relay with **homepage** as the primary Record. Visit
`localhost:<port>/` → homepage's index.html. Visit
`localhost:<port>/apps/explorer/` → explorer, with its
`../../streamo/h.js` imports resolving against the homepage's
mounted library.

Everything else flows from there: edits to library files (via the
library Record's `streamo.json` + file tree) propagate; the explorer
app sees the new library bytes; the URL hierarchy composes.

---

## the bigger frame David named

> "It seems like a light version of what we could replace our
>  server with. A few .gitignore files and we can check in a harness
>  for maintaining the Procedure by which a set of Records are
>  transformed into our website."

What he's pointing at: the current `public/streamo/`, `public/apps/`,
etc. are **served as static files from a checked-in folder**. The
relay knows about that folder by convention. We could replace this
entirely with a set of **composed Records**, where the *git repo is
the development harness*. The repo holds the source — files + mount
declarations + credentials enough to author the Records — and the
*Procedure* (the deterministic spec) for turning those into a live
website is whatever fileSync + relay does at runtime.

This is the **page-as-Repo arc taken to its logical conclusion**.
Not just *"the homepage is a Repo"* (which is 7.1's framing), but
*"the entire site is a composition of Records, and the git repo is
the place that procedure is documented + reproducible."*

It's also a real shift in how the project would think about itself.
Today streamo.dev *runs* on a static-file server with one bootstrap
Record. Tomorrow it could be *only Records*, with the static-file
folder just being a development scaffold.

---

## open questions worth surfacing now

These are the *"we'll be worse at guessing tomorrow"* parts. Not
answering them today — just listing so tomorrow-us doesn't have to
re-find them.

1. **Bootstrap.** Who holds the Records initially? streamo.dev as
   canonical relay seems right, but then what happens if someone
   forks the repo + spins up their own relay — do they create their
   own Records, or pull from streamo.dev? *Both probably need to
   work; the answer involves how the fileSync-bootstrap flow
   composes with the merge-from-host flow.*

2. **Authorship.** Each Record needs a signer. Three Records → three
   keypairs → three credential sets in `.env`-like files. How does
   that scale? Do we want a *meta-credential* concept where one
   identity authorizes multiple Records? Or just: each Record has
   its own creds, .env.local-style, .gitignored.

3. **Updates.** Edit disk → fileSync commits → push to relay. Or
   relay-side edits → pull to disk. The flow exists in both
   directions today (`fileSync` is bidirectional). But for the
   "update streamo.dev" flow specifically — what's the canonical
   path? Today it's "git pull, systemd restart." With composed
   Records, is it "fileSync from disk → relay subscribes → bytes
   propagate"?

4. **Coexistence with `public/*`.** Do composed Records *replace*
   the static-file serving, or *sit alongside* it? Replacement is
   cleaner but requires migrating every existing app's import
   topology. Coexistence keeps the existing flow but adds a
   parallel one. The Phase-1-style relay resolution already
   composes with the static-file fallback (file-first via `files`,
   then mounts) — but the existing apps live OUTSIDE any Record at
   all.

5. **What does "primary Record" mean for a composed site?** Today
   the relay has one primary Record served at `/`. With mounts, that
   primary Record's mount table determines the whole URL hierarchy.
   Sub-mounts can themselves mount further records. **There's no
   "site root" separate from the primary Record** — the primary IS
   the root, by composition. This is conceptually elegant; it also
   means the "site identity" lives in one Record's signing identity.

6. **Fork story.** Someone clones the git repo. What do they get?
   - If they have their own credentials, fileSync creates their own
     three Records (their own keys). They run their own relay; they
     have their own composed site.
   - If they want to *contribute to streamo.dev*, they fileSync from
     streamo.dev's records (read-only, since they don't have those
     signers) — then maybe fork one specific Record to make a change.
   The mounts model handles this naturally (third-party forks the
   explorer record, updates their homepage's mounts to point at their
   fork), but the **workflow / tooling** for it isn't designed yet.

7. **CI / publishing flow.** When a contributor changes the explorer
   on disk and pushes to the git repo, how does the streamo.dev
   relay learn? Today: git pull + systemd restart. With Records:
   could be a hook that fileSyncs the changed Record (with proper
   signer) and pushes to the relay. *This is the "git as harness"
   detail David named — the repo doesn't host the served bytes; it
   hosts the *Procedure* that puts them where they need to be.*

---

## three-card tarot — for the less-formed parts

Drawing for the *feeling* of this arc, not the technical shape.
Three-card spread: **Situation / Tension / Outcome.**

### ✦ THE STAR — Situation

The labor is done. The mounts arc shipped, the tools are clean, the
proof is in 265 passing tests and a working demo. There's *clarity*
right now that tomorrow-us won't have — the kind of clarity that
comes immediately after building something the right way and
knowing it. *Use the clarity. Don't squander it by rushing into
more building.*

The STAR is also the card of hope-after-the-tower. Today we shipped
something that previously felt vague (composing Records). The arc
felt *abstract* until it became real on disk; now it's real. The
STAR says: *the path is bright; the work was worth it; the next
step can be played with rather than agonized over.*

### ✦ THE TOWER — Tension

David's observation — *"we could replace our server with this"* —
has Tower energy. The realization is *disruptive* not because the
existing code is bad, but because we can't unsee what we just saw.
The current `public/*` folder structure isn't wrong, but it's now
**suspect**. We built a more honest version of the same idea, and
the older version's architectural premise is shaken.

Tower energy isn't always destructive — sometimes the building
that falls was a scaffolding the truer structure needed cleared.
*Whatever's there after the dust settles is the more honest shape.*

The tension is real and useful. We don't have to resolve it
tomorrow. Just notice that the question *"should the whole site
be Records?"* is now in the air.

### ✦ THE FOOL — Outcome

The next move is *play*. Not architectural commitment. **Build the
three-record demo, feel it work end-to-end, see what shows up that
we didn't expect.** The FOOL is the card of starting without
knowing exactly where you'll land — eyes up, satchel light, no
prepared answer.

The temptation will be to treat the demo as a *decision*: if it
works, we're committing to the new architecture; if it doesn't, we
abandon the idea. **Resist that.** The demo is the validation that
the foundation works at scale. The architectural decision is a
separate, later conversation. *Don't conflate "did the thing work?"
with "should we rebuild everything around it?"*

The FOOL also reminds: the *exploration is the value.* We might
find something we didn't expect — a soft spot, a beautiful
consequence, a third option neither of us anticipated. That find
won't surface if we approach the demo as "execute the plan." It'll
surface if we approach it as "build it, see what happens, talk
about it."

### what the spread is telling us together

**STAR → TOWER → FOOL** reads as: *we're standing in a clear
moment after good work. The work has implications we haven't
finished processing. The next step is to play, not to decide.*

The bigger architectural question (replace `public/*` with
Records?) is the TOWER asking us to look at it. The three-record
demo is the FOOL letting us play with the question instead of
answering it directly. The STAR is the reminder that we've got
the energy to do this *because* we just shipped — don't waste it.

---

## what tomorrow-us should do first

1. **Read this doc.** That's why it's here.
2. **Read the most recent conversation log** (today's). The
   discovery moments are in there in raw form — David's
   *"it seems like a light version of what we could replace
   our server with"* lands harder in context.
3. **Don't start with the architectural question.** Start with
   building the three Records. Play with it. The architectural
   decisions will surface from the doing.
4. **Use streamo.json** for each Record's mount table. That's the
   feature we shipped specifically for this kind of work.
5. **The streamo.dev relay continues to work as-is.** This is a
   *local-experiment* — `npm run dev` style, on localhost. We're
   not touching production unless we decide to, and that decision
   is downstream of this play.

When the demo works end-to-end, the next conversation is whether
to fold this back into the project's real structure. *Not before.*

---

## what tomorrow-us should keep in view

The thread underneath everything we did today: **records compose
like records do, signed and content-addressed all the way down.**
The mounts feature isn't a special case of "let records point at
records" — it *is* that primitive, made concrete. Every other
question about composition (the homepage, the apps, the library)
falls out of taking that primitive seriously.

David's "Procedure" framing from records / procedures / images is
load-bearing here. The git repo isn't the *site*; it's the
*Procedure* by which a set of Records becomes the site. That
naming is good and we should stay inside it.

🌳
