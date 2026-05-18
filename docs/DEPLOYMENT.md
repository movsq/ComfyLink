# Deployment

[← Back to README](../README.md)

ComfyLink supports two deployment tiers. Choose the one that fits your use case:

| Tier | Server location | Phone/remote access | VPS required |
|------|-----------------|---------------------|--------------|
| **Tier 1 — Local / Private** | Your PC | Via Tailscale (private mesh, HTTPS) | No |
| **Tier 2 — Public** | VPS (Docker + Caddy) | Any browser, any network | Yes |

Both tiers require a **secure context** — `https://` or `http://localhost`. Plain LAN IPs are not supported.

---

## Tier 1 — Local / Private via Tailscale

For single-user or household use, the relay runs on your own PC and you reach it from your phone through [Tailscale](https://tailscale.com/) — a private encrypted mesh network that gives your PC a stable hostname and a real HTTPS cert. Nothing is exposed to the public internet.

The full walkthrough lives in [SETUP.md](../SETUP.md#phone--tablet-access-via-tailscale--tier-1--no-vps-needed). One-line summary: enable **MagicDNS** + **HTTPS Certificates** in the Tailscale admin console, set `FLUX_KLEIN_HOST=your-pc.tail1234.ts.net` and `DEPLOY_MODE=local` in `.env`, install Tailscale on your phone, then open `https://your-pc.tail1234.ts.net`.

---

## Tier 2 — Public VPS Deployment

The relay server routes encrypted jobs between your phone and PC. The VPS never sees plaintext. These steps assume you've already completed the [Quick Start](../README.md#get-started) on your local machine — in particular, you should have a `private_key.pem` / `public_key.pem` pair from `pc-client/keygen.py` and the `PC_PUBLIC_KEY_FINGERPRINT` it printed.

You'll also need:

- A VPS running Linux (cheapest tier from any provider works — 1 GB RAM is plenty)
- A domain name pointed at the VPS (an A record is enough)
- SSH access as `root` or a sudoer

---

## One-time VPS setup

SSH into your VPS and run this once:

```bash
# 1. Install Docker
apt update && apt install -y docker.io docker-compose-v2

# 2. Create the deployment directory
mkdir -p /root/flux2-9b-klein-remote
cd /root/flux2-9b-klein-remote

# 3. Write the .env file — replace every <placeholder> below
cat > .env << 'EOF'
PC_SECRET=<long-random-string>
JWT_SECRET=<another-long-random-string>
FLUX_KLEIN_HOST=your-hostname.example.com
ALLOWED_ORIGINS=https://your-hostname.example.com

# Required for remote mode — dual-layer key pinning.
# Use the SHA-256 fingerprint printed by pc-client/keygen.py.
PC_PUBLIC_KEY_FINGERPRINT=<sha256-fingerprint>
VITE_PC_KEY_FINGERPRINT=<same-sha256-fingerprint>

# Optional — only set these if you want Google sign-in
# GOOGLE_CLIENT_ID=<oauth-client-id>
# VITE_GOOGLE_CLIENT_ID=<same-oauth-client-id>
EOF
```

Don't start Docker yet — pick a deploy method below (automated or manual), then the deploy step will bring everything up.

---

## Automated deploy via GitHub Actions (recommended)

Push to `main` → GitHub Actions builds the Svelte frontend, uploads everything to your VPS, and restarts Docker.

**Add these 4 secrets to your repo** (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `VPS_HOST` | SSH-reachable address of your VPS (IP or hostname) |
| `VPS_USER` | SSH username (e.g. `root`) |
| `SSH_PRIVATE_KEY` | Private SSH key authorised to log in to the VPS |
| `VPS_PATH` | Deployment directory on the VPS (e.g. `/root/flux2-9b-klein-remote`) |

Then push:

```bash
git push origin main
```

Watch progress in your repo's **Actions** tab. The first run does the initial `docker compose up`; subsequent pushes do hot rebuilds.

---

## Manual deploy (no GitHub Actions)

From your local machine (works on macOS, Linux, or WSL — for PowerShell, replace `&&` with `;`):

```bash
# 1. Build the frontend
(cd client && npm run build)

# 2. Upload code + config
VPS=user@your-vps
DEST=/root/flux2-9b-klein-remote

scp -r ./client/dist/*               $VPS:$DEST/client/dist/
scp    ./server/package.json         $VPS:$DEST/server/
scp -r ./server/src                  $VPS:$DEST/server/
scp    ./docker-compose.yml ./Caddyfile $VPS:$DEST/

# 3. Bring it up
ssh $VPS "cd $DEST && docker compose up -d --build --force-recreate"
```

---

## Point your PC at the deployed relay

The VPS is just the relay — the GPU work still happens on your PC. On the PC, edit your local `.env`:

```env
DEPLOY_MODE=remote
FLUX_KLEIN_HOST=your-hostname.example.com
PC_SECRET=<same value as VPS .env>
PC_PUBLIC_KEY_FINGERPRINT=<same value as VPS .env>
```

Then start the pc-client (`cd pc-client && python main.py`). It connects outbound over WSS to your VPS — no port-forwarding on your home network needed.

---

## Tailscale on the VPS (optional — lock Tier 2 to Tailscale members)

If you want to restrict a VPS deployment so only Tailscale members can reach it (instead of the public internet), install Tailscale on both the VPS and every client device:

1. Install Tailscale on VPS: `curl -fsSL https://tailscale.com/install.sh | sh && tailscale up --ssh`
2. Enable **MagicDNS** + **HTTPS Certificates** in the [Tailscale admin console](https://login.tailscale.com/admin/dns)
3. Set `FLUX_KLEIN_HOST=your-vps.tailXXXXX.ts.net` in your VPS `.env`
4. Leave `Caddyfile` unchanged when using Tailscale HTTPS Certificates
5. Keep `SKIP_TLS_VERIFY=false` when the hostname has a valid Tailscale-issued Let's Encrypt cert

If you intentionally use the self-signed `tls internal` fallback instead, then uncomment `tls internal` in `Caddyfile` and set `SKIP_TLS_VERIFY=true` for the pc-client.

---

## Cloudflare proxy (optional — orange cloud ☁)

The `Caddyfile` ships with the Cloudflare trusted-proxy IP ranges **enabled by default**. This is safe regardless of whether you use Cloudflare: if traffic does not come through Cloudflare's edge, those IP ranges never appear as the upstream address and the block is a pure no-op.

When the Cloudflare proxy **is** active (orange cloud in your DNS dashboard), this block is what lets Caddy extract the real visitor IP instead of a Cloudflare edge IP. Without it, IP-based rate-limiting and the audit log would record Cloudflare's address, and OAuth redirects could misbehave.

**You only need to touch this if you want to remove it** — e.g. you use a different CDN whose ranges you want to list instead. In that case, comment out or replace the global `{ servers { trusted_proxies ... } }` block near the top of `Caddyfile` and redeploy:

```bash
docker compose up -d --force-recreate
```

> **Keeping the IP list current.** Cloudflare occasionally expands its ranges. Check [cloudflare.com/ips](https://www.cloudflare.com/ips/) and update the `trusted_proxies` line as needed.
