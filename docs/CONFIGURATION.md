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
| `GOOGLE_CLIENT_ID` | *(unset)* | Google OAuth 2.0 Client ID for user login. Optional when running e-mail/password-only deployments. |
| `VITE_GOOGLE_CLIENT_ID` | *(unset)* | Same value as `GOOGLE_CLIENT_ID`; only needed when Google login is enabled. |
| `DEPLOY_MODE` | `local` | `local` (connect to localhost) or `remote` (connect to `FLUX_KLEIN_HOST`). |
| `FLUX_KLEIN_HOST` | — | Hostname serving the app in remote mode (for example a public domain or Tailscale MagicDNS hostname). Use a hostname, not a raw LAN IP. |
| `VPS_URL` | — | Direct WebSocket URL for the relay (e.g. `wss://yourdomain.com`); overrides `DEPLOY_MODE` + `FLUX_KLEIN_HOST` when set. |
| `PORT` | `3000` | Port the Node.js relay listens on. |
| `SESSION_TTL_MS` | `86400000` | Phone session lifetime in ms (default: 24 h). |
| `BEHIND_PROXY` | `false` | Set to `true` when the relay is behind Caddy/nginx so IP-based rate limits trust `X-Forwarded-For`. |
| `MAX_RESULTS_PER_USER` | `500` | Maximum number of stored encrypted results per user. |
| `MAX_TOTAL_QUEUE_DEPTH` | `50` | Global active queue cap across all users. |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | URL of the local ComfyUI instance — port must match **Settings → Server-Config → Port** in ComfyUI. |
| `GGUF_MODEL` | `flux-2-klein-9b-Q4_K_M.gguf` | Default diffusion model used when none is sent by the client. |
| `DB_PATH` | `<repo-root>/data/comfylink.db` | Path to the SQLite database file (server). Resolved relative to `server/src` when not set; the built-in default points to `data/comfylink.db` at the repo root. |
| `SKIP_TLS_VERIFY` | `false` | Skip TLS verification (use only for Tailscale / self-signed certs). |
| `PRIVATE_KEY_PATH` | `private_key.pem` | Path to the PC's private key PEM. When launching from repo root, the setup wizard writes `pc-client/private_key.pem`. |
| `PUBLIC_KEY_PATH` | `public_key.pem` | Path to the PC's public key PEM. When launching from repo root, the setup wizard writes `pc-client/public_key.pem`. |
| `PC_PUBLIC_KEY_FINGERPRINT` | *(unset)* | Optional SHA-256 hex fingerprint of the PC public key. When set, the server rejects mismatched `pubkey` messages from `/ws/pc`. |
| `RECONNECT_DELAY` | `5` | Seconds between reconnect attempts (pc-client). |
| `CLIENT_DIST_PATH` | *(auto)* | Override path to the built Svelte frontend served by the Node.js server. |
| `ALLOWED_ORIGINS` | *(unset)* | Comma-separated list of allowed CORS origins. **Required in production** — if unset, all origins are allowed (dev only). |
| `ACCESS_CODES_ENABLED` | `true` | Set to `false` to disable access-code login entirely. Existing codes and the admin code-management UI remain fully functional — you can still create, edit, and delete codes while the feature is off. Users currently logged in via a code are kicked within 60 s. The login button disappears from the frontend and `POST /auth/code` returns `403`. |
| `INVITE_REQUIRED` | `true` | Require an invite code (`KLEIN-XXXX-XXXX`) for all new registrations (Google OAuth and e-mail/password). Defaults to `true` when unset — invite-only registration is on by default. Set to `false` to allow open registration. Existing users are unaffected. |
| `VPS_USER` | `root` | SSH username for manual deployments. |
| `VPS_SSH_HOST` | — | SSH address of the VPS for manual deployments. |
| `VPS_PATH` | `/root/flux2-9b-klein-remote` | Deployment path for manual deployments. |
