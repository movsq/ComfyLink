# ComfyLink

**Generate with Flux 2 from your phone. End-to-end encrypted. Your prompts stay yours.**

Run Flux 2 on your own PC's GPU and use it from any browser — phone, tablet, laptop — without exposing a single port on your home network. Your PC connects outbound to a lightweight relay; the relay forwards encrypted blobs it cannot read. No cloud subscription. No one else processing your images.

<details>
<summary><b>Screenshots</b></summary>
<br>

<table>
  <tr>
    <td align="center"><b>Login</b><br><img src="docs/screenshots/login.png" width="220"></td>
    <td align="center"><b>Login — Access Code</b><br><img src="docs/screenshots/login-access-code.png" width="220"></td>
    <td align="center"><b>Generate</b><br><img src="docs/screenshots/submit.png" width="220"></td>
  </tr>
  <tr>
    <td align="center"><b>Queue — Current</b><br><img src="docs/screenshots/queue-current.png" width="220"></td>
    <td align="center"><b>Configuration</b><br><img src="docs/screenshots/configuration.png" width="220"></td>
    <td align="center"><b>Result Preview</b><br><img src="docs/screenshots/result.png" width="220"></td>
  </tr>
  <tr>
    <td align="center"><b>Image Preview in Vault</b><br><img src="docs/screenshots/image-preview-in-vault.png" width="220"></td>
    <td align="center"><b>Gallery</b><br><img src="docs/screenshots/gallery%20%28vault%29.png" width="220"></td>
    <td align="center"><b>Unlock Vault</b><br><img src="docs/screenshots/unlock-vault.png" width="220"></td>
  </tr>
  <tr>
    <td align="center"><b>Vault Settings</b><br><img src="docs/screenshots/vault-settings.png" width="220"></td>
    <td align="center"><b>Admin — Codes</b><br><img src="docs/screenshots/admin-codes.png" width="220"></td>
    <td align="center"><b>Admin — Users</b><br><img src="docs/screenshots/admin-users.png" width="220"></td>
  </tr>
</table>

</details>

---

## How it works

```
[Any browser] ──── WSS encrypted ────▶ [Relay server] ──── WSS encrypted ────▶ [Your PC + ComfyUI]
```

Your PC connects *outbound* to the relay — no port-forwarding, no dynamic DNS, no firewall rules needed. The relay brokers WebSocket connections between your browser and your PC; it never decrypts anything. ComfyLink is designed for personal or small-group use: you run the relay, you control who gets in.

---

## Get started

Run the interactive setup wizard from the project root — it handles keys, config, dependencies, and launcher scripts:

```bash
python ComfyLink-Setup/setup.py
```

Pick the deployment tier that fits your use case:

> **Secure context required.** WebCrypto (end-to-end encryption) only works when your browser is served from `https://` or `http://localhost`. A plain LAN IP (`http://192.168.x.x`) is not a secure context and will not work.

### Tier 1 — Local / Private

The server runs on your PC. Open `http://localhost:3000/` in a browser on the same machine.

**For phone, tablet, or remote access** — install [Tailscale](https://tailscale.com/) on your PC and on every device you want to use. Tailscale creates a private encrypted mesh network and gives your PC a stable **MagicDNS hostname** (e.g. `my-pc.tail1234.ts.net`).

> **Why not a LAN IP?** Mobile browsers require a hostname that matches a certificate — raw IPs like `192.168.x.x` can't have trusted certs and will be blocked by the browser's secure-context check. The Tailscale MagicDNS hostname is the right tool here.

**Recommended:** enable **HTTPS Certificates** in the [Tailscale admin console](https://login.tailscale.com/admin/dns). Tailscale then acts as an ACME provider and Caddy auto-provisions a real Let's Encrypt certificate for your hostname. Phone browsers trust it natively — no security warnings, no root CA installation.

**Alternative (no internet/offline Tailnet):** skip HTTPS Certificates and the setup wizard will enable `tls internal` in the Caddyfile instead. Caddy issues a self-signed cert. Desktop browsers can be configured to trust it; mobile browsers will typically warn or block.

→ [Local / Tailscale setup guide](SETUP.md)

### Tier 2 — Public / Self-hosted

Deploy the relay to a cheap VPS with Docker and HTTPS (Caddy handles TLS automatically). Cloudflare proxy is optional and supported out of the box. Anyone with an invite code or a Google account can use it from any browser, anywhere — no VPN required.

→ [VPS deployment guide](SETUP.md) · [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## Documentation

| Doc | Contents |
|-----|----------|
| [SETUP.md](SETUP.md) | Full setup guide for all deployment modes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Workflow pipeline, job queue mechanics, encryption schemes, wire formats |
| [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) | Account lifecycle, per-user quotas, invite codes, guest mode, Terms of Service |
| [docs/VAULT.md](docs/VAULT.md) | Master key wrapping (bio/password/recovery), vault operations, result storage |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | VPS setup, GitHub Actions auto-deploy, manual deploy, Tailscale, Cloudflare proxy |
| [docs/API.md](docs/API.md) | Full REST API and WebSocket protocol reference |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | All environment variables with defaults and descriptions |
| [docs/ADMIN.md](docs/ADMIN.md) | Admin panel tabs (Codes, Users), first-admin CLI |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Privacy chain, vault data model, deployer legal position |
| [docs/TOS.md](docs/TOS.md) | Terms of Service and legal framework |
| [ComfyUI-Workflow/README.md](ComfyUI-Workflow/README.md) | Required models, custom nodes, full node map |

---


## Features

- **End-to-end encryption** — every job (prompt, reference images, result) is encrypted on-device with ECDH-AES-GCM; the relay sees only opaque blobs
- **Encrypted vault** — generated images are stored as encrypted blobs; the decryption key is held by you and wrapped with your biometric/passkey or password; the server has no access to your content
- **Three distinct access paths:**
  - **Google account** — full account with quota tracking, vault, gallery, and ToS acceptance flow; suited for trusted users who will use the tool regularly
  - **E-mail / password** — full account (same features as Google); argon2id hashing; requires invite code by default (`INVITE_REQUIRED=true`); ToS and data-notice acceptance enforced at registration
  - **Access code** — no account, no sign-up, no Google required; paste a code and generate; suited for sharing with less technical friends or one-off access
- **Per-user quotas** — admin-configurable job limits per account
- **Admin panel** — manage users, issue and revoke access codes, adjust quotas
- **WebAuthn / biometric vault unlock** — vault unlocked with passkey, fingerprint, or password; no master password typed in plaintext
- **Single-reference and multi-reference image generation** — Flux 2 Klein 9B GGUF workflow with model and quantization selection

---

## Privacy

- **Relay:** receives only encrypted blobs for prompts, reference images, and full results; it cannot read that content even under compulsion
- **Vault:** encrypted blobs stored server-side; your key never leaves your device; a lawful data request produces ciphertext the server cannot decrypt
- **Gallery previews:** saved results include a trusted 200 px WebP thumbnail generated by the PC; the relay may see it transiently during live delivery, but the browser encrypts it with the vault master key before storage — it is never kept server-side in plaintext
- **ComfyUI:** ComfyLink configures it with hardening flags (`--disable-metadata`, `--database-url sqlite:///:memory:`, `--verbose CRITICAL`) to reduce data retention; ComfyUI is a third-party component running on the deployer's machine — we don't control its internals
- **pc-client:** deletes each prompt from ComfyUI's in-memory history immediately after the result image is downloaded; every generated PNG receives embedded `AI_Generated: yes` metadata (ČTÚ AI Act compliance)
- **Audit log:** each job submission records IP address, timestamp, job ID, and identity (Google sub + email for Google users; code ID for access-code users) — no image content ever enters the log; entries are automatically deleted after 6 months

Full detail, the deployer legal position on compelled decryption, and a plaintext metadata audit → [docs/PRIVACY.md](docs/PRIVACY.md)

---

## Repo Structure

```
Flux2-9B-Klein-Remote/
├── .env.example          ← copy to .env and fill in values
├── .github/workflows/    ← GitHub Actions: auto-deploy on push to main
├── ComfyUI-Workflow/     ← visual workflow + model/node docs
├── Caddyfile             ← reverse proxy / TLS config
├── docker-compose.yml    ← VPS orchestration (server + Caddy)
├── docs/                 ← extended documentation
├── client/               ← Svelte frontend (browser-facing)
├── server/               ← Node.js/Express relay + WebSocket broker
└── pc-client/            ← Python bridge: connects relay → ComfyUI
```

---

## Terms of Service

All users — Google-authenticated, e-mail/password, or access code — are subject to the Terms of Service. Full text and legal framework (Czech Civil Code, GDPR, AI Act) → [docs/TOS.md](docs/TOS.md)

---

## License

MIT — see [LICENSE](LICENSE).
