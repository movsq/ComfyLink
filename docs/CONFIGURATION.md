# Configuration

[← Back to README](../README.md)

All configuration lives in a single root `.env`. Copy `.env.example` to `.env` to get started.

> **Generate random secrets:**
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PC_SECRET` | *(required)* | Shared secret authenticating the PC to the relay. Use a long random string. |
| `JWT_SECRET` | *(required)* | Secret for signing session JWTs. |
| `GOOGLE_CLIENT_ID` | *(unset)* | Google OAuth 2.0 Client ID for user login. When unset, Google login is **disabled**: `POST /auth/google` and Google step-up return `503 google_login_disabled`. The server never verifies an ID token without an audience. |
| `VITE_GOOGLE_CLIENT_ID` | *(unset)* | Same value as `GOOGLE_CLIENT_ID`; only needed when Google login is enabled. |
| `DEPLOY_MODE` | `local` | Read by **both** the pc-client and the server. For the pc-client it says where the relay lives: `local` (same machine — connects to `localhost`) or `remote` (connects to `FLUX_KLEIN_HOST` over WSS). For the server it selects the production guards: in `remote` mode `ALLOWED_ORIGINS` and `PC_PUBLIC_KEY_FINGERPRINT` are **required** (the server refuses to start without them) and CORS, WebSocket origin checks and PC public-key pinning are enforced; in `local` mode all three are relaxed and the server logs a startup warning naming each disabled check. Use `remote` for anything reachable beyond the host machine, Tailscale included. |
| `FLUX_KLEIN_HOST` | — | Public hostname serving the app — a domain name or Tailscale MagicDNS hostname. Used by the pc-client when `DEPLOY_MODE=remote`, and by Caddy for the TLS cert. Must be a hostname, not a raw LAN IP. |
| `VPS_URL` | — | Direct WebSocket URL for the relay (e.g. `wss://yourdomain.com`); overrides `DEPLOY_MODE` + `FLUX_KLEIN_HOST` when set. |
| `NODE_ENV` | *(unset)* | Set to `production` on any real deployment so Express installs its production error handler and unhandled route errors stop returning stack traces. Already set by `server/Dockerfile` and `docker-compose.yml`; only set it yourself when running the relay outside Docker. |
| `PORT` | `3000` | Port the Node.js relay listens on. |
| `SESSION_TTL_MS` | `86400000` | Phone session lifetime in ms (default: 24 h). |
| `BEHIND_PROXY` | `false` | Set to `true` when the relay is behind Caddy/nginx so IP-based rate limits trust `X-Forwarded-For`. |
| `MAX_RESULTS_PER_USER` | `500` | Maximum number of stored encrypted results per user. |
| `MAX_TOTAL_QUEUE_DEPTH` | `50` | Global active queue cap across all users. |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | URL of the local ComfyUI instance — port must match **Settings → Server-Config → Port** in ComfyUI. |
| `GGUF_MODEL` | `flux-2-klein-9b-Q4_K_M.gguf` | Default diffusion model used when none is sent by the client. |
| `DB_PATH` | `<repo-root>/data/comfylink.db` | Path to the SQLite database file (server). Resolved relative to `server/src` when not set; the built-in default points to `data/comfylink.db` at the repo root. |
| `SKIP_TLS_VERIFY` | `false` | Skip TLS verification (use only for Tailscale / self-signed certs). |
| `COMFYUI_INPUT_DIR` | *(unset)* | ComfyUI's `input/` directory. The pc-client deletes each job's own uploaded reference images from it when the job ends (any exit path). If unset, `COMFYUI_PATH/input` is used when it exists; otherwise cleanup is skipped and decrypted reference images stay on the GPU machine in plaintext (warned once at startup). |
| `COMFYUI_PATH` | *(unset)* | Path to the ComfyUI checkout. Only used to derive `COMFYUI_INPUT_DIR` when that is not set explicitly. |
| `ALLOWED_GGUF` | the 6 diffusion models the client dropdown offers, plus `flux-2-klein-9b-Q8_0.gguf` | Comma-separated allow-list of diffusion model filenames a client may request. Job payloads are end-to-end encrypted, so the pc-client is the only place this can be enforced. |
| `ALLOWED_CLIP` | `Qwen_Qwen3-8B-Q4_K_M.gguf,Qwen3-8B-Q4_K_M.gguf,Qwen3-8B-Q4_K_M_v2.gguf` | Comma-separated allow-list of CLIP model filenames a client may request. |
| `ALLOWED_LORA` | `lora1.safetensors,lora2.safetensors` | Comma-separated allow-list of LoRA filenames a client may request (`none` always means no LoRA). |
| `PRIVATE_KEY_PATH` | `private_key.pem` | Path to the PC's private key PEM (typically `pc-client/private_key.pem` when launching from repo root). |
| `PUBLIC_KEY_PATH` | `public_key.pem` | Path to the PC's public key PEM (typically `pc-client/public_key.pem` when launching from repo root). |
| `PC_PUBLIC_KEY_FINGERPRINT` | *(unset)* | SHA-256 hex fingerprint of the PC public key (from `keygen.py`). **Required** when `DEPLOY_MODE=remote`; optional in local mode. When set, the server rejects mismatched `pubkey` messages from `/ws/pc`. |
| `VITE_PC_KEY_FINGERPRINT` | *(unset)* | Same fingerprint as `PC_PUBLIC_KEY_FINGERPRINT`, exposed to the Svelte client at build time. The browser verifies the PC public key before encrypting — throws if mismatched. |
| `RECONNECT_DELAY` | `5` | Seconds between reconnect attempts (pc-client). |
| `CLIENT_DIST_PATH` | *(auto)* | Override path to the built Svelte frontend served by the Node.js server. |
| `ALLOWED_ORIGINS` | *(unset)* | Comma-separated list of allowed CORS origins. **Required in production** — if unset, all origins are allowed (dev only). |
| `ACCESS_CODES_ENABLED` | `true` | Set to `false` to disable access-code login entirely. Existing codes and the admin code-management UI remain fully functional — you can still create, edit, and delete codes while the feature is off. Users currently logged in via a code are kicked within 60 s. The login button disappears from the frontend and `POST /auth/code` returns `403`. |
| `INVITE_REQUIRED` | `true` | Require an invite code (`KLEIN-XXXX-XXXX`) for all new registrations (Google OAuth and e-mail/password). Defaults to `true` when unset — invite-only registration is on by default. Set to `false` to allow open registration. Existing users are unaffected. |
| `VPS_USER` | `root` | SSH username for manual deployments. |
| `VPS_SSH_HOST` | — | SSH address of the VPS for manual deployments. |
| `VPS_PATH` | `/root/flux2-9b-klein-remote` | Deployment path for manual deployments. |

> **`VPS_SSH_HOST` vs `VPS_HOST`.** They are two different settings despite the near-identical names. `VPS_SSH_HOST` is an `.env` variable used only by *manual* deploys from your own machine. `VPS_HOST` is a **GitHub Actions repository secret** read by `.github/workflows/deploy.yml`; it never appears in `.env`. They usually hold the same address, but setting one does nothing for the other.

---

## CI secrets

Repository secrets read by `.github/workflows/deploy.yml` (Settings → Secrets and variables → Actions). These live only in GitHub, never in `.env`.

| Secret | Description |
|--------|-------------|
| `VPS_HOST` | SSH-reachable address of the VPS (IP or hostname). |
| `VPS_USER` | SSH username on the VPS (e.g. `root`). |
| `SSH_PRIVATE_KEY` | Private SSH key authorised to log in to the VPS. |
| `VPS_PATH` | Deployment directory on the VPS. |
| `VPS_FINGERPRINT` | SHA256 host-key fingerprint of the VPS, pinned on every SSH/SCP step. Obtain with `ssh-keyscan -t ed25519 HOST \| ssh-keygen -lf -` and copy the `SHA256:…` field. Without it the runner — which is ephemeral, so every deploy is a first connection — accepts whatever host key answers. |
| `VITE_GOOGLE_CLIENT_ID` | Same value as `GOOGLE_CLIENT_ID` in the VPS `.env`; inlined into the bundle at build time. |
| `VITE_PC_KEY_FINGERPRINT` | Same value as `PC_PUBLIC_KEY_FINGERPRINT`; inlined into the bundle at build time. |
