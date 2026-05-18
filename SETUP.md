← [Back to README](README.md)

# ComfyLink — Setup

This is the Tier 1 (local) setup guide — you'll be running everything on your own PC and reaching it from your phone over Tailscale. For Tier 2 (public VPS deployment), see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| **PC** | NVIDIA GPU with ≥ 12 GB VRAM, [ComfyUI](https://github.com/comfyanonymous/ComfyUI) installed |
| **VPS** | Any Linux VPS with Docker + Docker Compose (Tier 2 only) |
| **Phone** | Any modern browser with WebAuthn/PRF support (Chrome 118+, Safari 17.4+) |
| **Google Cloud project** | *(Optional)* OAuth 2.0 Client ID — only needed if you want Google sign-in. E-mail/password login works without it. |

> **WebCrypto / Secure Context requirement.** Your browser must be served from a secure context — `https://` or `http://localhost`. A plain LAN IP such as `http://192.168.x.x` is **not** a secure context and will not work. Tier 1 defaults to `http://localhost` for same-machine access and requires Tailscale for phone/remote access.

---

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/movsq/ComfyLink.git
cd ComfyLink
```

### 2. Copy and edit the config

```bash
cp .env.example .env
```

Generate two random secrets — run this twice and paste each result:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then set them in `.env`:

```env
PC_SECRET=<paste first random string here>
JWT_SECRET=<paste second random string here>
```

Everything else has a working default. Full variable reference → [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### 3. Set up Google OAuth *(optional — skip if using e-mail login only)*

If you skip this step, the Google sign-in button is hidden and the Google SDK is never loaded. E-mail/password registration still works.

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Authorised JavaScript origins: `https://YOUR_DOMAIN` (or `http://localhost:5173` for dev)
4. Add the Client ID to `.env` — note the `VITE_` copy is required so the frontend can see it:

   ```env
   GOOGLE_CLIENT_ID=<your-oauth-client-id>
   VITE_GOOGLE_CLIENT_ID=<same-value>
   ```

### 4. Generate the PC keypair (first time only)

```bash
cd pc-client
pip install -r requirements.txt
python keygen.py
```

This creates `private_key.pem` and `public_key.pem` in `pc-client/`, and prints a `PC_PUBLIC_KEY_FINGERPRINT=...` line. You can optionally encrypt the private key with a passphrase when prompted.

- **Copy the `PC_PUBLIC_KEY_FINGERPRINT` line into `.env`** — required for Tier 2 (VPS), optional but recommended for Tier 1. It pins the PC's identity so a compromised relay can't substitute a different worker.
- **Back up `private_key.pem`.** Losing it means any vault results encrypted to this key are unrecoverable.

### 5. Install ComfyUI models and custom nodes

See [ComfyUI-Workflow/README.md](ComfyUI-Workflow/README.md) for required model files and custom node packs.

> **Port note:** The pc-client connects to ComfyUI at `COMFYUI_URL` in your `.env` (default `http://127.0.0.1:8188`). Match this to **Settings → Server-Config → Port** in ComfyUI.

> **Recommended ComfyUI launch flags** (privacy + stealth):
> ```
> python main.py --disable-metadata --database-url sqlite:///:memory: --verbose CRITICAL --dont-print-server
> ```
> `--disable-metadata` stops prompt JSON being embedded in output PNGs. `--database-url sqlite:///:memory:` keeps history in RAM only (never written to `user/comfyui.db`). `--verbose CRITICAL` silences all non-fatal log output. The pc-client additionally clears each prompt from ComfyUI's in-memory history immediately after the image is downloaded.

### 6. Start everything (4 processes)

Start ComfyUI first (using the flags from Step 5), then open three more terminals for ComfyLink. This is the dev mode — Vite serves the client with hot reload.

```bash
# Terminal 1 — relay server
cd server && npm install && npm run dev

# Terminal 2 — Svelte client (dev server)
cd client && npm install && npm run dev

# Terminal 3 — PC Python bridge
cd pc-client && python main.py
```

Open the URL Vite prints (typically `http://localhost:5173`) and sign in with Google, or click **"Login with e-mail"** to register with an e-mail address and password.

> **Invite codes are required by default.** Registration (Google or e-mail) needs a `KLEIN-XXXX-XXXX` code. You'll generate one for yourself in Step 7. To allow open registration instead, set `INVITE_REQUIRED=false` in `.env`.

> **Troubleshooting:**
> - **No GPU?** Edit `pc-client/main.py` to import from `comfyui_mock` instead of `comfyui` — you'll get tinted placeholder images instead of real ones, useful for UI testing.
> - **PC bridge can't connect?** Run `python pc-client/check_env.py` to verify `PC_SECRET` matches between `.env` and what the bridge is loading.

### 7. Promote the first admin

Sign in once with Google or e-mail+password (this creates the row in the database), then promote that account:

```bash
cd server && node src/seed-admin.js your@email.com
```

You now have an Admin tab in the UI — use it to generate invite codes for everyone else. See [docs/ADMIN.md](docs/ADMIN.md) for managing users and codes.

---

## Phone / tablet access via Tailscale  (Tier 1 — no VPS needed)

Phones won't talk to a raw LAN IP — they need a proper hostname with a valid certificate, or the browser blocks the connection. [Tailscale](https://tailscale.com/) solves both problems at once: it creates a private encrypted mesh network and gives your PC a stable hostname (e.g. `my-pc.tail1234.ts.net`) that you can also get a real HTTPS cert for.

You'll need:

- A free [Tailscale account](https://tailscale.com/)
- Tailscale installed on your PC **and** on every device you want to use ComfyLink from

### The 4 steps

**1. Enable MagicDNS + HTTPS Certificates** in the [Tailscale admin console](https://login.tailscale.com/admin/dns). Both toggles are on the same page. Your PC gets a stable hostname (`my-pc.tail1234.ts.net`) and Tailscale acts as an ACME provider so Caddy can auto-provision a real Let's Encrypt cert.

**2. Install Tailscale on your phone** — [iOS](https://apps.apple.com/app/tailscale/id1470499037) or [Android](https://play.google.com/store/apps/details?id=com.tailscale.ipn.android). Sign in with the same account and connect.

**3. Start the server on your PC** (see Quick Start step 6 above).

**4. Open `https://my-pc.tail1234.ts.net` on your phone.** Done.

> **Tailscale must stay connected on your phone** — if you turn it off, the site becomes unreachable until you reconnect.

### What if I can't enable HTTPS Certificates? (offline Tailnet, etc.)

Uncomment `tls internal` in `Caddyfile` to fall back on Caddy's self-signed certificate:

```
{my-pc.tail1234.ts.net} {
    # Uncomment only when Tailscale HTTPS Certs are NOT enabled:
    # tls internal
    ...
}
```

Desktop browsers can be told to trust the self-signed cert. **Most mobile browsers will warn or block it** — for phone access, enabling Tailscale HTTPS Certificates is strongly recommended.

---

## Where to go next

- Want to expose it publicly instead of via Tailscale? → [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (Tier 2)
- Need to manage users or generate more invite codes? → [docs/ADMIN.md](docs/ADMIN.md)
- Curious how the encryption works? → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Looking for every config option? → [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

Full doc index is on the [README](README.md#documentation).
