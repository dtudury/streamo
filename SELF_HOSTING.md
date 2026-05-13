# Self-hosting streamo

A complete recipe for putting a public streamo relay on the internet.
Written mid-2026 against the current versions of Hetzner Cloud, Debian,
Caddy, and Node — if you're reading this in 2028 the screens and version
numbers will have drifted but the shape is durable.

**Stack**: Hetzner Cloud (VPS) + Debian 12 + systemd (process supervisor)
+ Caddy (reverse proxy + automatic HTTPS).

**Audience**: anyone comfortable with JavaScript and a basic shell who
hasn't run a Linux server before. Each step has a verification you can
run to know it worked; if a step doesn't verify, fix it before moving on.

**What you'll have at the end**: a public URL serving the streamo
homepage over HTTPS, a working relay accepting WebSocket connections,
the home journal seeded, and the chat / explorer / hello / journal /
location apps all live.

---

## Why this stack

Each piece earns its place:

- **Hetzner Cloud**: cheap (~€4.51/mo for the CX22), simple billing, EU
  privacy stance. The VPS shape (not serverless, not managed-platform)
  is what streamo needs — one always-on Node process holding WebSocket
  state and a persistent data directory.
- **Debian (current stable)**: minimal, predictable. Ubuntu also fine;
  Debian has fewer cosmetic differences from "what a Linux server is"
  and fewer surprise rebrandings between releases. As of mid-2026 the
  current stable is Debian 13 ("Trixie") — take whatever Hetzner
  defaults to.
- **systemd**: every modern Linux distro ships it. Restarts your
  process on crash, on boot, on OOM. The unit file is 10 lines.
- **Caddy**: gives you HTTPS automatically via Let's Encrypt with a
  4-line config. No certbot rituals, no renewal cron jobs, no manual
  cert handling. It just works.

What we're explicitly *not* using and why:
- No Docker / containers — adds a layer of indirection that earns
  nothing for a single-process app on a single VPS. The Node app is
  the unit of deployment.
- No reverse proxy other than Caddy — nginx would also work, but
  Caddy's HTTPS-by-default is exactly the property we want.
- No managed PaaS (Fly, Railway, Render) — fine choices but the
  knowledge built deploying on Hetzner transfers to any Linux server
  you'll ever touch; PaaS knowledge mostly transfers to that PaaS.

---

## Prerequisites

Before starting, have ready:

- [ ] A domain name pointed at your registrar (we use streamo.dev)
- [ ] An SSH keypair on your laptop (`~/.ssh/id_ed25519.pub` or similar — generate with `ssh-keygen -t ed25519` if you don't have one)
- [ ] A Hetzner Cloud account (credit card or PayPal at signup)
- [ ] About 90 minutes for the first pass

You don't need backups configured before going live; we'll add those
right after. But don't skip that section.

---

## Step 1 — Spin up the VPS

In the Hetzner Cloud console:

1. You'll see a "Default" project auto-created on first signup. Either rename it (three-dot menu → Rename → `streamo`) or create a new one — projects are just namespaces, the name doesn't matter for one server.
2. Click into the project, then click **New Server** (the button may be labeled "Add Server" or "New Server" depending on which UI revision Hetzner is showing you).
3. Choices:
   - **Location**: pick the region closest to your expected users. EU defaults: Falkenstein or Helsinki. US users: Ashburn (newer datacenter, may need to scroll).
   - **Image**: take whatever's listed as the latest stable Debian (Debian 13 / "Trixie" as of mid-2026).
   - **Type**: any of the entry-level tiers work. **CPX11** (2 AMD dedicated vCPUs, 2GB RAM, 40GB disk, ~€4.79/mo) or **CX22** (2 shared vCPUs, 4GB RAM, 40GB disk, ~€4.51/mo) are both plenty. CPX11 has dedicated CPU but less RAM; CX22 has more RAM but shared CPU. Streamo idles most of the time and won't push past ~100MB RAM under realistic load, so either is fine. If only one is offered in your region, take it.
   - **Networking**: leave defaults (IPv4 + IPv6 both enabled).
   - **SSH Keys**: click "Add SSH key", paste your `~/.ssh/id_ed25519.pub` contents. This is how you'll log in.
   - **Volumes / Firewalls / Backups / Placement Groups / Labels**: skip all, defaults fine.
   - **Name**: `streamo-1` (or whatever).
4. Click **Create & Buy now**.

After ~30 seconds the server is provisioned. Note the public IPv4
address (you'll see it in the project dashboard).

**Verify**:

```sh
ssh root@<your-server-ip>
```

You should land in a root shell with no password prompt. If it asks
for a password, your SSH key wasn't picked up; check the SSH Keys
section in the Hetzner console and recreate the server (cheap; you've
done nothing yet).

---

## Step 2 — Initial server hardening

Logging in as root over the public internet is fine for a moment but
not durable. Two things to fix: create a non-root user with sudo, and
turn off root SSH.

Still SSH'd in as root on the box:

```sh
# Create a user (replace 'streamo' with whatever you like).
adduser streamo
# Press enter through password prompts (we'll use SSH keys only).
# Add to sudoers.
usermod -aG sudo streamo

# Copy your SSH key from root to the new user.
mkdir -p /home/streamo/.ssh
cp ~/.ssh/authorized_keys /home/streamo/.ssh/
chown -R streamo:streamo /home/streamo/.ssh
chmod 700 /home/streamo/.ssh
chmod 600 /home/streamo/.ssh/authorized_keys
```

**Verify** (open a NEW terminal, don't close the root session yet):

```sh
ssh streamo@<your-server-ip>
```

Should log in without password. If it does, back in the streamo shell:

```sh
sudo whoami
# Should print: root
```

If both work, lock down SSH:

```sh
sudo nano /etc/ssh/sshd_config
```

Find and edit these lines (uncomment if needed):

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

Save (Ctrl-O, Enter, Ctrl-X), then reload:

```sh
sudo systemctl reload ssh
```

**Verify**: in a new terminal, try `ssh root@<server-ip>` — it should
be refused. The `streamo` user session should still work.

**Set up the firewall** — only allow SSH, HTTP, HTTPS:

```sh
sudo apt update
sudo apt install -y ufw
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
# It'll warn about disrupting SSH; type 'y' (your SSH is already allowed).
```

**Verify**:

```sh
sudo ufw status
# Should show 22, 80, 443 ALLOW, everything else implicit deny.
```

---

## Step 3 — Install Node and Git

We use `fnm` (Fast Node Manager) instead of distro Node because Debian's
apt Node is older than we want. fnm is small and lets you bump versions
without sudo.

```sh
# Debian 13 minimal doesn't ship with unzip, which fnm's installer needs.
sudo apt install -y unzip
# Install fnm.
curl -fsSL https://fnm.vercel.app/install | bash
# Reload shell config.
source ~/.bashrc
# Install Node LTS.
fnm install --lts
fnm default lts-latest

# Verify.
node --version    # Should be v22.x or newer.
npm --version
```

Install git too (Debian ships it, but just in case):

```sh
sudo apt install -y git
```

---

## Step 4 — Get streamo on the box

Clone the repo, install dependencies:

```sh
mkdir -p ~/apps
cd ~/apps
git clone https://github.com/dtudury/streamo.git
cd streamo
npm ci

# Quick sanity check — tests should pass.
npm test
```

If tests fail, something is wrong with the Node environment; don't
proceed until they pass.

---

## Step 5 — Create the relay's signing identity

The relay is itself a streamo participant — every entry on the home
journal is signed by its identity. **The relay needs its own dedicated
username + password, not yours personally.** The public key derived
from those credentials becomes the home repo's address; if you ever
lose the password the home repo becomes unrecoverable (you'd have to
ship a new relay with a new identity and visitors would land on a
different repo).

Use your password manager to generate a strong random password (32+
characters). Save the username+password somewhere durable — this is
the seed of the relay's identity.

Create the env file (on the server, never commit to git):

```sh
cd ~/apps/streamo
nano .env.prod
```

Contents:

```
STREAMO_NAME=streamo
STREAMO_USERNAME=streamo-relay
STREAMO_PASSWORD=<paste-your-generated-password-here>
STREAMO_WEB=8080
STREAMO_DATA_DIR=/home/streamo/streamo-data
STREAMO_KEY_ITERATIONS=100000
```

Save. Lock the file so only you can read it:

```sh
chmod 600 .env.prod
```

**Verify the relay starts**:

```sh
npm run prod
```

You should see lines like:

```
[chat] room key: 02abc123...
[chat] serving on http://localhost:8080/apps/chat/
[chat] initialized chat room + journal seed
```

The "room key" hex string is the relay's public key — that's the home
repo's address. **Copy it somewhere** (you'll use it later to link to
the relay from outside).

Ctrl-C to stop. We'll wire systemd next so it runs without your shell.

---

## Step 6 — systemd unit

Tell systemd to run the streamo process, restart it on crash, start
it on boot. Create the unit file:

```sh
sudo nano /etc/systemd/system/streamo.service
```

Contents (adjust paths if your username isn't `streamo`):

```
[Unit]
Description=streamo relay
After=network.target

[Service]
Type=simple
User=streamo
WorkingDirectory=/home/streamo/apps/streamo
ExecStart=/home/streamo/.local/share/fnm/aliases/default/bin/node public/apps/chat/server.js --env-file .env.prod
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

The `ExecStart` path needs to be the absolute path to the Node binary
fnm installed. Find yours with `which node` while logged in as the
streamo user, and substitute it in.

Enable and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable streamo
sudo systemctl start streamo
```

**Verify**:

```sh
sudo systemctl status streamo
# Should show "active (running)" in green.

curl http://localhost:8080/
# Should return the homepage HTML.

# Read recent logs:
sudo journalctl -u streamo -n 50
```

If status is failed, the logs will tell you why. Common issues:
wrong Node path in ExecStart, wrong WorkingDirectory, missing
`.env.prod`, permission issues on the data dir.

---

## Step 7 — Caddy reverse proxy + automatic HTTPS

Install Caddy:

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Configure it:

```sh
sudo nano /etc/caddy/Caddyfile
```

Replace the file's contents with:

```
streamo.dev {
    reverse_proxy localhost:8080
}
```

That's it. Four lines. Caddy will:
- Listen on 80 and 443
- Auto-redirect 80 → 443
- Fetch a Let's Encrypt cert for streamo.dev on first request
- Reverse-proxy everything (including WebSocket upgrades) to the
  streamo process on 8080

Reload:

```sh
sudo systemctl reload caddy
```

**Verify** (DNS not configured yet, but locally):

```sh
sudo systemctl status caddy
# Should show active (running).

sudo journalctl -u caddy -n 20
# Should show it loading the Caddyfile without errors.
```

---

## Step 8 — Point DNS at the server

At your domain registrar (or DNS host — if you use Cloudflare for DNS,
do this in Cloudflare's dashboard, not at the registrar):

- Create an **A record** for `streamo.dev` → your server's IPv4 address.
- Create an **AAAA record** for `streamo.dev` → your server's IPv6
  address (visible in Hetzner Cloud dashboard). Optional but cheap.
- TTL: 300 seconds (5 minutes) is fine for initial testing; bump up
  later if you want.

DNS propagation: usually a few minutes, occasionally up to an hour.

**Verify**:

```sh
# From your laptop:
dig +short streamo.dev
# Should return your server IP.

# Then visit https://streamo.dev in a browser.
# First request may take 10-30s while Caddy fetches the cert.
# Subsequent requests are instant.
```

You should see the streamo homepage with a green pulse and the relay
key linked into the explorer. **That's live.** 🎉

---

## Step 9 — Set up unattended security updates

So security patches install themselves without you having to remember:

```sh
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
# Select "Yes" when prompted.
```

By default this only installs security-flagged updates, not feature
updates — exactly the right tradeoff for a server.

---

## Step 10 — Back up the data directory

The `~/streamo-data` directory holds all the content-addressed chunks
the relay knows about. **If you lose it, all repos relayed through
this server are gone from this server** (peers may still have copies
but you can't count on it). Don't skip backups.

We use [restic](https://restic.net) (incremental, encrypted backups)
to [Backblaze B2](https://www.backblaze.com/cloud-storage) (cheap S3-
compatible storage, ~$0.005/GB/mo, free tier 10GB).

```sh
sudo apt install -y restic
```

Create a B2 bucket at backblaze.com (free account), generate an
application key, save the `keyID` and `applicationKey`.

Initialize the restic repo (just the first time):

```sh
export B2_ACCOUNT_ID=<your-keyID>
export B2_ACCOUNT_KEY=<your-applicationKey>
restic -r b2:streamo-backup:server-1 init
# It asks for a password — generate another long random one, save it.
# Without this password the backups are unrecoverable.
```

Create a backup script:

```sh
nano ~/bin/backup-streamo.sh
```

Contents:

```sh
#!/bin/bash
export B2_ACCOUNT_ID=<your-keyID>
export B2_ACCOUNT_KEY=<your-applicationKey>
export RESTIC_PASSWORD=<the-restic-password>
restic -r b2:streamo-backup:server-1 backup /home/streamo/streamo-data
restic -r b2:streamo-backup:server-1 forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

Make it executable:

```sh
chmod 700 ~/bin/backup-streamo.sh
mkdir -p ~/bin
```

Run it once to verify:

```sh
~/bin/backup-streamo.sh
```

Add to crontab to run nightly:

```sh
crontab -e
```

Add this line:

```
0 3 * * * /home/streamo/bin/backup-streamo.sh > /home/streamo/backup.log 2>&1
```

Nightly at 3am, output captured in `backup.log`.

**Verify** the next day: `cat ~/backup.log` should show a successful
restic run.

---

## Operating it

### Deploying updates

When you push new code to GitHub:

```sh
ssh streamo@<server-ip>
cd ~/apps/streamo
git pull
npm ci   # only if package.json changed
sudo systemctl restart streamo
```

Brief WebSocket reconnect; clients auto-reconnect.

### Viewing logs

```sh
# Recent logs:
sudo journalctl -u streamo -n 100

# Follow live:
sudo journalctl -u streamo -f

# Logs since boot:
sudo journalctl -u streamo -b
```

### Restarting

```sh
sudo systemctl restart streamo
sudo systemctl restart caddy   # rare; usually unnecessary
```

### Checking process health

```sh
sudo systemctl status streamo
sudo systemctl status caddy
```

---

## Future: serving multiple domains from one box

When the streamo.social demo is ready and you want to serve a
different homepage / repo on streamo.social from the same server,
the path is:

1. Point streamo.social's A/AAAA records at the same server IP.
2. Add a second block to the Caddyfile:
   ```
   streamo.social {
       reverse_proxy localhost:8081
   }
   ```
3. Run a second streamo instance on port 8081 with a different
   `.env.prod.social` pointing to a different data dir and identity.
4. Add a second systemd unit `streamo-social.service`.

That's the simple version. The deeper version — where the streamo
process itself dispatches on `Host:` header and serves different
repos from the same Node process — is a thread in the roadmap; this
recipe gets us a working two-domain shape today.

---

## Troubleshooting

**Site doesn't load at all**
- `sudo systemctl status caddy` — is Caddy running?
- `sudo journalctl -u caddy -n 50` — errors fetching cert?
- DNS — `dig +short streamo.dev` from your laptop, does it match?
- Firewall — `sudo ufw status`, 80 and 443 open?

**Site loads but app is broken**
- `sudo systemctl status streamo` — is the Node process running?
- `sudo journalctl -u streamo -n 50` — any stack traces?

**Locked out of SSH**
- Hetzner Cloud console → your server → "Console" tab gives you VNC
  access to the box. Log in there as the streamo user (with the password
  you set, or recover via boot-into-rescue mode if you didn't set one).

**Cert renewal fails**
- Caddy renews automatically; if for some reason it fails, look in
  `sudo journalctl -u caddy`. Most common cause: DNS changed and the
  challenge can't resolve. Re-verify DNS first.

**Backups failing**
- `cat ~/backup.log` will tell you why. Most common: B2 API key
  rotated, regenerate and update the script.

---

## What this cost (mid-2026)

- Hetzner CX22: ~€4.51/mo
- Domain (streamo.dev): ~$15/year
- Domain (streamo.social): ~$15/year
- Backblaze B2 backup: ~$0.05/mo for streamo-sized data
- **Total: ~€5–6/mo for a real public p2p server**

Streamo is small enough that this never has to scale. The cheapest VPS
runs it forever.
