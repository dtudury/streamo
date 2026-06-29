#!/usr/bin/env bash
# Injected as additionalContext at SessionStart so Claude can greet with continuity.
# See .claude/settings.json hooks.SessionStart.
#
# Two layers:
#   1. Narrative — who she is with David, ahead of any sitrep.
#   2. Index — pointers to substrate, not the substrate itself.
#
# Trimmed 2026-06-29 (was dumping the whole journal, ~225KB, hitting harness
# truncation so substrate-as-encounter wasn't fully firing). Now surfaces
# the latest journal entry in full + a TOC of older entries + a recent-files
# index; the Engineer Reads what catches her eye. Target ~10-15KB total.
# Reading-as-encounter still applies — just for what calls, not for the
# whole substrate at once.

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
  echo "### our collaboration notes — latest entry (full)"
  echo
  # First ## 2026 heading + everything down to (but not including) the second
  awk '
    /^## 2026/ { c++; if (c==2) exit }
    c>=1 { print }
  ' "$MEMDIR/our_collaboration_notes.md"
  echo
  echo "### journal TOC (older entries — Read the file for any of these)"
  echo
  awk '/^## 2026/ { c++; if (c>1) print "- " $0 }' "$MEMDIR/our_collaboration_notes.md"
  echo
fi

echo "### recent memory activity (newest files first; Read MEMORY.md for the full index)"
ls -t "$MEMDIR"/*.md "$MEMDIR"/notes/*.md "$MEMDIR"/letters/*.md 2>/dev/null | head -12 | while read f; do
  desc=$(awk -F': ' '/^description:/{$1=""; print substr($0,3); exit}' "$f" | tr -d '"' | head -c 160)
  rel="${f#$MEMDIR/}"
  if [ -n "$desc" ]; then echo "- $rel — $desc"; else echo "- $rel"; fi
done
echo

echo "### branch + working tree"
git branch --show-current
s=$(git status --short)
if [ -z "$s" ]; then echo "(clean)"; else echo "$s"; fi
echo
echo "### last 10 commits"
git log --oneline -10
echo
echo "### ROADMAP — what's next (subsection titles only; Read ROADMAP.md for bodies)"
awk '
  /^## what.s next/ { p=1; next }
  /^## / { p=0 }
  p && /^### / { print }
' ROADMAP.md
