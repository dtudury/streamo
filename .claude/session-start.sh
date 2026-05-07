#!/usr/bin/env bash
# Injected as additionalContext at SessionStart so Claude can greet with continuity.
# See .claude/settings.json hooks.SessionStart.

set -e
cd "$(dirname "$0")/.."

echo "## streamo session bootstrap"
echo
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
