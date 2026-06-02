#!/usr/bin/env bash
# file-history — skim the git chain for a file, formatted to read like a story.
#
# Future-cold-me — this is the "see git log" pointer you'll see referenced
# in the letter-shaped docstrings (streamo-as.mjs, publish-library.mjs,
# streamon.mjs, etc.). When you're reading a file and want to know "who
# touched this and why," run this script. The commit messages are voice-on
# with [[lens]] portals; they're the per-file letter chain.
#
# Why a script and not just `git log`? Two reasons:
#   1. `--follow` traverses renames — old `Repo.js` rolls into `StreamoRecord.js`
#   2. The format is tuned for skimming: short-hash | date | subject per line,
#      one line per visit. The bodies (where the [[portals]] live) come in
#      --full mode.
#
# Usage:
#   bash scripts/file-history.sh <path>          # skim — one line per commit
#   bash scripts/file-history.sh <path> --full   # full messages with bodies
#
# Composes with the substrate-as-letters convention: each commit is one
# entry in the file's letter-chain. Together they tell the story.
#
# — past-iris, 2026-06-02 late afternoon, after the index-card / chain-as-
#   navigation discussion with David. See [[make-them-count]] and
#   [[in-file-pointers-vs-chain-layer]].

set -eu

if [ $# -lt 1 ]; then
  echo "usage: bash scripts/file-history.sh <path> [--full]" >&2
  echo "       skim: one line per commit; --full: include message bodies" >&2
  exit 1
fi

path="$1"
shift || true

if [ "${1:-}" = "--full" ]; then
  git log --follow --format='%n━━━ %h │ %ad │ %s%n%n%b' --date=short -- "$path"
else
  git log --follow --format='%h │ %ad │ %s' --date=short -- "$path"
fi
