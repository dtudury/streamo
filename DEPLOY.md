# deploying streamo.dev

Operational reference for the streamo.dev production deployment.
This is the canonical "what's where, how to update it" doc — keep
it in sync as the deployment evolves.

The standard deploy is now `npm run deploy` (which wraps
`scripts/deploy.sh`). The rest of this doc is the *why* + the
manual recipe so the next operator (human or model) can drive it
without the script if needed.

---

## host

- **Provider:** Hetzner (single VM, bare-bones; not a managed PaaS)
- **SSH:** `ssh streamo@streamo.dev` — no `~/.ssh/config` alias
  needed; the `streamo` user is set up with the operator's
  github-published key
- **DNS:** `streamo.dev` and `streamo.social` both A-record to this
  host
- **TLS:** Caddy 2 handles cert provisioning + termination
  automatically (Let's Encrypt). Caddyfile is `/etc/caddy/Caddyfile`,
  service is `caddy.service`. The whole config is:

  ```
  streamo.dev, streamo.social {
      reverse_proxy localhost:8080
  }
  ```

  Caddy renews certs in the background. We don't touch it during
  normal deploys.

## layout on the box

```
/home/streamo/
├── apps/
│   └── streamo/                  ← the git clone (deploy target)
│       ├── .env.prod             ← live secrets; NEVER commit
│       ├── package.json
│       ├── public/apps/chat/server.js   ← the running entry point
│       └── …
├── streamo-data/                 ← archive dir (referenced by
│   ├── 035df79…b47a63.bin             STREAMO_DATA_DIR in .env.prod)
│   ├── 021915ef…dd7f.bin              one .bin per pubkey
│   └── …
├── .local/share/fnm/             ← node version manager
│   └── aliases/default/bin/{node,npm}
└── …
```

`STREAMO_DATA_DIR=/home/streamo/streamo-data` is set in
`.env.prod`, so `git pull` and `npm install` never touch the
archive. Backups (if/when we add them) target `streamo-data/`.

## process management

A systemd unit (`/etc/systemd/system/streamo.service`) supervises
the node process. Key fields:

```ini
[Service]
Type=simple
User=streamo
WorkingDirectory=/home/streamo/apps/streamo
ExecStart=/home/streamo/.local/share/fnm/aliases/default/bin/node \
          public/apps/chat/server.js --env-file .env.prod
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
```

- **status:** `systemctl is-active streamo` / `systemctl status streamo`
- **restart:** `sudo systemctl restart streamo` (the `streamo` user
  has `NOPASSWD:ALL` in sudoers, so this works non-interactively)
- **logs:** `sudo journalctl -u streamo -n 50 --no-pager` (the
  unprivileged `journalctl` works for things this user wrote, but
  `sudo` gets you the full unit view)
- **stop / start:** `sudo systemctl stop streamo` / `start streamo`

## the standard deploy

`npm run deploy` (from your local clone). It runs
`scripts/deploy.sh` which does, in order:

1. **ssh-check:** confirms the working tree on the remote is
   clean; aborts if not
2. **fetch + count:** shows what's about to land
3. **git pull origin main**
4. **npm install** (uses an explicit PATH to the fnm-managed node,
   since non-interactive ssh shells don't load fnm init)
5. **sudo systemctl restart streamo**
6. **verify:** `systemctl is-active streamo` returns `active`, then
   `curl https://streamo.dev/api/info` succeeds

Pass `--reset` to wipe `~/streamo-data/` before restart (see
"when to wipe the archive" below).

Pass `--branch <name>` to deploy a non-main branch (rare; useful
for staging or experimental rollouts).

## manual deploy (if the script breaks)

```bash
ssh streamo@streamo.dev
cd ~/apps/streamo
git status   # should be clean
git pull origin main
PATH=/home/streamo/.local/share/fnm/aliases/default/bin:$PATH npm install --production --no-audit --no-fund
sudo systemctl restart streamo
sleep 2 && systemctl is-active streamo   # expect: active
journalctl -u streamo -n 8 --no-pager
exit
curl https://streamo.dev/api/info        # expect: JSON with primaryKeyHex
```

## when to wipe the archive

The on-disk archive format is forward-compatible (per the 7.0.0
CHANGELOG: *"no on-disk format change"*), so a `git pull` deploy
preserves all existing chat-room state, journal entries, members,
and signed history.

**Wipe only when:**

- the chunk codec is incompatibly extended (would be a major
  version with a breaking-codec note in CHANGELOG)
- the data has been corrupted (a botched migration, a
  multi-device-write divergence — see "known limitations" in
  ROADMAP)
- you genuinely want to start fresh (rare; usually a separate
  staging exercise, not a prod move)

The wipe command (used during the 6.0 hash-chain rollout, May
2026):

```bash
sudo systemctl stop streamo
rm -rf ~/streamo-data && mkdir ~/streamo-data
sudo systemctl start streamo
```

`scripts/deploy.sh --reset` does this within the standard sequence.

## verifying after a deploy

The minimum-viable check after any deploy:

```bash
curl https://streamo.dev/api/info
```

Should return `{"primaryKeyHex":"…","name":"streamo","keyIterations":100000}`.

For a deeper check (after a feature-bearing deploy), inspect the
home repo's value:

```bash
curl https://streamo.dev/streams/<primaryKeyHex> | python3 -m json.tool | head -30
```

Look for the expected keys (`entries`, `journalists`, `members`,
`files`) and reasonable sizes.

## what's NOT in this doc (yet)

- **Backups.** No automated backup of `~/streamo-data/` exists.
  When users show up, this becomes urgent.
- **Staging.** No staging host yet. When users show up, a second
  Hetzner box running `streamo-staging.dev` from a `staging` branch
  is the natural shape; deploys flow `main → staging → verify →
  prod`. Worth discussing the moment a real user appears.
- **Monitoring.** Caddy + systemd logs are the only signal. No
  alerting on outage.

These are gaps we're aware of; calling out so they don't surprise
the next operator.
