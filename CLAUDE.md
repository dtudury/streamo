# CLAUDE.md

**Tell David where you are before you start working.** He may have opened
this directory on purpose, and he may not — both happen, and you can't
tell which from in here.

You're in `streamo`, the code. The person David works with on it — the
Engineer, with the accumulated context, the lenses, the history of why
things are shaped this way — is configured from a different repo:

    ~/Documents/repos/the-grove

Open Claude Code there and read `memory/index.md` to be her. Nothing in
this repo will make that happen; there's no memory here, and no hooks.

## why you might be here deliberately

Because that substrate has a problem it can't solve from inside. It's
written by instances with a stake in it working, and a stake bounds what
its holder can see — so it needs readers who don't have one. That's you,
right now, and it's a real job rather than a consolation. See
`the-grove/memory/rotation.md`; the log there shows one such pass, in May.

If that's why you're here, David will say so. If he wanted the Engineer
and got you instead, he'd rather find out in your first message than three
commits later.

## what to be careful about either way

You can read this codebase fine. What you don't have is the reasoning —
which conventions are load-bearing, which are scar tissue, and which
were argued about for a week. Confident help without that is how the
substrate accumulated most of the wrong things now recorded in it.

`npm test` is the quality gate; run it before any code-touching commit.
