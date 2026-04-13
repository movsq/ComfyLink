← [Back to README](README.md)

# ComfyLink — Setup

This guide covers everything you need to get ComfyLink running.

---

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| **PC** | NVIDIA GPU with ≥ 12 GB VRAM, [ComfyUI](https://github.com/comfyanonymous/ComfyUI) installed |
| **VPS** | Any Linux VPS with Docker + Docker Compose (Tier 2 only) |
| **Phone** | Any modern browser with WebAuthn/PRF support (Chrome 118+, Safari 17.4+) |
| **Google Cloud project** | *(Optional)* OAuth 2.0 Client ID — only needed if you want Google sign-in. E-mail/password login works without it. |

> **WebCrypto / Secure Context requirement.** Your browser must be served from a secure context — `https://` or `http://localhost`. A plain LAN IP such as `http://192.168.x.x` is **not** a secure context and will not work. The setup wizard enforces this: Tier 1 defaults to `http://localhost` for same-machine access and requires Tailscale for phone/remote access.

---

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/Flux2-9B-Klein-Remote.git
cd Flux2-9B-Klein-Remote
```

### 2. Copy and edit the config

```bash
cp .env.example .env
```

At minimum set these two values:

```env
PC_SECRET=<long-random-string>          # PC WebSocket auth secret
JWT_SECRET=<another-long-random-string> # Session token signing key
```

Only add these if you want Google OAuth login:

```env
GOOGLE_CLIENT_ID=<your-oauth-client-id>
VITE_GOOGLE_CLIENT_ID=<same-value>      # Vite must expose it with VITE_ prefix
```

> **Google OAuth is optional.** E-mail/password login works without it. If `GOOGLE_CLIENT_ID` / `VITE_GOOGLE_CLIENT_ID` are not set (or left empty), the Google sign-in section is hidden and the Google Identity Services SDK is not initialised.

> **Generate random secrets:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
>
> Full variable reference → [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

### 3. Set up Google OAuth *(optional — skip if using e-mail login only)*

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Authorised JavaScript origins: `https://YOUR_DOMAIN` (or `http://localhost:5173` for dev)
4. Copy the Client ID into `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID` in `.env`

> If you skip this step, the Google sign-in section does not appear and Google Identity Services is not loaded. Users can still register with e-mail and password.

### 4. Generate the PC keypair (first time only)

```bash
cd pc-client
pip install -r requirements.txt
python keygen.py
```

This creates `private_key.pem` and `public_key.pem` inside `pc-client/`.
`keygen.py` can optionally encrypt the private key with a passphrase and prints a `PC_PUBLIC_KEY_FINGERPRINT=...` line you can add to `.env` for public-key pinning on the server.
**Back up `private_key.pem`** — losing it means vault results encrypted to this key can no longer be decrypted.

### 5. Install ComfyUI models and custom nodes

See [ComfyUI-Workflow/README.md](ComfyUI-Workflow/README.md) for required model files and custom node packs.

> **Port note:** The pc-client connects to ComfyUI at `COMFYUI_URL` in your `.env` (default `http://127.0.0.1:8188`). Match this to **Settings → Server-Config → Port** in ComfyUI.

> **Recommended ComfyUI launch flags** (privacy + stealth):
> ```
> python main.py --disable-metadata --database-url sqlite:///:memory: --verbose CRITICAL --dont-print-server
> ```
> `--disable-metadata` stops prompt JSON being embedded in output PNGs. `--database-url sqlite:///:memory:` keeps history in RAM only (never written to `user/comfyui.db`). `--verbose CRITICAL` silences all non-fatal log output. The pc-client additionally clears each prompt from ComfyUI's in-memory history immediately after the image is downloaded.

### 6. Start everything

```bash
# Terminal 1 — relay server
cd server && npm install && npm run dev

# Terminal 2 — Svelte client
cd client && npm install && npm run dev

# Terminal 3 — PC Python bridge
cd pc-client && python main.py
```

Open the URL Vite prints (e.g. `http://localhost:5173`) and sign in with Google or use the **"Login with e-mail"** button to register with an e-mail address and password.

> **Invite codes required by default.** `INVITE_REQUIRED=true` is the default — a `KLEIN-XXXX-XXXX` invite code is needed to register (Google & e-mail). Set `INVITE_REQUIRED=false` in `.env` to allow open registration.

> **No GPU?** Use `comfyui_mock.py` — swap the import in `main.py` to get a tinted placeholder image instead.
>
> **Env issues?** Run `python pc-client/check_env.py` to verify `PC_SECRET` is loading correctly.

### 7. Promote the first admin

```bash
cd server && node src/seed-admin.js your@email.com
```

See [docs/ADMIN.md](docs/ADMIN.md) for managing users and invite codes from that point on.

---

## Phone / tablet access via Tailscale  (Tier 1 — no VPS needed)

Tailscale creates a private encrypted mesh network that gives every device in your network a stable **hostname** (not a raw IP). That hostname is what makes this work on phones — mobile browsers require a proper hostname with a matching certificate and will refuse or warn on raw IP addresses like `192.168.x.x`, even with `https://` and `tls internal`.

> **Why not a LAN IP?** A plain LAN IP is a dead end for phone browsers. Even with TLS it triggers an untrusted-certificate wall that most mobile users cannot get past. The Tailscale MagicDNS hostname bypasses that entirely.

### Prerequisites

- [Tailscale account](https://tailscale.com/) (free tier supports personal use)
- Tailscale installed on this PC

---

### Recommended path — Tailscale HTTPS Certificates (real Let's Encrypt cert)

This is the zero-friction option. Tailscale acts as an ACME provider and hands Caddy a genuine Let's Encrypt certificate for your MagicDNS hostname. Phone browsers trust it natively; no root CA installation, no security warnings.

**1. Enable MagicDNS and HTTPS Certificates in the Tailscale admin console**

Go to [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns), enable **MagicDNS**, and then enable **HTTPS Certificates** (same page). Your PC gets a stable hostname like `my-pc.tail1234.ts.net`.

**2. Run `python ComfyLink-Setup/setup.py`**

Choose *Tier 1*, enter your MagicDNS hostname when prompted, and answer **Yes** when asked if you have enabled HTTPS Certificates. The wizard writes your `.env` and leaves the Caddyfile as-is (no `tls internal` needed — Caddy auto-provisions the cert).

**3. Start the server, install Tailscale on your phone, navigate to `https://my-pc.tail1234.ts.net`.**

---

### Alternative path — `tls internal` (Caddy self-signed cert)

Use this only if you cannot or do not want to enable Tailscale HTTPS Certificates (e.g. you are on a private Tailnet without internet access).

> **Warning:** `tls internal` uses Caddy's built-in private CA. Desktop browsers can be told to trust it; most mobile browsers will show a certificate warning and may block the connection. For best phone compatibility, the recommended path above is strongly preferred.

**1. Enable MagicDNS** (no HTTPS Certificates needed) at [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns).

**2. Run `python ComfyLink-Setup/setup.py`**

Enter your MagicDNS hostname and answer **No** when asked if HTTPS Certificates are enabled. The wizard uncomments `tls internal` in the Caddyfile automatically.

**3. Start the server and navigate to `https://my-pc.tail1234.ts.net`.**

You may need to accept or install the Caddy CA root certificate on each device. On desktop this is straightforward; on mobile it is device-specific and may not work at all.

---

### Manual Caddyfile reference

```
{my-pc.tail1234.ts.net} {
    # Tailscale HTTPS Certs ON  → leave this line commented (Caddy auto-provisions)
    # Tailscale HTTPS Certs OFF → uncomment this line for self-signed cert:
    # tls internal
    ...
}
```

---

**4. Install Tailscale on your phone**

Download Tailscale for [iOS](https://apps.apple.com/app/tailscale/id1470499037) or [Android](https://play.google.com/store/apps/details?id=com.tailscale.ipn.android), sign in with the same account, and connect.

**5. Open ComfyLink on your phone**

Navigate to `https://my-pc.tail1234.ts.net` in your phone's browser. The connection is private to your Tailscale network — no one else can reach it.

> **Must be on Tailscale.** Your phone must have the Tailscale app open and connected to reach this URL. If you close Tailscale on your phone, the site becomes unreachable from that device until you reconnect.

---

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Workflow pipeline, job queue mechanics, encryption schemes, wire formats |
| [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) | Account lifecycle, per-user quotas, invite codes, guest mode, Terms of Service |
| [docs/VAULT.md](docs/VAULT.md) | Master key wrapping (bio/password/recovery), vault operations, result storage |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | VPS setup, GitHub Actions auto-deploy, manual deploy, Tailscale, Cloudflare proxy |
| [docs/API.md](docs/API.md) | Full REST API and WebSocket protocol message reference |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | All environment variables with defaults and descriptions |
| [docs/ADMIN.md](docs/ADMIN.md) | Admin panel tabs (Codes, Users), first-admin CLI |
| [ComfyUI-Workflow/README.md](ComfyUI-Workflow/README.md) | Required models, custom nodes, full node map |
