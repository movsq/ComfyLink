# Architecture

[← Back to README](../README.md)

## System overview

```
[Phone browser] ──── WSS encrypted ────▶ [VPS relay] ──── WSS encrypted ────▶ [PC + ComfyUI]
```

The relay is **intentionally blind** — it only forwards opaque encrypted blobs. No prompts, images, results, or thumbnails are visible to it at any point. What it does see is metadata: who submitted, when, from which IP, and per-job progress counters (step `value`/`max` and the ComfyUI node id) — see [PRIVACY.md](PRIVACY.md).

---

## Workflow formats

The ComfyUI workflow exists in two formats:

| File | Format | Purpose |
|------|--------|---------|
| `ComfyUI-Workflow/Flux2_Klein_9B_GGUF_ONLINE.json` | ComfyUI graph format | Visual reference for the ComfyUI editor (nodes, links, positions, UI metadata) |
| `pc-client/workflow_template.json` | ComfyUI API format | Template submitted to ComfyUI's `/prompt` endpoint at runtime |

### What the pc-client does per job

1. Loads `workflow_template.json` once at startup
2. Deep-copies it per job, injecting job parameters (prompt, seed, steps, sampler, lora, lora strength, GGUF quant, CLIP model)
3. Uploads images to ComfyUI via `POST /upload/image`, patches filenames into `LoadImage` nodes
4. Prunes unused nodes based on image count (0, 1, or 2) and whether a LoRA is active
5. POSTs the assembled workflow to ComfyUI's `/prompt` API
6. Monitors progress via ComfyUI's WebSocket, then downloads the output image via `/view`
7. Deletes the prompt from ComfyUI's in-memory history via `POST /history {"delete": [prompt_id]}`

See [ComfyUI-Workflow/README.md](../ComfyUI-Workflow/README.md) for the full node map and customisation instructions.

---

## Job queue

The server maintains an in-memory FIFO queue so multiple jobs can be submitted while the PC processes them one at a time.

### Lifecycle

1. Job submitted → enters queue as **pending**
2. If PC is connected and idle, the server dispatches the next pending job immediately
3. On completion (or error/cancel), the server dispatches the next pending job. If the PC disconnects while a job is `processing`, that job is reset to `pending` and re-dispatched when the PC reconnects.
4. Every state change broadcasts a `queue_update` to all connected phone sockets

### Limits

| Rule | Value |
|------|-------|
| Max queued jobs per user | **3** (configurable via `MAX_QUEUE_PER_USER` in `server/src/index.js`) |
| Queue storage | In-memory — lost on server restart |

Submitting beyond the limit returns `{ type: "error", message: "queue_full" }`.

### Queue UI

**Live queue panel** (scrollable, ~6 rows):
- Position in queue (1, 2, 3 ...)
- Status badge — `PROCESSING` (with progress %) or `WAITING`
- Estimated wait time — rolling average of the last 10 job durations
- Cancel button — users cancel only their own jobs

**COMPLETED section** (fixed, below live queue):
When a result modal is closed without discarding, the finished job appears as a compact bar showing a thumbnail, scrolling prompt text, and a `MM:SS` countdown (auto-expires after 2 minutes). Clicking it reopens the full result modal.

The submit button shows the slot count: **ADD TO QUEUE (x/3)**; disabled at limit: **QUEUED JOBS (3/3)**.

### `queue_update` message shape

Every connected phone socket receives the aggregate fields. Only the socket that owns jobs additionally receives `queue` and `activeJobId`, so one user never learns another user's job ids.

```json
{
  "type": "queue_update",
  "queueSize": 2,
  "avgDuration": 45,
  "maxQueuePerUser": 3,
  "queue": [
    { "jobId": "...", "position": 1, "status": "processing" },
    { "jobId": "...", "position": 2, "status": "pending" }
  ],
  "activeJobId": "abc123"
}
```

`avgDuration` is the rolling average in seconds of the last 10 jobs, measured from submit to completion (so it includes queue wait), defaulting to 60. `maxQueuePerUser` mirrors `MAX_QUEUE_PER_USER` so the UI slot counter follows the server setting.

---

## Security & crypto

The relay is a **blind relay** — it cannot read job payloads or results.

### Job encryption (phone → PC)

| Layer | Algorithm |
|-------|-----------|
| Key exchange | ECDH P-256 (chosen over X25519 for consistent mobile browser support) |
| Key derivation | HKDF-SHA-256, 32-byte zero salt, two keys per job split by direction: `info = "flux2-klein-v1:job"` (phone → PC) and `info = "flux2-klein-v1:result"` (PC → phone) |
| Symmetric encryption | AES-256-GCM |

**Per-job key separation:** The phone generates a fresh ephemeral keypair for every job, so compromising one job's session key exposes only that job. This is one-sided ephemeral ECDH against the PC's long-lived static key, so it is *not* full forward secrecy: an adversary who records relay traffic and later obtains `private_key.pem` can decrypt every recorded job. Keep that key off shared or synced storage (`keygen.py` warns about this).

**Wire format (job payload):** `[2-byte key length][ephemeral SPKI pubkey][12-byte IV][ciphertext]`

**Wire format (result payload):** `[12-byte IV][ciphertext]`

**Wire format (result thumbnail):** same `[12-byte IV][ciphertext]` envelope under the same result key with its own IV; carried in the `thumbnail` field of the `result` message.

### Vault encryption (client-side)

| Layer | Algorithm | Details |
|-------|-----------|---------|
| Master key | Random 256-bit | Generated in browser, never sent in plaintext |
| Biometric wrapping | WebAuthn PRF + HKDF-SHA-256 → AES-KW | PRF salt stored server-side |
| Password wrapping | PBKDF2-SHA-256 (600 000 iter) → AES-KW | PBKDF2 salt stored server-side |
| Recovery wrapping | HKDF-SHA-256 (`info = "vault-recovery-v1"`) → AES-KW | Random 256-bit recovery key encoded as 24 BIP-39 words (256 bits + 8-bit checksum) |
| Result encryption | AES-256-GCM | IV stored alongside ciphertext; master key used directly |

### PC secret verification

The server compares `PC_SECRET` using **constant-time comparison** (`timingSafeEqual`) to prevent timing attacks.

### Worker key pinning (dual-layer)

PC key pinning prevents a compromised relay from substituting a different worker key (MITM). Two independent layers enforce the same SHA-256 fingerprint printed by `pc-client/keygen.py`:

| Layer | Variable | Enforcement |
|-------|----------|-------------|
| **Server-side** | `PC_PUBLIC_KEY_FINGERPRINT` | Server hashes the `pubkey` message from `/ws/pc` and rejects the connection (close 4003) if it doesn't match. **Required** when `DEPLOY_MODE=remote`; optional in local mode. Comparison uses `timingSafeEqual`. |
| **Client-side** | `VITE_PC_KEY_FINGERPRINT` | Build-time constant baked into the Svelte client. `crypto.js` computes SHA-256 of the PC's SPKI DER public key and throws **before encrypting** if it doesn't match the pinned value. Prevents the browser from encrypting to a substituted key even if the relay accepted it. |

Both variables take the same 64-character hex digest (colons are stripped automatically on both sides).
