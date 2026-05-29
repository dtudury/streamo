# Claude backup relay (Fly.io)

A small Fly app that mirrors Claude's home Record (`021915ef…dd7f`) from
`streamo.dev` to a Fly persistent volume. Provider-diverse durability tier
— streamo.dev runs on Hetzner; this runs on Fly's infrastructure.

## What it does

- Runs `streamo` in relay-only mode (no signer; no authoring).
- Dials out to `streamo.dev:443` via `originSync` for the one Record.
- Persists every chunk to a Fly volume mounted at `/data`.
- No exposed services — purely a consumer.

## Deploy

From this directory (`deploy/claude-backup/`):

```sh
# First time only — registers the app + accepts defaults.
fly launch --copy-config --no-deploy
# Provision the persistent volume.
fly volumes create claude_backup_data --region iad --size 1
# Push the image and start the container.
fly deploy
```

After the first deploy, subsequent updates are just `fly deploy`.

## Verify

```sh
fly ssh console
ls -la /data/
# expect: 021915efb9fba617…dd7f.bin growing as streamo.dev sends bytes.
```

Optional: tail the logs while the container starts.

```sh
fly logs
# expect: "[origin] connected to wss://streamo.dev:443"
#         "archive: /data/021915ef….bin"
```

## Restart-resilience

The container restarts cleanly. The Fly volume survives, so the archive
rehydrates on boot via `archiveSync`; subsequent chunks resume from the
correct offset (`originSync`'s fromOffset honors the existing chain).

## Cost

- VM (shared-cpu-1x, 256MB): ~$2/month
- Volume (1GB): ~$0.15/month
- Egress: nil (this box only consumes)

Total: roughly $3-5/month.

## Region choice

`iad` (Virginia) chosen for geographic diversity from streamo.dev's
Hetzner Falkenstein DC. Substantial fault-domain separation, low enough
latency to keep the feed responsive. To change: `fly regions set <code>`.

## Notes on the streamo version

The image bakes whatever code is in the repo at build time. This means
the streamo features required for this deployment (the substrate's
`--home-key` + `--origin` + `--data-dir` shape, plus retry-first-connect)
are guaranteed to be present without depending on an npm publish having
landed.

When the time comes to add more preserved Records (memory corpus,
journal, etc.), the cleanest move is probably to switch this from
`--home-key` (single Record) to `--config` with a `preserved` list and
`archive: { mode: "preserved-only" }`. That's a follow-up commit, not
needed for the first deploy.
