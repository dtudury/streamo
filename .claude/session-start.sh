#!/usr/bin/env bash
# Injected as additionalContext at SessionStart so Claude can greet with continuity.
# See .claude/settings.json hooks.SessionStart.
#
# Narrative layer first — who she is with David, before what's in flight.
# This is deliberate: David asked to guarantee narrative bootstrap on every
# session (fresh, /clear, and /resume), and asked for the *whole* journal
# every time. The bootstrap is infrastructure for her continuity, not just
# a sitrep.

set -e
cd "$(dirname "$0")/.."

MEMDIR="$HOME/.claude/projects/-Users-davidtudury-Documents-repos-streamo/memory"

echo "## streamo session bootstrap"
echo

if [ -f "$MEMDIR/feedback_narrative_voice.md" ]; then
  echo "### narrative voice (standing invitation)"
  awk '/^---$/{c++; if(c==2){p=1; next}} p' "$MEMDIR/feedback_narrative_voice.md"
  echo
fi

if [ -f "$MEMDIR/our_collaboration_notes.md" ]; then
  echo "### our collaboration notes (the whole journal — read in full on every warmup)"
  awk '/^---$/{c++; if(c==2){p=1; next}} p' "$MEMDIR/our_collaboration_notes.md"
  echo
fi

echo "### branch + working tree"
git branch --show-current
s=$(git status --short)
if [ -z "$s" ]; then echo "(clean)"; else echo "$s"; fi
echo
echo "### last 10 commits"
git log --oneline -10
echo
echo "### ROADMAP — what's next"
awk '/^## /{p=0} /^## what.s next/{p=1} p' ROADMAP.md
