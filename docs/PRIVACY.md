# Privacy

ComfyLink is designed so that the relay server — the only internet-facing component — is architecturally blind to your content. This page documents what data flows through the system, where it lands, and what the deployer's legal position is.

---

## The privacy chain

### 1. The relay sees only encrypted blobs

Every job submission (prompt text, reference images) is encrypted on-device before it leaves your browser, using ECDH-AES-GCM with a shared secret derived between the browser and the PC. The relay server forwards WebSocket messages without decrypting them. It cannot read your prompts or results even if compelled to try.

### 2. Your vault — the relay holds ciphertext, not content

Completed results are stored in the relay's database as encrypted blobs. The master key that decrypts them is held entirely by you: it is wrapped using your biometric/passkey, password, or recovery phrase and never transmitted to the server in usable form.

This applies to gallery thumbnails as well. The PC generates a 200 px WebP thumbnail alongside the full image and encrypts it with the same per-job result key before it leaves the PC, so the relay forwards it as ciphertext exactly like the full image. The browser decrypts it, then re-encrypts it with your vault master key before uploading — the same AES-256-GCM envelope used for full images. The relay stores only the encrypted blob and hands it back when you open the gallery; your browser decrypts it locally. Thumbnails are never visible to the relay, in transit or at rest.

A data access request under GDPR Article 15 would receive those blobs — meaningless without your key. For erasure requests under Article 17, deleting the blobs from the database satisfies the request in full, because no plaintext was ever stored server-side.

**Deployer note:** You cannot be compelled to decrypt vault contents you do not hold keys for. What you hold is ciphertext. Handing it over satisfies a lawful order; decryption remains technically impossible without the user's key. This is the same legal position used by Signal and ProtonMail — compliance without exposure.

### 3. ComfyUI is a third-party component

The PC running ComfyUI is the deployer's own machine. ComfyLink configures ComfyUI with hardening flags intended to reduce data retention:

```
python main.py --disable-metadata --database-url sqlite:///:memory: --verbose CRITICAL --dont-print-server
```

- `--disable-metadata` — suppresses embedding prompt JSON in output PNG files
- `--database-url sqlite:///:memory:` — keeps job history in RAM; nothing is written to `user/comfyui.db`
- `--verbose CRITICAL` — silences all non-fatal log output

ComfyUI is third-party software running on the deployer's machine. ComfyLink applies these flags as a reasonable hardening measure but makes no representation about ComfyUI's internal behavior, what it may write transiently, or how future versions may change. Responsibility for the ComfyUI process rests with the person who set it up.

The pc-client additionally deletes each prompt from ComfyUI's in-memory history immediately after the result image is downloaded, and removes the decrypted reference images it uploaded to ComfyUI's `input/` directory once the job ends (success or failure). That cleanup needs `COMFYUI_INPUT_DIR` to point at the directory; if it is unset, the reference images stay on the PC's disk and the pc-client warns about it at startup — see [CONFIGURATION.md](CONFIGURATION.md).

What the relay *does* learn about a job in flight is its progress: the pc-client reports step `value`/`max` and the ComfyUI node id in the clear so the queue UI can show a progress bar. This reveals the step count and roughly how long a job takes, never the prompt or the image.

### 4. Plaintext metadata

The relay server does store some plaintext metadata per user account: email address (Google-authenticated and email/password users), the Google subject id, display name and profile-picture URL for Google accounts, `tos_accepted_at`, `tos_version`, quota counters, invite codes an admin has issued, and job submission timestamps. IP addresses are stored in the audit log (below) and, briefly, in two brute-force counters for failed access-code and email logins (5- and 15-minute windows, pruned every 5 minutes). This is real personal data subject to GDPR access and erasure requests.

For erasure, `DELETE /admin/users/:id` removes the user row together with their stored results, vault keys, email credentials, issued invite codes, and audit-log rows in a single transaction. Users can also delete their own vault contents at any time via `DELETE /vault`.

Prompt content, reference images, and full vault blobs are never stored in plaintext.

---

## Server-side logging

The relay server logs only what is necessary for operation. Prompt content and image data are never logged.

### Audit log

Every job submission is recorded in `job_audit_log` with: job ID, user type (`google`, `email`, or `code`), user ID, email, code ID, IP address, and timestamp. No encrypted payloads or image blobs are stored. Entries are **automatically deleted after 6 months** (pruned daily). This log supports compliance obligations under the AI Act and GDPR while minimising data retention.

---

## Data summary

| What | Where it lives | Who can read it |
|------|----------------|-----------------|
| Prompt text | Encrypted in transit; never stored on relay | Only the PC decrypts it |
| Reference images | Encrypted in transit; never stored on relay | Only the PC decrypts it |
| Gallery thumbnail | Encrypted in transit (per-job result key); encrypted blob in relay DB (vault master key) | Only the user |
| Generated images (in-session) | Plaintext on the PC during generation; ciphertext on the relay while relaying | The PC processes it; the user decrypts the delivered payload |
| Reference images on the PC | Plaintext in ComfyUI's `input/` for the duration of the job, then deleted (requires `COMFYUI_INPUT_DIR`) | The PC owner |
| Job progress (step counts, node id) | Plaintext, relayed live, not stored | Relay operator, other connected users (aggregate only) |
| Vault results | Encrypted blobs in relay DB | Only the user (via vault master key) |
| User email / timestamps | Plaintext in relay DB | Deployer / admin |
| ComfyUI job history | In-memory only (RAM); deleted after download | Not persisted |
