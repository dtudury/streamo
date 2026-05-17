#!/usr/bin/env bash
#
# Deploy the current main branch (or another with --branch) to
# streamo.dev.  Idempotent: re-runnable, aborts on clean failure.
#
# Usage:
#   npm run deploy
#   npm run deploy -- --branch some-feature
#   npm run deploy -- --reset       # also wipes ~/streamo-data/
#
# Requires:
#   - ssh streamo@streamo.dev access (matches DEPLOY.md)
#   - 'streamo' user has NOPASSWD:ALL sudo on the remote
#   - fnm-managed node lives at ~/.local/share/fnm/aliases/default/bin
#     on the remote (the systemd unit's ExecStart also points there)
#
# See DEPLOY.md for the full operational context.

set -euo pipefail

SSH_TARGET="${STREAMO_DEPLOY_SSH:-streamo@streamo.dev}"
REMOTE_APP="${STREAMO_DEPLOY_PATH:-~/apps/streamo}"
REMOTE_DATA="${STREAMO_DEPLOY_DATA:-~/streamo-data}"
BRANCH="main"
RESET=0
PUBLIC_URL="${STREAMO_DEPLOY_VERIFY_URL:-https://streamo.dev/api/info}"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --reset)  RESET=1; shift ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "deploy.sh: unknown flag '$1' — see --help" >&2; exit 2 ;;
  esac
done

echo "── deploying to ${SSH_TARGET}:${REMOTE_APP} (branch: ${BRANCH}) ──"
[[ "$RESET" == "1" ]] && echo "── ⚠️  --reset: will wipe ${REMOTE_DATA} before restart ──"

# fnm doesn't init for non-interactive ssh shells.  Prepend its bin to
# PATH explicitly so npm + node resolve.  Matches the systemd unit's
# convention.
FNM_BIN='/home/streamo/.local/share/fnm/aliases/default/bin'

# Step 1: precheck — working tree must be clean
echo ""
echo "── precheck: remote working tree clean? ──"
if ssh "$SSH_TARGET" "cd ${REMOTE_APP} && [[ -z \"\$(git status --short)\" ]]"; then
  echo "  ✓ clean"
else
  echo "  ✗ remote has uncommitted changes — aborting" >&2
  ssh "$SSH_TARGET" "cd ${REMOTE_APP} && git status --short" >&2
  exit 3
fi

# Step 2: show what's incoming
echo ""
echo "── incoming commits ──"
ssh "$SSH_TARGET" "cd ${REMOTE_APP} && git fetch origin 2>&1 | tail -3 && git log HEAD..origin/${BRANCH} --oneline | head -20"
INCOMING=$(ssh "$SSH_TARGET" "cd ${REMOTE_APP} && git log HEAD..origin/${BRANCH} --oneline | wc -l" | tr -d ' ')
if [[ "$INCOMING" == "0" && "$RESET" != "1" ]]; then
  echo "  ✓ already up to date — nothing to do"
  exit 0
fi
echo "  $INCOMING commit(s) to apply"

# Step 3: pull
echo ""
echo "── git pull ──"
ssh "$SSH_TARGET" "cd ${REMOTE_APP} && git pull origin ${BRANCH}" | tail -8

# Step 4: install deps
echo ""
echo "── npm install ──"
ssh "$SSH_TARGET" "cd ${REMOTE_APP} && PATH=${FNM_BIN}:\$PATH npm install --production --no-audit --no-fund" 2>&1 | tail -5

# Step 5: optional archive wipe
if [[ "$RESET" == "1" ]]; then
  echo ""
  echo "── wiping ${REMOTE_DATA} ──"
  ssh "$SSH_TARGET" "sudo systemctl stop streamo && rm -rf ${REMOTE_DATA} && mkdir ${REMOTE_DATA}"
fi

# Step 6: restart
echo ""
echo "── restart ──"
ssh "$SSH_TARGET" "sudo systemctl restart streamo && sleep 2 && systemctl is-active streamo"

# Step 7: verify
echo ""
echo "── verify ──"
echo -n "  ${PUBLIC_URL} … "
if curl -sf "$PUBLIC_URL" >/dev/null; then
  echo "200"
  curl -s "$PUBLIC_URL" | sed 's/^/  /'
  echo ""
  echo "── ✨ deploy complete ──"
else
  echo "FAILED" >&2
  echo "  recent journal:" >&2
  ssh "$SSH_TARGET" "journalctl -u streamo -n 15 --no-pager" >&2
  exit 4
fi
