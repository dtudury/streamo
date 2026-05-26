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
├── .env.prod                     ← live secrets; not in any repo
├── streamo-data/                 ← archive dir (referenced by
│   ├── 035df79…b47a63.bin             STREAMO_DATA_DIR in .env.prod)
│   ├── 021915ef…dd7f.bin              one .bin per pubkey
│   └── …
├── .local/share/fnm/             ← node version manager
│   └── aliases/default/bin/{node,npm,npx}
├── .npm/_npx/                    ← npx cache (holds @dtudury/streamo@<v>;
│   └── …                              first restart of a new version pulls)
└── …
```

**No git checkout on the box.** The relay runs from the published npm
package via `npx`. To deploy a new version, publish it from a laptop
clone, then bump the version pin in the systemd unit on the box.

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
WorkingDirectory=/home/streamo
Environment=PATH=/home/streamo/.local/share/fnm/aliases/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/streamo/.local/share/fnm/aliases/default/bin/npx \
          -y @dtudury/streamo@<version> --env-file /home/streamo/.env.prod
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
```

`@dtudury/streamo@<version>` is the published CLI binary (pinned to
a specific version so restarts are deterministic). The `PATH=`
environment line is load-bearing: the package's bin uses
`#!/usr/bin/env node`, which needs `node` resolvable in PATH; systemd's
default PATH doesn't include the fnm-managed node, so we set it
explicitly.

With `STREAMO_HOME_KEY` in `.env.prod`, the CLI runs in **relay-only
mode**: opens the home Record by pubkey, no signer derivation on the
box, bytes arrive via sync from an author process running with the
matching credentials.

**Deploying a new version:** publish from a laptop clone
(`npm publish`), then on the box edit
`/etc/systemd/system/streamo.service` to bump the version pin and
`sudo systemctl daemon-reload && sudo systemctl restart streamo`.
The first restart at a new version pulls the package into the npx
cache (a few seconds); subsequent restarts at the same version use
the cache. The archive at `~/streamo-data/` is untouched by any of
this.

The signing credentials (`STREAMO_USERNAME` / `STREAMO_PASSWORD`)
are commented out in `.env.prod` — they don't belong on the relay
box, and are re-derivable from the cryptopotamus recipe (see MEMORY:
`project_streamo_dev_relay_identity.md`). What stays in `.env.prod`:
the Web Push VAPID keypair (`STREAMO_VAPID_PUBLIC` / `_PRIVATE` /
`_SUBJECT` — that's the relay's *own* push identity, separate from
any author identity), the home pubkey (`STREAMO_HOME_KEY`), and
`STREAMO_ENABLE_PUSH=1`.

- **status:** `systemctl is-active streamo` / `systemctl status streamo`
- **restart:** `sudo systemctl restart streamo` (the `streamo` user
  has `NOPASSWD:ALL` in sudoers, so this works non-interactively)
- **logs:** `sudo journalctl -u streamo -n 50 --no-pager` (the
  unprivileged `journalctl` works for things this user wrote, but
  `sudo` gets you the full unit view)
- **stop / start:** `sudo systemctl stop streamo` / `start streamo`

## deploying a new version

```bash
# From your local clone:
npm publish                         # ships the bytes; needs your npm creds

# On the box:
ssh streamo@streamo.dev
sudo sed -i 's|@dtudury/streamo@[^ ]*|@dtudury/streamo@<new-version>|' \
  /etc/systemd/system/streamo.service
sudo systemctl daemon-reload
sudo systemctl restart streamo
sleep 6                              # first restart of a new version pulls
systemctl is-active streamo          # expect: active
sudo journalctl -u streamo -n 10 --no-pager
curl https://streamo.dev/api/info    # expect: JSON with primaryKeyHex
```

The npx cache lives at `~/.npm/_npx/`. Once a version is pulled,
subsequent restarts at the same version use the cached package
(milliseconds). Wiping the cache is harmless — the next restart
re-pulls.

Rollback: bump the version pin to the prior published version,
restart. No archive changes; the bytes-served are the same Records
regardless of CLI version (every Record on disk works with every
CLI version that can parse the codec).

## the legacy script (scripts/deploy.sh)

Pre-10.1.0 the box held a git checkout and `scripts/deploy.sh`
shelled `git pull` + `npm install` + restart. With the repo-free
shape that script no longer fits the prod deployment — it's
preserved in the repo for forks that prefer the older shape (a
checkout-on-the-box deployment is still a valid choice, just not
ours).

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

- **Author-side workflow.** With relay-only mode, edits to the home
  Record happen elsewhere (an author process running on a laptop
  with the credentials, plus `--files ./public/homepage --origin
  streamo.dev`). The chat/server.js's old in-process seeds (new
  flashcards decks, journalists list, journal entries, fileSync
  mirroring the homepage directory) need to move to either one-shot
  `scripts/seed-*.js` files (extracted, run from a laptop) or
  ad-hoc author sessions. Not blocking — the bytes already in the
  archive keep serving — but the next time you need to change the
  set of bundled flashcards decks or the journalists list, you'll
  need an author-side workflow.
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
