# Architecture

[← Back to README](../README.md)

## System overview

```
[Phone browser] ──── WSS encrypted ────▶ [VPS relay] ──── WSS encrypted ────▶ [PC + ComfyUI]
```

The relay is **intentionally blind** — it only forwards opaque encrypted blobs. No prompts, images, or results are visible to it at any point.

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
3. On completion (or error/cancel), the server dispatches the next pending job
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

```json
{
  "type": "queue_update",
  "queue": [
    { "jobId": "...", "position": 1, "status": "processing", "isYours": true },
    { "jobId": "...", "position": 2, "status": "pending",    "isYours": false }
  ],
  "activeJobId": "abc123",
  "avgDuration": 45
}
```

`isYours` is set per-recipient. `avgDuration` is the rolling average in seconds (defaults to 60).

---

## Security & crypto

The relay is a **blind relay** — it cannot read job payloads or results.

### Job encryption (phone → PC)

| Layer | Algorithm |
|-------|-----------|
| Key exchange | ECDH P-256 (chosen over X25519 for consistent mobile browser support) |
| Key derivation | HKDF-SHA-256 (`info = "flux2-klein-v1"`) |
| Symmetric encryption | AES-256-GCM |

**Per-job forward secrecy:** The phone generates a fresh ephemeral keypair for every job. Past jobs remain protected even if a session key is later compromised.

**Wire format (job payload):** `[2-byte key length][ephemeral SPKI pubkey][12-byte IV][ciphertext]`

**Wire format (result payload):** `[12-byte IV][ciphertext]`

### Vault encryption (client-side)

| Layer | Algorithm | Details |
|-------|-----------|---------|
| Master key | Random 256-bit | Generated in browser, never sent in plaintext |
| Biometric wrapping | WebAuthn PRF + HKDF-SHA-256 → AES-KW | PRF salt stored server-side |
| Password wrapping | PBKDF2-SHA-256 (600 000 iter) → AES-KW | PBKDF2 salt stored server-side |
| Recovery wrapping | Raw AES-KW | Key encoded as 24 BIP-39 words (256 bits + 8-bit checksum) |
| Result encryption | AES-256-GCM | IV stored alongside ciphertext; master key used directly |

### PC secret verification

The server compares `PC_SECRET` using **constant-time comparison** (`timingSafeEqual`) to prevent timing attacks.

### Optional worker key pinning

If `PC_PUBLIC_KEY_FINGERPRINT` is set, the server hashes the `pubkey` message sent by the pc-client and rejects the connection if the fingerprint does not match. This prevents a substituted worker key from being accepted silently.
