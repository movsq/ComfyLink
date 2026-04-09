# VPS Deployment

[← Back to README](../README.md)

The relay server routes encrypted jobs between your phone and PC. The VPS never sees plaintext. These steps assume you've already completed the [Quick Start](../README.md#quick-start) on your local machine.

---

## One-time VPS setup

SSH into your VPS and run:

```bash
# Install Docker and Docker Compose
apt update && apt install -y docker.io docker-compose-v2

# Create the deployment directory
mkdir -p /root/flux2-9b-klein-remote

# Create the VPS .env
cat > /root/flux2-9b-klein-remote/.env << 'EOF'
PC_SECRET=your-strong-random-secret-here
JWT_SECRET=another-strong-random-secret-here
GOOGLE_CLIENT_ID=your-google-oauth-client-id
VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id
FLUX_KLEIN_HOST=your-hostname.example.com
ALLOWED_ORIGINS=https://your-hostname.example.com
EOF
```

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

Watch progress in your repo's **Actions** tab.

---

## Manual deploy (no GitHub Actions)

```powershell
# From project root
cd client; npm run build; cd ..
scp -r ./client/dist/* user@your-vps:/root/flux2-9b-klein-remote/client/dist/
scp ./server/package.json user@your-vps:/root/flux2-9b-klein-remote/server/
scp -r ./server/src user@your-vps:/root/flux2-9b-klein-remote/server/
scp ./docker-compose.yml ./Caddyfile user@your-vps:/root/flux2-9b-klein-remote/
ssh user@your-vps "cd /root/flux2-9b-klein-remote && docker compose up -d --build --force-recreate"
```

---

## Tailscale (optional — private networking)

1. Install Tailscale on VPS: `curl -fsSL https://tailscale.com/install.sh | sh && tailscale up --ssh`
2. Enable **MagicDNS** + **HTTPS Certificates** in the [Tailscale admin console](https://login.tailscale.com/admin/dns)
3. Set `FLUX_KLEIN_HOST=your-machine.tailXXXXX.ts.net` in your VPS `.env`
4. Uncomment `tls internal` in `Caddyfile`
5. Set `SKIP_TLS_VERIFY=true` in your local `.env` (so pc-client accepts the Tailscale cert)

---

## Cloudflare proxy (optional — orange cloud ☁)

The `Caddyfile` ships with the Cloudflare trusted-proxy IP ranges **enabled by default**. This is safe regardless of whether you use Cloudflare: if traffic does not come through Cloudflare's edge, those IP ranges never appear as the upstream address and the block is a pure no-op.

When the Cloudflare proxy **is** active (orange cloud in your DNS dashboard), this block is what lets Caddy extract the real visitor IP instead of a Cloudflare edge IP. Without it, IP-based rate-limiting and the audit log would record Cloudflare's address, and OAuth redirects could misbehave.

**You only need to touch this if you want to remove it** — e.g. you use a different CDN whose ranges you want to list instead. In that case, comment out or replace the global `{ servers { trusted_proxies ... } }` block near the top of `Caddyfile` and redeploy:

```bash
docker compose up -d --force-recreate
```

> **Keeping the IP list current.** Cloudflare occasionally expands its ranges. Check [cloudflare.com/ips](https://www.cloudflare.com/ips/) and update the `trusted_proxies` line as needed.
