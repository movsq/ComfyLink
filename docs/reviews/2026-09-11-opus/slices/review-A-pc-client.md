# Review A — `pc-client/` (security & correctness)

**Verdict.** The cryptographic core of the pc-client is sound and matches the browser side exactly: P-256 ECDH, HKDF-SHA-256 with a zero salt and direction-split `info` strings, AES-256-GCM with a fresh `os.urandom(12)` IV per result, and a wire format byte-for-byte compatible with `client/src/lib/crypto.js`. I found no key reuse, no nonce reuse, and no plaintext prompt or reference image leaving the PC. The workflow-pruning logic is correct against the current `workflow_template.json` — every node id the code touches exists and every input key it sets is present, in all three image-count modes and both LoRA branches. The one substantive privacy finding is the **unencrypted 200 px WebP thumbnail** that `main.py` sends alongside the encrypted result: it is a recognisable rendition of the generated image, the relay parses it, and the relay holds it in RAM until the phone acknowledges — possibly for a long time. `docs/PRIVACY.md` and `docs/VAULT.md` disclose this honestly; `README.md` and `docs/ARCHITECTURE.md` do not, and state the opposite. Beyond that: decrypted reference images are written to ComfyUI's `input/` directory and never deleted, model/LoRA/CLIP filenames from the payload are only screened for path separators rather than allowlisted, the mock-ComfyUI fallback documented in `SETUP.md` cannot actually be used, and the client's default GGUF quantization is not among the files `ComfyUI-Workflow/README.md` tells you to download.

---

## Findings

### 1. High — Result thumbnail is sent to the relay in plaintext, contradicting README and ARCHITECTURE

**Files:** `/home/fixed/ComfyLink/pc-client/main.py:183-200`, `/home/fixed/ComfyLink/pc-client/comfyui.py:271-283`

```python
# main.py:184-200
thumbnail_b64: str | None = None
try:
    loop = asyncio.get_event_loop()
    thumb_bytes = await loop.run_in_executor(None, generate_thumbnail, result_bytes)
    thumbnail_b64 = base64.b64encode(thumb_bytes).decode()
...
encrypted_result = encrypt_result(result_aes_key, result_bytes)
result_msg: dict = {"type": "result", "jobId": job_id, "payload": encrypted_result}
if thumbnail_b64:
    result_msg["thumbnail"] = thumbnail_b64
await ws.send(json.dumps(result_msg))
```

`generate_thumbnail` (`comfyui.py:271-283`) produces a 200 px-wide, quality-75 WebP of the finished image. It is base64'd and attached to the result message **outside** the AES-GCM envelope. Only `payload` is encrypted.

**CONFIRMED by reading** (cross-checked in the server, which other reviewers own, purely to establish what happens to the field):
- `server/src/index.js:1488-1506` parses the base64, buffers it, and checks the RIFF/WEBP magic before relaying. The inline comment at `server/src/index.js:1490` says *"We validate format here but never store it"* — that is not accurate.
- `server/src/index.js:1512` calls `completeJob(msg.jobId, msg.payload, relayedThumbnail)`, and `server/src/jobs.js:59-64` assigns `job.thumbnail = thumbnail ?? null` into the in-memory job record. The job is only deleted once the phone's socket acknowledges delivery (`server/src/index.js:1516-1520`); if the phone is offline the record persists and is replayed later (`server/src/index.js:1685`). So the plaintext image lives in relay RAM for an unbounded period, not "transiently".

**Failure scenario.** A relay operator, or anyone who obtains a core dump / RAM snapshot / stdout of the relay process, can recover a legible 200 px version of every generated image. A user who read only `README.md` ("the relay forwards encrypted blobs it cannot read", `README.md:5`; "the relay only ever holds opaque blobs", `README.md:72`; gallery thumbnails = "Encrypted blob", `README.md:90`) or `docs/ARCHITECTURE.md:11` ("No prompts, images, or results are visible to it at any point") would not expect this. `docs/PRIVACY.md:17` and `docs/VAULT.md:41` do disclose it.

**Suggested fix.** Encrypt the thumbnail with the same `result_aes_key` under a second, independently generated 12-byte IV and ship it as its own `[IV][ciphertext]` blob (`encode_result_payload` already does exactly this shape). GCM with two random 96-bit IVs under one key is fine at this message count. The browser already holds `resultKey` and decrypts the full image, so it can decrypt the thumbnail before vault-wrapping it with no protocol redesign. The server's WebP magic check would move to the browser. If the plaintext hop is instead accepted as a deliberate trade-off, `README.md:5,50,72,90` and `docs/ARCHITECTURE.md:11,91` must be amended to match `docs/PRIVACY.md:17` — the two sets of statements currently cannot both be true.

---

### 2. Medium — Decrypted reference images are written to ComfyUI's `input/` directory and never removed

**File:** `/home/fixed/ComfyLink/pc-client/comfyui.py:225-257`, `:334-347`

```python
# comfyui.py:338-347
if image1:
    ext1 = _detect_extension(image1)
    image1_name = await _upload_image(session, image1, f"{client_id}_1{ext1}")
if image2:
    ext2 = _detect_extension(image2)
    image2_name = await _upload_image(session, image2, f"{client_id}_2{ext2}")
```

**CONFIRMED:** I grepped the whole of `pc-client/` for `unlink` / `remove` / `delete` / cleanup. The only deletion anywhere is `_clear_history` (`comfyui.py:122-132`), which removes the prompt from ComfyUI's *in-memory history* — not the uploaded files. Every reference image a user ever submits accumulates on the PC's disk as `ComfyUI/input/<uuid>_1.png` (or `.jpg` / `.webp`) forever.

**Failure scenario.** `docs/PRIVACY.md:35-37` presents the ComfyUI hardening story entirely in terms of metadata suppression and in-memory history, and the data summary row for reference images (`docs/PRIVACY.md:62`) says only "Encrypted in transit; never stored on relay". Neither tells the deployer that the plaintext of every reference image they and their invited users submit is now a permanent, growing pile on the GPU machine. For a shared-with-friends deployment (the README's stated use case, `README.md:50`) the operator ends up holding other people's plaintext source images indefinitely, which is also a GDPR-relevant retention they haven't been told about. Secondary effect: a disk-fill DoS, since nothing bounds the total.

**Suggested fix.** Delete the uploaded inputs in the same `finally` block that already calls `_clear_history` (`comfyui.py:386-389`). ComfyUI has no delete-input endpoint, so this needs a direct filesystem unlink against a configured `COMFYUI_INPUT_DIR` — restrict it to the exact `f"{client_id}_1{ext}"` / `_2` names the job created so nothing else can be touched. Whatever is chosen, add an explicit row to `docs/PRIVACY.md`'s data summary describing where reference-image plaintext lives on the PC and for how long.

---

### 3. Medium — Model / LoRA / CLIP filenames are screened for traversal but not allowlisted

**File:** `/home/fixed/ComfyLink/pc-client/comfyui.py:46-62`, `:315-319`

```python
# comfyui.py:46-48
# ── Security: allowed values for user-supplied model/sampler fields ────────────
# Reject anything not in these sets to prevent path traversal or injection.
_ALLOWED_SAMPLERS = {"euler", "res_multistep", "heun"}

# comfyui.py:55-62
def _validate_model_filename(name: str | None, label: str) -> None:
    if name is None: return
    if not isinstance(name, str) or not name:
        raise ValueError(f"Invalid {label}: must be a non-empty string")
    if ".." in name or "/" in name or "\\" in name:
        raise ValueError(f"Invalid {label}: path traversal not allowed")
```

The comment promises set-membership checks for "model/sampler fields", but only `sampler` gets one (`comfyui.py:315-316`). `gguf_name`, `clip_model` and `lora` get the traversal screen only (`comfyui.py:317-319`), so any string without `..`, `/` or `\` — including NUL bytes, Windows drive-relative forms like `C:evil.gguf`, or alternate-data-stream syntax `name.gguf:stream` — reaches the workflow verbatim and is POSTed to ComfyUI.

**CONFIRMED:** these three values arrive inside the E2E-encrypted payload (`crypto_utils.py:232-234`), so the relay structurally *cannot* validate them — the pc-client is the only enforcement point under the project's own threat model. The client UI does offer fixed dropdowns (`client/src/components/Submit.svelte:74-90`), but that is a UI convenience, not a control.

**INFERRED, not confirmed:** ComfyUI's own `/prompt` validation normally rejects loader filenames that are not in `folder_paths.get_filename_list(...)`, which would be the practical backstop. I did not read ComfyUI's source (it is not in this repo), so I cannot state how strict it is for the third-party `LoaderGGUFAdvanced` / `ClipLoaderGGUF` / `LoraLoader` nodes in use here.

**Failure scenario.** Any authenticated user of the deployment (invite code holders included) chooses arbitrary model filenames. Worst realistic case is loading an unintended `.gguf`/`.safetensors` from the models tree; a malicious `.safetensors`/pickle already on disk would be the bad case if ComfyUI's list check is weaker than assumed.

**Suggested fix.** Give `gguf_name`, `clip_model` and `lora` real allowlists next to `_ALLOWED_SAMPLERS`, sourced from env vars so operators can extend them (`ALLOWED_GGUF`, `ALLOWED_CLIP`, `ALLOWED_LORA`), and keep the traversal screen as a second layer. As a minimum, add `"\x00" in name` and a `^[A-Za-z0-9._-]+$` character-class check.

---

### 4. Medium — Back-to-back jobs abandon the in-flight ComfyUI generation instead of interrupting it

**File:** `/home/fixed/ComfyLink/pc-client/main.py:113-118`

```python
if msg_type == "job":
    global _job_task
    # Cancel any previous job task before starting a new one
    if _job_task and not _job_task.done():
        _job_task.cancel()
    _job_task = asyncio.create_task(handle_job(ws, msg))
```

Cancelling the Python task does **not** cancel the prompt already queued in ComfyUI — `interrupt_comfyui()` is called only from `handle_cancel` (`main.py:131`), never here. Job N keeps occupying the GPU while job N+1 queues behind it. Job N's result is downloaded by nobody and its output file stays in ComfyUI's temp directory. `_current_job_id` is also overwritten (`main.py:143`), so a subsequent cancel for job N logs *"No matching running job"* (`main.py:135`) and silently does nothing.

**Confirmed good:** the `finally: await _clear_history(...)` at `comfyui.py:386-389` *does* still run during this unwinding, because it is lexically inside the `async with ClientSession()` and `cancel()` is only called once — so the abandoned prompt's history is cleared. Only the GPU time and the temp file leak.

**Failure scenario.** The server queue normally serialises jobs, so this requires a relay that misbehaves or is compromised — which is precisely the threat model the project sets for itself (`docs/PRIVACY.md:3`, "architecturally blind"). A relay that fires jobs in a tight loop turns the PC into an unbounded GPU-thrashing machine; there is no rate limiting at all on the pc-client side.

**Suggested fix.** Before starting the replacement task, `await interrupt_comfyui()` and await the old task's completion with a short timeout — the same sequence `handle_cancel` already uses. Consider also refusing a new `job` message outright while one is in flight, and returning an `error` for it: the pc-client should not rely on the relay to enforce serialisation.

---

### 5. Low — `SETUP.md`'s mock-ComfyUI fallback is broken; `comfyui_mock.py` is stale

**Files:** `/home/fixed/ComfyLink/SETUP.md:111`, `/home/fixed/ComfyLink/pc-client/comfyui_mock.py:32`, `/home/fixed/ComfyLink/pc-client/main.py:28`

> **No GPU?** Edit `pc-client/main.py` to import from `comfyui_mock` instead of `comfyui` — you'll get tinted placeholder images instead of real ones, useful for UI testing. — `SETUP.md:111`

This cannot work. `main.py:28` is `from comfyui import process_job, interrupt_comfyui, generate_thumbnail`; `comfyui_mock.py` defines only `process_job` — the import fails immediately with `ImportError`. Even past that, the mock's signature is `async def process_job(image_bytes: bytes, prompt: str)` (`comfyui_mock.py:32`) while `main.py:165-177` calls it with eleven keyword arguments (`prompt=`, `image1=`, `image2=`, `seed=`, `steps=`, `sampler=`, `progress_callback=`, `lora=`, `lora_strength=`, `gguf_name=`, `clip_model=`) — an instant `TypeError`. The module's own docstring still describes the real integration as future work (`comfyui_mock.py:13-23`), which has been done for some time.

**Suggested fix.** Either update the mock to mirror the current signature and add `interrupt_comfyui` / `generate_thumbnail` stubs, or drop the module and the `SETUP.md` bullet. If it is kept, note that `comfyui_mock.py:44` prints the prompt to stdout (`prompt[:60]!r}`) — acceptable for a local dev stub, but it is the one place in the pc-client that logs prompt text, so it should not become the default path.

---

### 6. Low — `ComfyUI-Workflow/README.md` does not list the GGUF the client defaults to

**Files:** `/home/fixed/ComfyLink/ComfyUI-Workflow/README.md:48-50,53-54`, `/home/fixed/ComfyLink/client/src/components/Submit.svelte:35-36,79-90`

The client's default quantization is `Flux-2-Klein-9B-KV-Q4_K_M.gguf` (`Submit.svelte:35`) and its dropdown offers three `KV` variants (`Submit.svelte:82-84`). None of those appear in `ComfyUI-Workflow/README.md:48`, which lists `flux-2-klein-9b-Q4_K_M / Q5_K_M / Q6_K / Q8_0`. Conversely `Q8_0` is documented (including a VRAM figure at `:54`) but is not selectable in the UI. The CLIP list has the same problem: the README (`:49-50`) documents `Qwen_Qwen3-8B-Q4_K_M.gguf` and `qwen3-8b-q4_k_m.gguf`, while the UI offers `Qwen_Qwen3-8B-Q4_K_M.gguf`, `Qwen3-8B-Q4_K_M.gguf` and `Qwen3-8B-Q4_K_M_v2.gguf` (`Submit.svelte:87-90`) — note the second differs from the documented name only by case, which matters on Linux.

**Failure scenario.** A user follows `SETUP.md:81` → `ComfyUI-Workflow/README.md`, downloads exactly what is listed, submits a job with untouched defaults, and gets a `ComfyUI /prompt validation error` (`comfyui.py:375-377`) — which `main.py:210` deliberately flattens to "Job processing failed. Check PC client logs for details." on the phone. First-run experience is an opaque failure.

**Suggested fix.** Make the two lists agree — either add the KV quants and the two extra Qwen names to the download table, or change the client default to `flux-2-klein-9b-Q4_K_M.gguf` (which is what `pc-client/config.py:72` and `workflow_template.json:153` use as *their* default).

---

### 7. Low — `SETUP.md:77` misstates the consequence of losing `private_key.pem`

**File:** `/home/fixed/ComfyLink/SETUP.md:77`

> **Back up `private_key.pem`.** Losing it means any vault results encrypted to this key are unrecoverable.

Vault results are not encrypted to the PC key. `docs/ARCHITECTURE.md:111-115` and `docs/VAULT.md:5,11,41` are explicit that vault blobs are encrypted with a browser-generated 256-bit master key wrapped by passkey/password/recovery phrase. The PC's static P-256 key is used only for the per-job ECDH handshake (`crypto_utils.py:101-130`), and each job's key material is discarded when the job ends. Losing `private_key.pem` costs nothing but a `keygen.py` re-run plus updating `PC_PUBLIC_KEY_FINGERPRINT` and `VITE_PC_KEY_FINGERPRINT`.

**Failure scenario.** A user takes the warning literally and stores an unencrypted long-term private key in a backup or cloud-sync folder, expanding the blast radius of the one key that actually matters, for a benefit that does not exist.

**Suggested fix.** Replace with: losing the key requires regenerating the pair and updating both fingerprint variables; it does not affect vault recoverability. Keep the separate, correct advice at `keygen.py:73-79` about the unencrypted-at-rest warning.

---

### 8. Low — `docs/ARCHITECTURE.md` documents a single HKDF `info` and omits the direction split

**Files:** `/home/fixed/ComfyLink/docs/ARCHITECTURE.md:98`, `/home/fixed/ComfyLink/pc-client/crypto_utils.py:96-98`

> | Key derivation | HKDF-SHA-256 (`info = "flux2-klein-v1"`) | — `ARCHITECTURE.md:98`

The actual info strings are `b"flux2-klein-v1:job"` and `b"flux2-klein-v1:result"` (`crypto_utils.py:97-98`), matching `client/src/lib/crypto.js:56-57` exactly. The doc's value is used by neither side, and the table never mentions that two keys are derived per exchange — which is the more interesting design point and is well explained in both code files (`crypto_utils.py:106-114`, `crypto.js:59-66`). The zero 32-byte salt also goes undocumented.

**Suggested fix.** Correct the info strings, name the direction split, and state the salt.

---

### 9. Low — "Per-job forward secrecy" overstates what one-sided ephemeral ECDH provides

**Files:** `/home/fixed/ComfyLink/docs/ARCHITECTURE.md:101`, `/home/fixed/ComfyLink/pc-client/crypto_utils.py:50-77,116`

> **Per-job forward secrecy:** The phone generates a fresh ephemeral keypair for every job. Past jobs remain protected even if a session key is later compromised.

The sentence as written is true, but the heading is not. Only the phone contributes an ephemeral key; the PC uses a long-lived static key loaded from disk and cached for the process lifetime (`crypto_utils.py:50-77`) and derives from it via `private_key.exchange(ECDH(), peer_public_key)` (`crypto_utils.py:116`). This is ECDH-ES, so anyone who records ciphertext off the relay and **later** obtains `private_key.pem` can decrypt every recorded past job — that is exactly what forward secrecy is supposed to prevent. `keygen.py:73-79` already warns the key may be stored unencrypted, which makes this reachable rather than theoretical.

**Suggested fix.** Retitle to "per-job key separation" or similar and state plainly: compromise of the PC's static private key retroactively exposes any job ciphertext an adversary retained. That is an honest and defensible property; the current heading invites the wrong inference.

---

### 10. Info — Progress messages leak job shape to the relay

**Files:** `/home/fixed/ComfyLink/pc-client/main.py:155-162`, `/home/fixed/ComfyLink/pc-client/comfyui.py:420-436`

`send_progress` transmits `value`, `max` and `node` unencrypted. `node` is a ComfyUI node id string, so this reveals the step count and which stage of the graph is executing. No prompt or image content is involved, so `ARCHITECTURE.md:11`'s wording ("no prompts, images, or results") is not violated — but it is metadata the relay would not otherwise have, and it is worth one line in `docs/PRIVACY.md`'s data summary for completeness. Not a defect; noting it so the omission is a decision rather than an oversight.

---

### 11. Info — Near-dead cancellation check, and a stale `_current_job_id`

**File:** `/home/fixed/ComfyLink/pc-client/main.py:125-135,143,179-181`

`handle_cancel` both sets `_current_job_cancelled` and calls `_job_task.cancel()` (`main.py:130-133`). The cancel therefore surfaces as a `CancelledError` inside `process_job` and is caught at `main.py:203`, so the `if _current_job_cancelled.is_set()` guard at `main.py:179-181` is only reachable in a very narrow window (cancel landing between `process_job` returning and that line executing). It is harmless defence-in-depth; just be aware it is not the mechanism doing the work. Separately, `_current_job_id` is never reset after a job finishes (`main.py:143` is the only assignment), so a late cancel for a just-completed job will match and fire `interrupt_comfyui()` — which interrupts whatever ComfyUI happens to be running, including work the operator started by hand in the ComfyUI UI. Clearing `_current_job_id = None` in a `finally` in `handle_job` closes both.

---

### 12. Info — Unbounded reference-image size; lenient base64

**File:** `/home/fixed/ComfyLink/pc-client/crypto_utils.py:216-234`, `/home/fixed/ComfyLink/pc-client/main.py:65`

```python
def _decode_image(field: str) -> bytes | None:
    val = data.get(field)
    return base64.b64decode(val) if val else None
```

There is a 4 000-character cap on `prompt` (`crypto_utils.py:42,236-237`) and range checks on `seed`/`steps` (`job_validation.py`), but no size cap on the decoded images — the only bound is the relay socket's `max_size=50 * 1024 * 1024` (`main.py:65`), i.e. roughly 37 MB of image bytes per job, all of which lands permanently in ComfyUI's `input/` (finding 2). `b64decode` is also called without `validate=True`, so non-alphabet characters are silently dropped rather than rejected. Adding an explicit `MAX_IMAGE_BYTES` next to `MAX_PROMPT_LEN` and passing `validate=True` would be cheap. Note that `prompt` is not type-checked before `len()` — a non-string `prompt` raises `TypeError` inside the general handler rather than a clear `ValueError`; cosmetic, but an explicit `isinstance(str)` would match the care taken in `job_validation.py:13`.

---

### 13. Info — Docstring in `_inject_ai_metadata` describes a Comment string the code does not write

**File:** `/home/fixed/ComfyLink/pc-client/comfyui.py:88-89` vs `:114`

The docstring promises `Comment = Generated by AI / Vygenerováno umělou inteligencí`; the code writes only `"Generated by AI"`. The code is correct — `_make_png_text_chunk` encodes as `latin-1` (`comfyui.py:72`), which cannot represent `ě`, so the Czech text would raise `UnicodeEncodeError`. Fix the docstring, not the code. If the bilingual string is wanted, it needs an `iTXt` chunk (UTF-8) rather than `tEXt`. Related: `README.md:96` says "every generated PNG carries embedded `AI_Generated: yes` metadata" — `_inject_ai_metadata` silently returns non-PNG input unchanged (`comfyui.py:93-95`), and the thumbnail is WebP and carries no marker at all. True for the PNG path ComfyUI actually produces; worth knowing the guarantee is format-conditional.

---

### 14. Info — `SKIP_TLS_VERIFY` exposes `PC_SECRET`, not job content

**Files:** `/home/fixed/ComfyLink/pc-client/config.py:47-50`, `/home/fixed/ComfyLink/pc-client/main.py:56-67`

With `SKIP_TLS_VERIFY=true`, `check_hostname`/`verify_mode` are disabled wholesale (`main.py:61-63`). An active MITM on the `wss://` path then reads `{"type": "auth", "secret": PC_SECRET}` (`main.py:67`) in the clear and can impersonate the PC to the relay. Job payloads stay safe — they are encrypted to the PC's static key, and `client/src/lib/crypto.js:193-209` pins the fingerprint before encrypting, so a substituted worker key is rejected browser-side. I am recording this as Info rather than a defect because the flag is explicitly scoped to Tailscale, where WireGuard already authenticates the tunnel (`config.py:48`, `SETUP.md:147-159`). It would be worth a one-line warning in `docs/CONFIGURATION.md` that this flag is safe *only* inside an already-authenticated tunnel, never on the public internet.

---

## Doc claims checked

| Claim | Source doc | Verdict | Pointer |
|---|---|---|---|
| "The relay forwards encrypted blobs it cannot read" / "only ever holds opaque blobs" | `README.md:5,72` | **Does not hold** | Plaintext WebP thumbnail — `main.py:183-200`; finding 1 |
| "Gallery thumbnails — Encrypted blob — Only you, via your master key" | `README.md:90` | **Partially** | True of the stored copy; the live relay hop is plaintext. `docs/PRIVACY.md:17` states this correctly, README does not |
| "No prompts, images, or results are visible to it at any point" | `docs/ARCHITECTURE.md:11,91` | **Does not hold** | Same as finding 1 |
| "The relay may see the thumbnail transiently during delivery … never stored server-side in plaintext" | `docs/PRIVACY.md:17` | **Partially** | Accurate about intent; "transiently" understates it — `server/src/jobs.js:59-64` retains it in RAM until the phone acks, with later replay at `server/src/index.js:1685` |
| "The pc-client deletes each prompt from ComfyUI's in-memory history immediately after the result image is downloaded" | `docs/PRIVACY.md:37`, `SETUP.md:89` | **Holds** | `comfyui.py:122-132`, invoked from a `finally` at `:386-389` so failure paths are covered too |
| "Prompt content, reference images … never stored in plaintext" | `docs/PRIVACY.md:43` | **Partially** | True of the relay, which is what the sentence is about; reference-image plaintext does persist on the PC — `comfyui.py:338-347`, finding 2 |
| pc-client per-job steps 1–7 (load, deep-copy, upload, prune, POST, monitor, delete history) | `docs/ARCHITECTURE.md:24-32` | **Holds** | `comfyui.py:44`, `:167`, `:338-347`, `:197-221`, `:356-378`, `:404-481`, `:122-132` |
| Wire format `[2-byte key length][SPKI][12-byte IV][ciphertext]`; result `[12-byte IV][ciphertext]` | `docs/ARCHITECTURE.md:103-105` | **Holds** | `crypto_utils.py:135-169` ↔ `client/src/lib/crypto.js:148-171` — big-endian uint16, identical offsets |
| Key derivation "HKDF-SHA-256 (`info = "flux2-klein-v1"`)" | `docs/ARCHITECTURE.md:98` | **Does not hold** | Actual: `:job` / `:result` suffixes, zero salt — `crypto_utils.py:96-98`; finding 8 |
| "Per-job forward secrecy" | `docs/ARCHITECTURE.md:101` | **Partially** | One-sided ephemeral only; PC key is static — `crypto_utils.py:50-77,116`; finding 9 |
| Client-side fingerprint pinning throws before encrypting | `docs/ARCHITECTURE.md:128` | **Holds** | `client/src/lib/crypto.js:193-209`; fingerprint printed by `keygen.py:95-96` is SHA-256 of the SPKI DER, matching what the client hashes |
| Node pruning table (2 img: none; 1 img: 178,133,159,161,118; 0 img: +177,115,119) | `ComfyUI-Workflow/README.md:103-107` | **Holds** | `comfyui.py:198-221` — exact match |
| LoRA table: 181 wired `[163,0]→[181]→[139]`, `[164,0]→[181]→[156]`, `strength_clip` fixed at 1.0 | `ComfyUI-Workflow/README.md:115-116` | **Holds** | `comfyui.py:183-195` — exact match, including the deliberate `strength_clip = 1.0` |
| Node map ids 99…181 | `ComfyUI-Workflow/README.md:77-97` | **Holds** | All 21 ids present in `workflow_template.json` and in `Flux2_Klein_9B_GGUF_ONLINE.json` (21 nodes, ids and types identical) |
| Required model downloads | `ComfyUI-Workflow/README.md:48-50` | **Does not hold** | Omits the client's default `Flux-2-Klein-9B-KV-*` quants and two Qwen CLIP names; lists a `Q8_0` the UI cannot select — finding 6 |
| "Losing `private_key.pem` means vault results are unrecoverable" | `SETUP.md:77` | **Does not hold** | Vault uses the browser master key — `docs/VAULT.md:5,11,41`; finding 7 |
| "No GPU? Import from `comfyui_mock` instead" | `SETUP.md:111` | **Does not hold** | `ImportError` then `TypeError` — finding 5 |
| "Every generated PNG carries embedded `AI_Generated: yes`" | `README.md:96` | **Partially** | Holds for PNG; silently skipped otherwise (`comfyui.py:93-95`), and the relayed WebP thumbnail carries no marker |

---

## What is done well

- **The two crypto halves genuinely match.** `crypto_utils.py:96-98` and `client/src/lib/crypto.js:55-57` use byte-identical salt and info strings; `decode_job_payload` (`crypto_utils.py:135-160`) parses exactly what `encodeJobPayload` (`crypto.js:148-157`) produces, big-endianness included. I checked offset by offset. Re-deriving both keys on the PC and returning `result_key` to the caller (`crypto_utils.py:207,239`) keeps the job key from ever being reachable for the outbound direction.
- **Payload parsing is defensive in the right places.** `crypto_utils.py:148-156` checks the minimum length *before* unpacking, bounds `key_len` to `1..256` with a comment explaining why 91 is the real value, and re-checks `2 + key_len + 12 + 16 > len(raw)` after reading the length field — so a hostile length prefix cannot produce a short read or a negative slice.
- **No nonce reuse is possible.** `encrypt_result` draws a fresh `os.urandom(12)` per call (`crypto_utils.py:250`) and `result_aes_key` is unique per job because the phone's keypair is ephemeral. There is no counter, no cached IV, no reuse path.
- **Error messages returned over the relay are deliberately content-free.** `main.py:207-211` replaces the exception with a fixed string and comments why, while `log.exception` keeps full detail local. `main.py:153` logs `Prompt: ***` rather than the prompt. This is the kind of discipline that usually slips; here it did not.
- **Workflow pruning is actually correct.** In 1-image mode node 119 survives with both refs (`115`,`101`) intact; in 0-image mode `106`/`109` get literal 1024s to replace the removed `["115",1/2]` refs and node 156's `vae` is dropped along with `image1`/`image2` — I traced every remaining reference in all three modes and found no dangling link. The comment at `comfyui.py:208` explaining why 119 stays is exactly the note a future maintainer needs.
- **`_clear_history` is in a `finally` (`comfyui.py:386-389`), not the happy path.** It also survives task cancellation, because it sits inside the still-open `ClientSession` and `cancel()` is issued once. The docstring at `:387-388` says why.
- **The ComfyUI WebSocket has a real timeout** (`comfyui.py:53,408-415`) with a comment naming the failure it prevents (OOM / GPU lock-up), and progress messages are filtered by `prompt_id` (`comfyui.py:424-427`) so a sibling ComfyUI client cannot drive this job's progress bar.
- **Image format sniffing precedes upload.** `_detect_extension` (`comfyui.py:260-268`) checks real magic bytes and raises on anything that is not JPEG/PNG/WebP, and the upload filename is a server-side UUID (`comfyui.py:310,340`), so the user controls neither the name nor the extension of what lands in ComfyUI's input directory.
- **Validation is shared, not duplicated.** `job_validation.py` is imported by both `crypto_utils.py:40` and `comfyui.py:39`, and the bounds are re-checked in `process_job` (`comfyui.py:313-314`) rather than trusted from the decrypt step. `_validate_int_range:13` explicitly rejects `bool` — a detail most Python validators miss.
- **`keygen.py` gets the operational details right**: refuses to overwrite existing keys (`:37-42`), offers passphrase encryption, chmods to 0600 with an honest note about Windows ACLs (`:65-71`), warns loudly when the key is unencrypted (`:73-79`), and prints the fingerprint in the exact `PC_PUBLIC_KEY_FINGERPRINT=` form the `.env` wants (`:96`).
- **`load_private_key`'s `TypeError` handler** (`crypto_utils.py:69-76`) turns `cryptography`'s notoriously opaque password error into an actionable message naming the env var, in both directions.
