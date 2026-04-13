# API Reference

[← Back to README](../README.md)

All WebSocket message payloads are JSON. The `payload` field is a base64 binary blob the server never decrypts.

---

## REST API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/google` | — | Exchange Google ID token (+ optional invite code) for JWT |
| `GET` | `/auth/me` | JWT | Return current user info |
| `POST` | `/auth/tos` | active | Record current Terms of Service acceptance |
| `POST` | `/auth/code` | — | Exchange a `job_access` invite code for a limited JWT. Returns `403` when `ACCESS_CODES_ENABLED=false`. |
| `POST` | `/auth/register` | — | Create an email/password account; may require a registration invite code |
| `POST` | `/auth/login/email` | — | Authenticate an email/password account |
| `POST` | `/auth/logout` | JWT | Revoke the current JWT |
| `GET` | `/tos` | — | Public Terms of Service payload `{ version, en, cz }` |
| `GET` | `/config` | — | Public feature flags consumed by the frontend: `{ accessCodesEnabled: bool, inviteRequired: bool }` |
| `GET` | `/pc-pubkey` | active/code | Get the PC's cached public key for job encryption |
| `GET` | `/health` | — | Liveness check |
| `POST` | `/codes` | admin | Create an invite code |
| `GET` | `/codes` | admin | List codes created by this admin |
| `DELETE` | `/codes/:id` | admin | Revoke an invite code |
| `PATCH` | `/codes/:id` | admin | Edit code uses remaining or expiry |
| `GET` | `/admin/users` | admin | List all users (filterable by status), includes `usesRemaining` per user |
| `PATCH` | `/admin/users/:id` | admin | Change a user's `status` (`active`/`suspended`) and/or `usesRemaining` (`null`=unlimited, 0–999999) |
| `POST` | `/vault/setup` | active | Initialise vault with wrapped key blobs |
| `GET` | `/vault/info` | active | Get vault configuration and salts |
| `POST` | `/vault/unlock` | active | Retrieve a wrapped master key blob |
| `POST` | `/vault/rekey` | active | Replace wrapped key blobs |
| `DELETE` | `/vault` | active | Delete vault and all stored results |
| `POST` | `/results` | active | Store an encrypted result (max 20 MB) with optional encrypted thumbnail |
| `GET` | `/results` | active | List results with thumbnails (paginated) |
| `GET` | `/results/:id` | active | Get full encrypted result |
| `GET` | `/results/:id/thumb` | active | Get encrypted thumbnail blob `{ encryptedThumb, ivThumb }` for client-side decryption |
| `DELETE` | `/results/:id` | active | Delete a stored result |

---

## WebSocket: PC ↔ Server (`/ws/pc`)

| Direction | Message |
|-----------|---------|
| PC → Server | `{ type: "auth", secret: "..." }` — first message after connecting |
| Server → PC | `{ type: "auth_ok" }` |
| PC → Server | `{ type: "pubkey", publicKey: "<b64 SPKI>" }` — once after auth |
| Server → PC | `{ type: "job", jobId: "...", payload: "<b64>" }` |
| PC → Server | `{ type: "progress", jobId: "...", value: N, max: M, node: "..." }` |
| PC → Server | `{ type: "result", jobId: "...", payload: "<b64>", thumbnail?: "<b64 webp>" }` — server validates and relays thumbnail to browser; browser encrypts before saving |
| PC → Server | `{ type: "error", jobId: "...", message: "..." }` |
| Server → PC | `{ type: "cancel", jobId: "..." }` |

---

## WebSocket: Phone ↔ Server (`/ws/phone`)

Authentication uses a **first-message handshake** — the JWT is never sent in the URL query string (which would expose it to proxy access logs).  The server closes unauthenticated sockets after **2 seconds**.

| Direction | Message |
|-----------|---------|
| Phone → Server | `{ type: "auth", token: "<jwt>" }` — **must be the very first message** |
| Server → Phone | `{ type: "auth_ok" }` — connection accepted; all subsequent messages are processed |
| Server → Phone | `{ type: "auth_failed", reason: "..." }` — followed immediately by close |
| Phone → Server | `{ type: "submit", payload: "<b64>" }` |
| Server → Phone | `{ type: "queued", jobId: "..." }` |
| Server → Phone | `{ type: "queue_update", queueSize, avgDuration, maxQueuePerUser, queue?: [...], activeJobId?: "..." }` — broadcast on every queue change; `queue` and `activeJobId` are included only for the socket that owns those jobs; all other sockets receive aggregate counts only |
| Server → Phone | `{ type: "job_recovery", jobs: [...] }` — sent on reconnect for recoverable non-code-user jobs |
| Server → Phone | `{ type: "no_pc" }` — PC not connected |
| Server → Phone | `{ type: "progress", jobId: "...", value: N, max: M, node: "..." }` — sent only to the job-owner socket |
| Server → Phone | `{ type: "progress", value: N, max: M }` — sent to all other connected sockets (no job identifier) |
| Server → Phone | `{ type: "result", jobId: "...", payload: "<b64>", thumbnail?: "<b64 webp>" }` — sent only to the job-owner socket; thumbnail is the raw WebP for client-side encryption before saving |
| Server → Phone | `{ type: "error", jobId: "...", message: "..." }` |
| Server → Phone | `{ type: "error", message: "queue_full" }` — user already has 3 jobs queued |
| Server → Phone | `{ type: "session_invalid", reason: "..." }` — session became invalid after connect |
| Phone → Server | `{ type: "cancel", jobId: "..." }` — only succeeds for jobs owned by this session |
| Server → Phone | `{ type: "code_status", usesRemaining: N\|null }` — code_user sessions only |
| Server → Phone | `{ type: "uses_updated", usesRemaining: N\|null }` — Google user quota changed |
| Phone → Server | `{ type: "ping" }` — application-level keepalive (sent every 20 s) |
| Server → Phone | `{ type: "pong" }` — keepalive reply |

---

## WebSocket: Admin ↔ Server (`/ws/admin`)

Authentication uses the same **first-message handshake** pattern as the phone socket.

| Direction | Message |
|-----------|---------|
| Admin → Server | `{ type: "auth", token: "<jwt>" }` — **must be the first message** |
| Server → Admin | `{ type: "auth_ok" }` |
| Server → Admin | `{ type: "auth_failed" }` — followed by close |
| Server → Admin | `{ type: "codes_changed" }` — invite code list changed |
| Server → Admin | `{ type: "users_changed" }` — user list changed |
