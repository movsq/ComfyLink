# Review E — Client UI (Submit / App / Result / Gallery / Admin / modals)

**Verdict.** The client is in better shape than the E2EE pitch usually survives: there is no `localStorage`, `sessionStorage`, `IndexedDB` or cookie use anywhere in `client/src`, no prompt text or image bytes are logged (only job IDs), the PC public key is fingerprint-pinned before every submit, and the only thing that leaves the browser on a vault save is AES-GCM ciphertext plus IVs. The one real hole in the encryption story is not in this slice's code but is accepted by it: the **gallery thumbnail arrives from the relay in plaintext** and is held in the server's job map until delivery, so the relay does see a 200 px preview of every generated image — which is what `docs/PRIVACY.md` admits and what `README.md`'s privacy table does not. Beyond that, the findings are correctness bugs rather than security ones: the COMPLETED shelf thumbnail is always a revoked blob URL, email-type users can never save to their vault, a result silently evaporates if the modal is open past two minutes, and the gallery leaks every object URL it creates. XSS surface is small and correctly handled — a single `{@html}`, DOMPurify-sanitised, over server-static content.

---

## Findings

### 1. High — Gallery thumbnails cross the relay in plaintext and are buffered in server memory

**Where:** `client/src/App.svelte:187`, `client/src/components/Result.svelte:159-168`, `server/src/index.js:1488-1514`, `server/src/jobs.js:59-64`, `server/src/index.js:1685`, `pc-client/main.py:183-199`

The browser simply accepts whatever the relay hands it:

```js
// client/src/App.svelte:187
thumbnail: typeof msg.thumbnail === 'string' ? msg.thumbnail : null,
```

The value is raw base64 WebP produced by the PC (`pc-client/main.py:187-188`, `generate_thumbnail` in `pc-client/comfyui.py:271`) and relayed unencrypted. The server decodes it to check the RIFF/WEBP magic and logs its size (`server/src/index.js:1498-1506`), then — despite the comment on line 1490 saying "we validate format here but never store it" — passes it to `completeJob(msg.jobId, msg.payload, relayedThumbnail)` (line 1508), which assigns `job.thumbnail = thumbnail ?? null` (`server/src/jobs.js:64`). If the owner's socket is down, the job is *not* deleted (`sendJsonAck` only deletes on delivery, lines 1516-1521) and the plaintext thumbnail sits in the job map until the owner reconnects and it is replayed (`server/src/index.js:1685`).

**Confirmed by reading:** client accepts plaintext; server stores it in the in-memory job record; the retention window is "until delivered", not "transient". **Confirmed as correct:** the browser *does* encrypt it with the vault master key before upload — `Result.svelte:161-164` calls `encryptBlob(masterKey, thumbBytes)` and only `bufToB64(encT)` / `bufToB64(ivT)` reach `POST /results`.

**Failure scenario:** an operator (or anyone with a memory dump, a core file, or the process logs of the relay) recovers a legible 200 px preview of every image generated through the service — exactly the class of data the README says the relay cannot read. A compelled-disclosure order against the relay is no longer answerable with "we hold only ciphertext" for the in-flight window.

**Fix:** encrypt the thumbnail on the PC with the same ECDH result key as the full image (it is already derived and used for `payload`), ship it as a second opaque blob, and decrypt it in `Result.svelte` alongside the main payload. That keeps the relay blind and removes the server's WebP sniffing entirely. If that is too large a change, at minimum (a) stop persisting it in `completeJob`, and (b) correct the README table. The server side of this belongs to the server reviewer — the file to check is `server/src/index.js:1488-1521` plus `server/src/jobs.js:59-72`.

---

### 2. High — Terms of Service can be dismissed and never re-shown for access-code users

**Where:** `client/src/components/TermsModal.svelte:63,98-100`, `client/src/App.svelte:308-310,683-691`, `server/src/index.js:1832-1847`

```svelte
<!-- TermsModal.svelte:63 -->
<div class="backdrop" ... onclick={(e) => { if (e.target === e.currentTarget) onDeclined(); }}>
```
```svelte
<!-- App.svelte:688-689 -->
onAccepted={() => { tosAccepted = true; showTerms = false; termsViewOnly = false; }}
onDeclined={() => { showTerms = false; termsViewOnly = false; }}
```

`onDeclined` closes the modal and changes nothing else. Nothing re-opens it, and the submit button is not gated on `tosAccepted`. For **DB-backed users** this is caught server-side — `server/src/index.js:1844` rejects a submit with `tos_not_accepted` and `App.svelte:202-203` re-opens the modal, so the gate holds in practice. For **code users** the whole `if (jwtPayload?.type !== 'code_user' && jwtPayload?.userId)` block at `server/src/index.js:1832` is skipped, so there is no server-side ToS check at all; acceptance is session-local by design (`TermsModal.svelte:48-52` skips `POST /auth/tos` for code users). Tapping the backdrop or DECLINE therefore lets a code user generate without ever accepting.

**Confirmed by reading both sides.** **Fix:** make `onDeclined` a hard stop for the non-view-only case — either keep the modal up (no backdrop dismissal when `!viewOnly`) or route DECLINE through `forceRelogin('tos_declined')`. Gate the submit button on `tosAccepted` for code users since the server cannot.

---

### 3. Medium — The COMPLETED shelf thumbnail is always a revoked blob URL

**Where:** `client/src/components/Result.svelte:77-79`, `client/src/App.svelte:448-464`, `client/src/components/Submit.svelte:954-958`

`Result` owns the blob URL's lifetime:

```js
// Result.svelte:77-79
onDestroy(() => {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
});
```

but the same string is handed to the parent (`Result.svelte:103` → `App.svelte:477-480 storeImageUrl`) and stored on the dismissed entry. `handleClose` (`App.svelte:448-464`) removes the item from `resultStack`, which unmounts `Result`, which revokes the URL — and then `Submit.svelte:955` renders `<img src={d.imageUrl} …>` against a URL the browser has already released. Because the revoked string is still truthy, the `{:else}` placeholder at `Submit.svelte:957` never kicks in, so the shelf shows a broken image rather than the neutral placeholder.

**Confirmed by reading.** ARCHITECTURE.md:67 describes this bar as "showing a thumbnail", so it is a visible regression against the documented behaviour. Reopening still works, because the remounted `Result` decrypts again and calls `onImageReady` with a fresh URL.

**Fix:** give ownership to one place. Either drop the `onDestroy` revoke and let `App` revoke in `handleDone` / the expiry timer / `clearResultCards` (all three already do), or have `App` create its own `Blob`+URL for the shelf from the decrypted bytes.

---

### 4. Medium — Users who signed up with email/password can never save a result to their vault

**Where:** `client/src/components/Result.svelte:235`, `client/src/App.svelte:595-597,626`, `docs/VAULT.md:29`

```svelte
<!-- Result.svelte:235 -->
{#if userType === 'google'}
  … Save / Saved / Saving … {:else} <!-- only Discard -->
```

`App.svelte:626` passes `userType={user?.type ?? 'google'}`, and `user.type` is `'email'` for email-registered accounts (`server/src/index.js:1061,1126`). Those users are otherwise full vault citizens: `hasDbUser` includes them (`App.svelte:86`), they get the gallery and vault-settings buttons (`App.svelte:595-597`), `VaultSetup` runs for them, `POST /results` is `requireActive` with no provider check (`server/src/index.js:737`), and `docs/VAULT.md:29` explicitly documents email-password step-up auth for rekey. So they can create a vault and open an empty gallery forever.

**Confirmed by reading.** **Fix:** gate on the presence of a DB identity, not the provider — e.g. pass `canSaveToVault={hasDbUser}` from `App.svelte` and test that.

---

### 5. Medium — Closing a result modal after the 2-minute window destroys it silently

**Where:** `client/src/App.svelte:189,448-457`

`expiresAt` is stamped when the result *arrives* (`App.svelte:189`), not when the modal is dismissed. `handleClose` then does:

```js
const remaining = item.expiresAt - Date.now();
if (remaining <= 0) {
  if (item.imageUrl) URL.revokeObjectURL(item.imageUrl);
  return;                      // discarded with no shelf entry, no warning
}
```

**Failure scenario:** a user studies an image for three minutes, taps the X (the affordance that everywhere else means "put it on the shelf"), and the image is gone — no shelf row, no confirmation, no way back; the only copy was the blob URL that was just revoked. The explicit Discard path at least asks for confirmation (`Result.svelte:250-258`).

**Confirmed by reading.** **Fix:** either start the countdown at dismissal (`expiresAt = Date.now() + 120_000` inside `handleClose`), or when `remaining <= 0` treat the close as a Discard and route it through the same confirmation.

---

### 6. Medium — Gallery leaks every object URL it creates

**Where:** `client/src/components/Gallery.svelte:80,97,110,118-128` (no `onDestroy` anywhere in the file)

`loadThumbnails` assigns `r._thumbUrl = URL.createObjectURL(blob)` (line 80) for every item on every page, and the only revoke is in `handleDelete` (line 166). There is no `onDestroy`, so closing the gallery (`App.svelte:678` sets `showGallery = false`, unmounting the component) orphans every thumbnail URL — and with it the decrypted thumbnail bytes — for the lifetime of the tab. Open the gallery five times and you hold five full copies. Separately, `viewFull` sets `viewUrl = null` at line 97 without revoking the previous one, so paging through the gallery with Prev/Next (lines 130-136) leaks one *full-size decrypted image* per step.

**Confirmed by reading.** This also contradicts the spirit of the vault design: decrypted plaintext is retained in the page long after the user closed the view.

**Fix:** add `onDestroy(() => { for (const r of items) if (r._thumbUrl) URL.revokeObjectURL(r._thumbUrl); if (viewUrl) URL.revokeObjectURL(viewUrl); })`, and revoke `viewUrl` at the top of `viewFull` before overwriting it.

---

### 7. Medium — No image size or real type validation before encryption; base64 conversion blocks the main thread

**Where:** `client/src/components/Submit.svelte:243-254,284-294,314-332,359-366`, `server/src/index.js:94,1216,1800`

The only check on a selected file is `file.type.startsWith('image/')` (lines 245, 251, 290, 329) — the browser-declared MIME, not the content. There is no size cap anywhere on the client. Then:

```js
// Submit.svelte:359-366
async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
```

a byte-at-a-time loop on the UI thread, with no progress feedback beyond `status = 'encrypting'`. The server accepts a 100 MB base64 payload (`MAX_PAYLOAD_B64`, `server/src/index.js:94`, `maxPayload` at 1216), so nothing upstream stops it either.

**Failure scenario:** a phone user picks two 40 MP originals straight from the camera roll; the tab freezes for seconds and may OOM mid-`btoa`, and the failure surfaces as a generic `error = err.message`. Note the codebase already has the right helper — `crypto.js:213-218` and `vault-crypto.js:339-347` both use a chunked `String.fromCharCode(...subarray)` loop.

**Fix:** cap per-image bytes (pick a number and state it in the UI), sniff the magic bytes as `Result.svelte:30-49` already does rather than trusting `file.type`, and reuse the chunked `bufToB64` from `crypto.js`.

---

### 8. Medium — `maxQueuePerUser` from the server is dropped, so the UI hard-codes 3

**Where:** `client/src/App.svelte:252-261`, `client/src/components/Submit.svelte:22-23`, `server/src/index.js:89,217-219,1668`

The server sends the limit on every `queue_update` (`…, maxQueuePerUser: MAX_QUEUE_PER_USER`), and `Submit` reads it:

```js
let queueLimit = $derived(queueState.maxQueuePerUser ?? 3);
```

but `App`'s handler rebuilds the object from four hand-picked fields and never copies it:

```js
queueState = {
  queue: msg.queue ?? [], activeJobId: msg.activeJobId ?? null,
  avgDuration: msg.avgDuration ?? 60, queueSize: msg.queueSize ?? (msg.queue?.length ?? 0),
};
```

So `queueLimit` is always the `?? 3` fallback. Latent today because `MAX_QUEUE_PER_USER` is the literal `3` (`server/src/index.js:89`), but ARCHITECTURE.md:53 advertises it as configurable — change it to 5 and the button reads "QUEUED JOBS (3/5)"-style nonsense and disables early.

**Confirmed by reading.** **Fix:** add `maxQueuePerUser: msg.maxQueuePerUser ?? 3` to the handler (or spread `...msg` minus `type`).

---

### 9. Medium — The model/LoRA/CLIP allow-lists exist only in the client; the PC checks for path traversal only

**Where:** `client/src/components/Submit.svelte:64-91,403`, `pc-client/comfyui.py:48,55-62,315-319`

The sampler list *is* mirrored exactly — `{'euler','res_multistep','heun'}` in `_ALLOWED_SAMPLERS` (`comfyui.py:48`) matches `samplerOptions` (`Submit.svelte:64-68`), and `comfyui.py:315` rejects anything else. Quantization, CLIP and LoRA are not: the client offers six/three/two fixed options (`Submit.svelte:79-91,74-78`) but the PC only runs `_validate_model_filename`, which rejects `..`, `/` and `\` and nothing more (`comfyui.py:55-62`). Steps and seed are properly range-checked on both sides (`Submit.svelte:368-374,388-391` vs `pc-client/job_validation.py`). `loraStrength` is range-limited by the slider only (`Submit.svelte:590`) and is not validated on the PC at all.

**Failure scenario:** the payload is end-to-end encrypted, so the relay cannot police it — any authenticated user running a patched client can name an arbitrary `.gguf`/`.safetensors` in the PC's model directories, or pass an absurd LoRA strength. Not a traversal, but not the allow-list the client's UI implies.

**Fix (pc-client reviewer's file):** turn `_ALLOWED_SAMPLERS` into a set per field — samplers, GGUF names, CLIP names, LoRA names — and clamp `lora_strength` to 0-2 in `pc-client/comfyui.py`.

---

### 10. Low — Queue preview thumbnails break when the user clears the corresponding input slot

**Where:** `client/src/components/Submit.svelte:255-262,410-411,434`, rendered at `912-917`

`handleJobSubmitted` stores the *live* preview object URLs on the pending job (`Submit.svelte:410-411` → `App.svelte:410`), but `clearImage1`/`clearImage2` revoke them unconditionally:

```js
function clearImage1() {
  if (imagePreviewUrl1) URL.revokeObjectURL(imagePreviewUrl1);
  imageFile1 = null; imagePreviewUrl1 = null;
}
```

Submit a job, then remove the reference image to prepare the next one, and the queued row's thumbnail is dead. Same shape as finding 3 — one URL, two owners. `Submit` also has no `onDestroy`, so both preview URLs leak on logout. **Fix:** create a separate URL (or keep the `File` and create one lazily) for the queue row.

---

### 11. Low — The one-shot `queued` listener leaks, holding an AES key, when the server drops a submit silently

**Where:** `client/src/components/Submit.svelte:422-447`, `server/src/index.js:1820-1824`

`cleanup()` is wired to `queued`, `error` and `no_pc`. The server's duplicate-submit guard returns without sending anything:

```js
// server/src/index.js:1821-1824
if (phoneWs._lastSubmit.hash === payloadHash && now - phoneWs._lastSubmit.at < 10_000) {
  console.warn('[relay] Duplicate submit detected — ignoring.');
  return;
}
```

so all three listeners stay registered for the life of the socket, and the closure keeps `aesKey`, `capturedPromptText` and both preview URLs alive. Every subsequent `queued` ack is checked against the stale `clientToken` and ignored, so it is a leak rather than a mis-binding. **Fix:** add a submit-side timeout that calls `cleanup()` after a few seconds, or have the server ack duplicates.

---

### 12. Low — A hostile relay can synthesise internal client events

**Where:** `client/src/lib/ws.js:110`

```js
emit(msg.type, msg);
```

The server-chosen `msg.type` is the event name. `session_invalid` and the auth handshake are special-cased above, but a relay that sends `{"type":"connection_state","state":"connected"}` flips `wsState` in `App.svelte:230-245` without a real connection, and `{"type":"open"}` clears `wsError`. The threat model already assumes the relay is untrusted-for-content, so this is a robustness gap rather than a break: the payload itself is still ECDH-protected and the PC key is pinned. **Fix:** dispatch from an explicit allow-list of message types.

---

### 13. Low — "Retry Connection" buys exactly one attempt

**Where:** `client/src/lib/ws.js:127-137,166-181`, `client/src/App.svelte:504-506,573-576`

`failedAttempts` is only reset on `auth_ok` (`ws.js:76`). Once the state is `exhausted` (5 failures), `reconnectNow()` calls `connect()` but leaves the counter at 5, so the next `close` immediately re-enters the `>= MAX_RETRIES` branch and gives up again. The banner then reads the same as before, which looks like the button did nothing. **Fix:** reset `failedAttempts = 0` in `reconnectNow()`.

---

### 14. Low — Blank seed field silently becomes 0

**Where:** `client/src/components/Submit.svelte:368-374,388,496`

`bind:value` on `<input type="number">` yields `null` when the field is cleared; `validateIntegerRange(null, …)` computes `Number(null) === 0`, which is an integer inside `[0, 2^32-1]`, so the submit proceeds with seed 0 and the config pill shows `null` until then. Steps behave better (0 fails `MIN_STEPS`). **Fix:** reject `null`/`''` explicitly before `Number()`.

---

### 15. Low — Modal keyboard handling (kept brief)

- No `Escape` handler on `Result`, `Gallery`, `Admin`, `TermsModal`, or the Submit config overlay. The two handlers that exist (`DataNoticeModal.svelte:7`, `Login.svelte:340`) are bound to a `tabindex="-1"` div that is never focused, so they only fire if the user has already tabbed inside. A repo-wide grep for `keydown` returns exactly those two lines.
- Every modal sets `aria-modal="true"` without moving focus into the dialog or trapping it, so keyboard and screen-reader users continue to tab through the form behind `Result`/`Gallery`/`Admin`.
- **Fix:** one shared `dialog` action that binds `keydown` on `window`, focuses the panel on mount, and restores focus on destroy.

### 16. Info — Confirmed clean

- **No web storage of any kind.** A grep for `localStorage|sessionStorage|indexedDB|document.cookie` across `client/src` returns nothing: the JWT, the vault master key and the per-job AES keys live in memory only. (Cost: a reload logs the user out — a deliberate trade, worth documenting.)
- **No plaintext in logs or URLs.** The only `console` calls in components are `App.svelte:164` and `App.svelte:170`, both job IDs. No prompt, image, or key material is logged, and no user data is placed in a query string (`Gallery.svelte:69` and `api.js:190-196` pass only IDs and a numeric cursor).
- **Progress messages for other users' jobs** reach every socket as `{value, max}` with no `jobId` (`server/src/index.js:1466`), and `Submit.svelte:127` lets them through when `queueState.activeJobId` is null — they mutate `progressValue`, but `pct` is only rendered inside a row of the user's *own* queue (`Submit.svelte:900-905`), and only one job processes globally, so there is no visible cross-talk. Worth a guard (`if (!jobId) return;`) anyway.

---

## Thumbnail and result trace

Hop by hop, from the wire to the vault.

| # | Hop | File:line | State of the data |
|---|-----|-----------|-------------------|
| 1 | PC generates full image + 200 px WebP thumbnail | `pc-client/main.py:183-199` | full image encrypted with the ECDH result key; **thumbnail base64, plaintext** |
| 2 | Relay receives `result` from PC | `server/src/index.js:1474-1508` | decodes the thumbnail, checks RIFF/WEBP magic, logs its byte size |
| 3 | Relay stores the job record | `server/src/index.js:1508` → `server/src/jobs.js:59-64` | **plaintext thumbnail in `job.thumbnail`**, retained until the owner socket acks delivery (`index.js:1516-1521`), or replayed later at `index.js:1685` |
| 4 | Browser WS dispatch | `client/src/lib/ws.js:110` | `emit('result', msg)` |
| 5 | `App` result handler | `client/src/App.svelte:167-196` | pushes `{ result: msg, aesKey, thumbnail: msg.thumbnail, expiresAt }` onto `resultStack`; **thumbnail still plaintext in memory** |
| 6 | `Result` props | `client/src/App.svelte:616-632` | `result`, `aesKey`, `thumbnailB64` |
| 7 | Full-image decrypt | `client/src/components/Result.svelte:81-110` | `decodeResultPayload` → `decryptPayload(aesKey, iv, ct)` → `imageBytes`, sniffed MIME, `URL.createObjectURL` |
| 8 | Display + download | `Result.svelte:220,224` | blob URL only; the download `href` is the blob URL, never a data URL or a server path |
| 9 | Save → encrypt full | `Result.svelte:151-154` | `encryptBlob(masterKey, imageBytes)` — AES-GCM under the vault master key |
| 10 | Save → encrypt thumbnail | `Result.svelte:159-168` | `b64ToBuf(thumbnailB64)` → `encryptBlob(masterKey, thumbBytes)`; failure is non-fatal and the save proceeds without a thumbnail |
| 11 | Upload | `Result.svelte:171-178` → `client/src/lib/api.js:175-188` | body is `{ encryptedFull, ivFull, fullSizeBytes, jobId, encryptedThumb, ivThumb }` — **ciphertext, IVs, a byte count and a job ID; nothing else** |
| 12 | Gallery read-back | `Gallery.svelte:65-91, 103-110` | `GET /results/:id/thumb` and `GET /results/:id` return ciphertext; `decryptBlob(masterKey, …)` runs locally |

**Does anything leave the browser unencrypted?** No — nothing generated *in* the browser is uploaded in the clear. Prompts, reference images and parameters go out only inside the ECDH-AES-GCM job payload (`Submit.svelte:403-406,443`); the full image and the thumbnail go out only as vault ciphertext (step 11); prompt text crosses tabs via `BroadcastChannel` (`App.svelte:102-119,413`) which is same-origin browser IPC, not the network.

**Does anything reach the browser unencrypted?** Yes — the thumbnail (steps 1-5). The plaintext exposure is upstream of the client, in the relay, and the client has no way to detect or refuse it. That is finding 1.

**Is the decrypted image retained after discard, and are object URLs revoked?** In `Result`, yes and yes: `imageBytes` dies with the component, and `onDestroy` revokes (`Result.svelte:77-79`) — in fact it over-revokes, see finding 3. `App` revokes in `handleDone` (471), the expiry timer (460), and `clearResultCards` (519-529). `Gallery` does neither on unmount (finding 6). `Submit`'s input previews are revoked on replace/clear but not on unmount (finding 10).

---

## Doc claims checked

| Claim | Source | Verdict | Pointer |
|---|---|---|---|
| "the relay forwards encrypted blobs it cannot read" | `README.md:5` | **Does not hold** for thumbnails | `server/src/index.js:1493-1506`; `jobs.js:64` |
| "Gallery thumbnails — Encrypted blob — Only you, via your master key" | `README.md:90` | **Partially** — true at rest in the DB, false in transit and in the server's job map | `App.svelte:187`; `server/src/index.js:1508` |
| "the relay may see a thumbnail transiently during live WebSocket delivery… never stored server-side in plaintext" | `docs/PRIVACY.md:17`, `docs/VAULT.md:41` | **Partially** — honest about the relay seeing it; "transiently" understates the replay buffer, and it *is* stored in RAM in `job.thumbnail` | `server/src/index.js:1685` |
| "We never store your prompts, your uploaded reference images, or any generated images" | `DataNoticeModal.svelte:33-39` | **Partially** — holds for prompts and references and for the full image; the thumbnail is an unlisted exception | finding 1 |
| Prompt text and reference images encrypted client-side, only the PC decrypts | `README.md:72,88` | **Holds** | `Submit.svelte:393-406` |
| Vault results AES-256-GCM encrypted client-side before upload | `docs/VAULT.md:36-39` | **Holds** | `Result.svelte:151-178`; `vault-crypto.js:112-118` |
| PC public key is pinned | `docs/ARCHITECTURE.md` / encryption scheme | **Holds** — enforced before every submit, and refuses to run when unconfigured | `crypto.js:193-209`; `Submit.svelte:394` |
| `queue_update` carries other users' jobs with a per-recipient `isYours` | `docs/ARCHITECTURE.md:71-85` | **Does not hold** — the server sends owner-only detail plus an aggregate `queueSize`, and the client never reads `isYours`; the documented shape also omits `queueSize` and `maxQueuePerUser`, both of which the client consumes | `server/src/jobs.js:204-238`; `App.svelte:252-261`; `Submit.svelte:20-23` |
| "Cancel button — users cancel only their own jobs" | `docs/ARCHITECTURE.md:64` | **Holds**, and is enforced server-side per WS session, not merely in the UI | `server/src/index.js:1743-1761` |
| COMPLETED bar shows "a thumbnail, scrolling prompt text, and a MM:SS countdown" | `docs/ARCHITECTURE.md:66-67` | **Partially** — prompt and countdown work; the thumbnail is broken | finding 3 |
| "Max queued jobs per user — 3 (configurable via `MAX_QUEUE_PER_USER`)" | `docs/ARCHITECTURE.md:53` | **Partially** — the server honours it, the UI ignores the transmitted value | finding 8 |
| Admin: patch code uses/expiry, set user uses 0-999,999, live push | `docs/ADMIN.md:15,28,30` | **Holds** | `Admin.svelte:233-248,314-331,100-124` |
| Vault usable by email-password accounts (step-up auth) | `docs/VAULT.md:29` | **Does not hold** in the result modal | finding 4 |
| "at least the recovery method is always configured" / server holds no key | `docs/VAULT.md:19,41` | Not verified here — belongs to the `vault-crypto.js` / `VaultSetup.svelte` reviewer | — |

---

## What is done well

- **Key pinning is unconditional and fails closed.** `crypto.js:193-199` throws when `VITE_PC_KEY_FINGERPRINT` is absent or malformed rather than falling back to trusting the relay's key, and `Submit.svelte:394` re-verifies on every single submit, not once per session. This is the control that actually makes "the relay is blind" true for prompts and reference images, and it is implemented in the strict direction.
- **The `clientToken` submit disambiguation.** `Submit.svelte:413-439` — and the comment above it — shows the author found and fixed a genuinely subtle bug: two in-flight submits on one socket would otherwise bind the wrong AES key to the wrong job ID via a one-shot `queued` listener. The server echoes it back with a length cap (`server/src/index.js:1914-1921`), and the client degrades gracefully against an older server.
- **AES keys are deliberately not shared across tabs.** `App.svelte:93-119` broadcasts only `{jobId, promptText}` so sibling tabs can keep their queue coherent, and `App.svelte:173-179` handles the resulting "this tab can't decrypt it" case with a real message instead of a silent failure.
- **Ghost result cards are `pointer-events: none`.** `Result.svelte:320-341` — stacked modals behind the front one are visually present but cannot be clicked, which is why the unguarded close button at line 207 is not a bug. The backdrop click is *additionally* guarded with `!isGhost` at line 202.
- **The only `{@html}` in the codebase is sanitised.** `TermsModal.svelte:14-17,79` runs DOMPurify over both language variants, and the content it renders is a static server module (`server/src/tos-content.js` via `GET /tos`), not admin-editable text. Everywhere else — admin emails, codes, server error strings, prompt echoes — uses plain Svelte interpolation, which escapes.
- **Client-side authorization is backed by the server everywhere I checked.** Admin panel visibility (`App.svelte:636`) is backed by `requireAdmin` on all six admin routes; cancel-own-job by `job.ownerSessionId === wsSessionId` (`server/src/index.js:1747`, which is stricter than user ID and correctly defends code-users sharing a code from each other); gallery item ownership by `req.user.userId` threaded into every `getStoredResult*` / `deleteStoredResult` call (`server/src/index.js:828,842,856,871`).
- **Format sniffing instead of assumption.** `Result.svelte:28-49` reads the magic bytes for PNG/JPEG/WebP/GIF rather than hardcoding `image/png`, with a comment explaining the bug that prompted it — and the download extension follows the sniffed type.
- **The secure-context banner.** `App.svelte:562-568` tells the user *why* the app will not work over a plain-IP `http://` origin instead of letting WebCrypto fail opaquely later.
- **Admin live-refresh is debounced, cooled down, and superseded-checked.** `Admin.svelte:60-83,126-139` — a burst of `codes_changed` events cannot turn into an HTTP flood, and a stale socket's `close` handler bails out via `if (adminWs !== ws) return` instead of scheduling a duplicate reconnect.
- **Tokens are never in URLs.** Both WebSocket clients authenticate with a first message rather than a query parameter (`ws.js:48-55`, `Admin.svelte:87-98`), with the reasoning — proxy access logs — written down at both sites.
