# ComfyLink — consolidated code review, 2026-09-11

**Target:** `origin/main` at `28948fd` (working tree identical to origin at review time).
**Method:** five independent read-only reviews, one per slice of the codebase, run in parallel by Claude Opus. Each reviewer read every line of its slice, cross-checked the README and docs claims against the code, and traced the thumbnail path through its own area. Their full reports are in [`slices/`](slices/) and are the evidence for everything below; this document deduplicates and ranks them. Nothing in the repository was modified.

| Slice | Files | Report |
|---|---|---|
| A | `pc-client/`, `ComfyUI-Workflow/` | [review-A-pc-client.md](slices/review-A-pc-client.md) |
| B | `server/src/index.js`, `auth.js`, `seed-admin.js` | [review-B-server-relay-auth.md](slices/review-B-server-relay-auth.md) |
| C | `server/src/db.js`, `jobs.js`, `tos-content.js`, Docker, Caddy, CI, `.env.example` | [review-C-server-data-deploy.md](slices/review-C-server-data-deploy.md) |
| D | `client/src/lib/*`, vault and login components | [review-D-client-crypto-auth.md](slices/review-D-client-crypto-auth.md) |
| E | `Submit`, `App`, `Result`, `Gallery`, `Admin`, modals | [review-E-client-ui.md](slices/review-E-client-ui.md) |

---

## Verdict

The cryptography is right. All five reviewers independently confirmed that the two halves of the job encryption match byte for byte (P-256 ECDH, HKDF-SHA-256 with direction-split info strings, AES-256-GCM with fresh random IVs), that the PC key is fingerprint-pinned in the browser before anything is encrypted and fails closed when unconfigured, that the vault master key never leaves the browser in usable form, and that the BIP-39 recovery encoding is correct against the canonical test vector. The database holds no prompt, no plaintext image, and no plaintext thumbnail. Tokens never touch storage or URLs. The relay really is blind to prompts, reference images, and full results.

The project's problems are not in the primitives. They are in four other places:

1. **One deliberate exception to "blind relay" that the top-level docs deny.** The 200 px thumbnail crosses the relay in the clear and sits in relay memory for up to 30 minutes. `docs/PRIVACY.md` discloses this honestly. `README.md` and `docs/ARCHITECTURE.md` say the opposite in absolute terms. Every reviewer flagged it.
2. **Two ways to lose every user's vault permanently.** Four table-rebuild migrations are not transactional and have a crash window in which a restart silently empties the results table. Separately, the recovery-phrase unlock derives the master key and then throws it away, so the documented last-resort recovery path does not work.
3. **One conditional authentication hole.** When `GOOGLE_CLIENT_ID` is unset, which the docs describe as a supported configuration, `POST /auth/google` accepts any Google-signed ID token from any application, giving account takeover by Google subject.
4. **One availability bug with no recovery path.** A PC that disconnects mid-job leaves that job `processing` forever, and the dispatcher refuses to start anything else for six hours.

Everything else is hardening, correctness, and documentation drift, listed by severity below. Someone who built the crypto this carefully did not miss these things out of carelessness. They are the kind of thing a second reader catches, which is what a review is for.

---

## Findings by severity

Each entry names the slice report and finding number where the full evidence, quoted code, and fix live. "Confirmed" means the reviewer read the code path end to end.

### High

**H1. Plaintext thumbnail crosses the relay and is retained in memory.** Confirmed by A1, B3, C10, D2, E1.
`pc-client/main.py:183-200` generates a 200 px WebP from the decrypted result and attaches it to the result message outside the AES-GCM envelope. `server/src/index.js:1488-1512` decodes it, checks the WebP magic, then passes it to `completeJob`, which stores it on the in-memory job object (`server/src/jobs.js:59-64`). The inline comment saying "we validate format here but never store it" is wrong. If the phone socket is not open when the result arrives, the job and its plaintext thumbnail persist until the 30-minute prune and are replayed from that copy on reconnect (`index.js:1685`). Nothing reaches disk or SQLite in plaintext; the browser encrypts it with the vault master key before upload (`Result.svelte:159-168`). But `README.md:5,50,72,90` and `docs/ARCHITECTURE.md:11,91` claim the relay sees nothing, and for thumbnails that is false. A heap dump, core file, or root on the VPS yields a legible preview of every image generated in the last half hour.
*Fix:* encrypt the thumbnail on the PC under the already-derived result key with its own IV, and decrypt it in `Result.svelte` before re-wrapping for the vault. The browser-side generator that would let you drop the PC thumbnail entirely already exists unused at `client/src/lib/vault-crypto.js:230-335`. Whichever route, align README and ARCHITECTURE with PRIVACY.md.

**H2. Google ID tokens accepted with no audience check when `GOOGLE_CLIENT_ID` is unset.** Confirmed by B1.
`server/src/auth.js:32-44` calls `verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })`. The vendored library skips the `aud` comparison entirely when `audience` is undefined. `.env.example` ships it blank, `docs/CONFIGURATION.md:20` calls it optional for email-only deployments, and the route stays mounted. An attacker who gets the victim to sign in to any Google-enabled site of theirs obtains a token with the victim's `sub`, replays it to `POST /auth/google`, and receives a ComfyLink session for the victim's account, including vault blobs and the admin panel if applicable. The same token satisfies the vault step-up at `index.js:681`.
*Fix:* make a missing client ID fatal for the Google path (throw in `initAuth`, or return 503 from the route). Also assert `email_verified`.

**H3. Non-atomic table-rebuild migrations can silently destroy every stored result.** Confirmed by C1.
Migrations v7, v9, v10, and v12 in `server/src/db.js` run multi-statement `db.exec()` blocks without a transaction. v8 (`db.js:177-249`) does it correctly and its comment explains the exact crash window. For v12: a crash between `DROP TABLE stored_results` and the `RENAME` leaves the data only in `stored_results_v12` with `user_version` still 11. On restart, the top-level `CREATE TABLE IF NOT EXISTS` recreates an empty `stored_results`, and the v12 block's first statement, `DROP TABLE IF EXISTS stored_results_v12`, deletes the only surviving copy. No error is raised. The data is ciphertext under keys the server never had, so there is no recovery.
*Fix:* wrap every rebuild in `db.transaction` as v8 does, never drop the staging table before confirming the real one exists, and add the missing `try/catch` to v10.

**H4. Recovery-phrase unlock derives the master key and discards it.** Confirmed by D1.
`client/src/components/VaultSettings.svelte:101-133` unwraps `mk` from the recovery blob, then calls `onClose()` and never passes the key anywhere. The component has no `onUnlocked` prop and `App.svelte:659-671` passes none. A user who forgets their vault password and loses their passkey device follows the documented "only way to restore your saved results" and nothing happens. The only remaining button is "Reset vault", which deletes everything.
*Fix:* add an `onUnlocked` prop wired to `App.svelte`'s `handleVaultUnlocked`, call it before `onClose()`, and lead the user into setting a new password afterwards.

**H5. PC disconnect mid-job wedges the whole queue for six hours.** Confirmed by B2, C2.
The PC close handler (`server/src/index.js:1399-1408`) nulls `pcSocket` and touches no job. The dispatched job stays `processing`; `dispatchNextJob` short-circuits on `getActiveJob()`; non-terminal jobs are only pruned by the 6-hour orphan cutoff (`jobs.js:296`). New submissions are accepted and quota is spent, but nothing runs. Code users cannot cancel their way out because job recovery is skipped for them by design.
*Fix:* in the PC close handler, reset the active job to `pending` (or mark it `error`, notify the owner, refund quota) and call `dispatchNextJob()` and `broadcastQueueUpdate()`.

**H6. Terms of Service can be dismissed and never re-shown for access-code users.** Confirmed by E2.
`TermsModal.svelte:63` closes on backdrop click and `onDeclined` in `App.svelte:689` only hides the modal. DB-backed users are caught server-side (`index.js:1844` rejects `tos_not_accepted`), but the whole ToS check sits inside a branch that skips code users, so a code user who taps the backdrop generates without accepting.
*Fix:* no backdrop dismissal when not view-only, route DECLINE through relogin, and gate submit on `tosAccepted` for code users.

### Medium

**M1. Memory exhaustion is cheap.** B4, C3. `maxPayload` is 100 MB on every socket including unauthenticated ones (`index.js:1216`), `job.payload` is never nulled after dispatch (`jobs.js:40`), and the 50-job cap therefore maps to 5 GB of base64 strings (about 10 GB of V8 heap) on the 1 GB VPS `docs/DEPLOYMENT.md:30` recommends. Fix: drop `maxPayload` near the real ceiling, use a small pre-auth limit, null the payload after send.

**M2. Unhandled errors return full stack traces; several routes are easy to throw from.** B5, C12. `NODE_ENV` is set nowhere, so finalhandler renders `err.stack`. `POST /results` validates `ivThumb` meticulously but passes `ivFull` straight to `Buffer.from` (`index.js:805`); `/vault/setup` and `/vault/rekey` do the same for all blob fields. Fix: `NODE_ENV=production`, a terminal error handler, and the same validation `ivThumb` already gets.

**M3. Behind Cloudflare, audit-log IPs and rate limits are probably wrong.** B6, C11. Caddy sets `X-Real-IP` on both routes and the server never reads it; `getUpgradeIp` takes the rightmost XFF hop, which is right for one proxy and likely wrong for two. The Cloudflare `trusted_proxies` list has no IPv6 ranges despite "Updated for 2026". Inferred, not executed: verify with one logged request. Fix: prefer `X-Real-IP` when `BEHIND_PROXY=true`; add the IPv6 ranges.

**M4. `handlePcMessage` acts on the global `pcSocket`, not the sender.** B7. A replaced PC socket stays readable during close; a bad `pubkey` from it closes the new legitimate socket (`index.js:1436-1442`), and its results are processed as authoritative. Fix: bind the handler per socket and return early if `ws !== pcSocket`.

**M5. Malformed `PC_PUBLIC_KEY_FINGERPRINT` silently disables pinning or crash-loops the server.** B8. `index.js:106-112` checks string length, not decoded length; 64 non-hex chars yield a short buffer and `timingSafeEqual` throws inside a WS listener with no `uncaughtException` handler. Fix: validate with `/^[0-9a-f]{64}$/`, warn loudly when pinning is off.

**M6. `DEPLOY_MODE=local` silently disables both production guards.** C6, B11. Required `ALLOWED_ORIGINS` and required fingerprint are gated only on `DEPLOY_MODE === 'remote'`; `.env.example` ships `local`, `SETUP.md` says copy it, and all docs describe the variable as a pc-client routing hint. `ALLOWED_ORIGINS` entries are also not trimmed, so a space after a comma 403s the second origin. Fix: gate on actual exposure, trim, and document that the server reads `DEPLOY_MODE`.

**M7. The 6-month audit-log prune never runs on a server that restarts daily.** C4. `schedule()` is a bare `setInterval`; the prune is on a 24-hour timer with no startup call, and every push to `main` recreates the container. `pruneRevokedTokens` three lines later does it right. Fix: one line, call it once before scheduling.

**M8. No account deletion path; a manual `DELETE FROM users` fails on foreign keys.** C5. The only admin routes are list and patch. `vault_keys`, `stored_results`, and `invite_codes` reference `users` with no cascade, and `job_audit_log` has no FK at all. The TOS promises destruction on deletion and PRIVACY.md tells deployers to have wipe tooling; neither exists. Fix: a transactional `DELETE /admin/users/:id` covering all six tables, and a written decision on audit-row retention.

**M9. Docker image ignores the lockfile.** C7. `server/Dockerfile:10-13` copies only `package.json` and runs `npm install`; every build resolves caret ranges fresh. The frontend build correctly uses `npm ci`. No `.dockerignore` exists. Fix: copy the lockfile, `npm ci --omit=dev`, add `.dockerignore`.

**M10. Deploy workflow does no SSH host-key verification.** C8. None of the four `appleboy` steps set `fingerprint:`; runners are ephemeral so every deploy is a first connection. Fix: pin the host key via a secret; add `permissions: {}`.

**M11. v8 unique-index creation swallows every error.** C9. The `catch` comment says "already exists on fresh DB", but v8 just rebuilt the table; the only realistic failure is duplicate email-auth rows, which is then silently left unindexed. Fix: let it fail loudly or log.

**M12. No CSP in Tier 1, and the Google GSI script runs on the page holding the master key.** D3, B13. Helmet's CSP is disabled (`index.js:306`); Tier 2 gets one from Caddy, Tier 1's `express.static` responses get none. The master key is unwrapped as extractable for all three callers when only one needs it (D4, `vault-crypto.js:97-107`). Fix: mirror the Caddy CSP in helmet; add `base-uri`, `form-action`; make `extractable` a parameter defaulting to false.

**M13. WebAuthn `user.id` is the raw email.** D5. `webauthn.js:44-63` encodes the email as the user handle, against the spec, the function's own docstring, and the 64-byte limit. Fix: random 32-byte handle stored server-side.

**M14. Decrypted reference images accumulate in ComfyUI's `input/` forever.** A2. `comfyui.py:338-347` uploads them; nothing ever deletes them. Every reference image any user ever submitted is plaintext on the GPU machine indefinitely, undisclosed in PRIVACY.md. Fix: unlink the two known filenames in the same `finally` that clears history.

**M15. Model, LoRA, and CLIP filenames are traversal-screened, not allow-listed.** A3, E9. Only samplers get set membership (`comfyui.py:48`); the other three get `..`/`/`/`\` checks only. The payload is E2E encrypted so the PC is the only enforcement point. `lora_strength` is unvalidated on the PC. Fix: per-field allow-lists from env, clamp strength.

**M16. Back-to-back jobs abandon the in-flight ComfyUI generation.** A4. `main.py:113-118` cancels the Python task but never calls `interrupt_comfyui()`, so a misbehaving relay can pile GPU work indefinitely. Fix: interrupt and await before starting the replacement.

**M17. Email/password users can never save to their vault.** E4. `Result.svelte:235` gates Save on `userType === 'google'`; email users get a vault, a gallery, and no way to put anything in it. Fix: gate on `hasDbUser`.

**M18. COMPLETED shelf thumbnail is always a revoked blob URL.** E3. `Result.svelte:77-79` revokes on destroy; `App` keeps the string and `Submit.svelte:955` renders it. Fix: single owner for the URL.

**M19. Closing a result after two minutes destroys it silently.** E5. `expiresAt` is stamped on arrival, and `handleClose` with `remaining <= 0` revokes and returns with no shelf entry and no confirmation. Fix: start the countdown at dismissal, or treat as Discard with confirmation.

**M20. Gallery leaks every object URL and decrypted image.** E6. No `onDestroy`; `viewFull` overwrites `viewUrl` without revoking. Decrypted plaintext outlives the view. Fix: revoke on destroy and before overwrite.

**M21. No client-side image size or content validation; byte-at-a-time base64 on the UI thread.** E7. Only `file.type.startsWith('image/')`; no size cap; `fileToBase64` loops per byte while chunked helpers already exist in `crypto.js:213`. Fix: cap, sniff magic bytes, reuse the chunked helper.

**M22. `maxQueuePerUser` is sent by the server and dropped by the client.** E8. `App.svelte:252-261` rebuilds `queueState` from four fields; the UI always shows 3. Fix: copy the field.

**M23. Account enumeration at register; timing oracle at login.** B9. Register returns 409 for known emails; login skips the argon2 verify for unknown ones, a measurable difference. AUTHENTICATION.md claims enumeration is prevented. Fix: dummy verify on miss; document or redesign register.

**M24. No change-vault-password flow.** D7. `rekeyVault` is only called for adding a passkey; `VAULT.md:28` promises password change. Fix: implement, or soften the doc.

### Low and Info

Grouped; each is one to three lines in the slice report.

- **Server (B10-B16, C13-C16):** suspended admins accepted on `/ws/admin` for up to 5 min; PC-controlled strings logged unbounded (the phone side guards against exactly this); empty socket `Set`s never removed from maps; progress step counts broadcast to all phones (deliberate, documented); result replay not session-scoped so a second tab drains the first tab's results; stolen JWT yields wrapped blobs for offline attack (inherent, should be stated in VAULT.md); `countStoredResults` TOCTOU; pagination cursor mixes `id` and `created_at`; no forward-version guard on the DB; `TOS_VERSION` hashes whitespace; `VPS_HOST` vs `VPS_SSH_HOST` naming; stale files linger on the VPS after scp; no backup story for a volume that is unrecoverable by design; quota consumed before dispatch and never refunded on error or cancel.
- **Client crypto (D8-D15):** `b64ToBuf(null)` silently yields 3 bytes; `vault-crypto.js` reads `crypto.subtle` at module load with no secure-context guard; relay controls the client's internal event namespace via `emit(msg.type)` (also E12); recovery words, passwords, and the Google token linger in component state; the recovery JSON download revokes its blob URL synchronously and may fail in Firefox; about 130 lines of dead code including the unused browser thumbnail generator; fingerprint normalisation does not trim whitespace.
- **Client UI (E10-E16):** queue-row previews break when the input slot is cleared; the one-shot `queued` listener leaks (holding an AES key) when the server silently drops a duplicate submit; "Retry Connection" buys one attempt because `failedAttempts` is never reset; blank seed becomes 0; no Escape handling or focus management on any modal.
- **pc-client (A5-A14):** the `SETUP.md` mock-ComfyUI fallback cannot import; `ComfyUI-Workflow/README.md` does not list the client's default GGUF; `SETUP.md:77` wrongly says losing `private_key.pem` loses vault results; the AI-metadata docstring promises Czech text that latin-1 `tEXt` cannot carry; progress messages leak node ids to the relay; `_current_job_id` is never reset so a late cancel can interrupt operator-started ComfyUI work; no per-image size cap and lenient base64; `SKIP_TLS_VERIFY` exposes `PC_SECRET` outside a tunnel.

---

## Documentation claims that do not hold

| Claim | Where | Reality | Slice |
|---|---|---|---|
| Relay "cannot read" / "never decrypts" / "no images visible at any point" | `README.md:5,50,72`; `ARCHITECTURE.md:11,91` | Plaintext thumbnail, retained up to 30 min | all |
| "Gallery thumbnails: encrypted blob" | `README.md:90` | True at rest, false in transit and in relay RAM | A, B, E |
| Thumbnail seen "transiently" | `PRIVACY.md:17`, `VAULT.md:41` | Honest, but understates the replay buffer | A, B, C |
| HKDF `info = "flux2-klein-v1"` | `ARCHITECTURE.md:98` | Actually `:job` and `:result` suffixes, zero salt | A, D |
| "Per-job forward secrecy" | `ARCHITECTURE.md:101` | One-sided ephemeral; PC static key compromise exposes all recorded traffic | A, D |
| Recovery wrapping is "raw AES-KW" | `ARCHITECTURE.md:114` | HKDF-stretched first | D |
| Recovery phrase is the last-resort restore | `VAULT.md:16-19`, `VaultSetup.svelte:327` | Recovery unlock discards the key | D |
| Rekey covers password change | `VAULT.md:28` | Passkey only | D |
| Audit log pruned daily after 6 months | `PRIVACY.md:53`, `README.md:94` | Timer never fires on a daily-restarted container | C |
| Admin tooling can wipe a user; deletion destroys vault | `PRIVACY.md:41`, TOS | No deletion endpoint; FKs block manual delete | C |
| Plaintext metadata list | `PRIVACY.md:41` | Omits `google_sub`, `name`, `picture`, invite codes, three IP tables | B, C |
| `GOOGLE_CLIENT_ID` optional | `CONFIGURATION.md:20` | Leaving it unset opens an auth bypass | B |
| Login prevents enumeration | `AUTHENTICATION.md:41` | Timing differs; register discloses via 409 | B |
| `DEPLOY_MODE` is a pc-client setting | `CONFIGURATION.md:22` | Server reads it to gate two security checks | B, C |
| `queue_update` carries all jobs with `isYours` | `ARCHITECTURE.md:71-85` | Owner-only detail plus aggregate; `queueSize`, `maxQueuePerUser` undocumented | E |
| COMPLETED bar shows a thumbnail | `ARCHITECTURE.md:67` | Always broken | E |
| Reference images "never stored" | `PRIVACY.md:43,62` | True of the relay; plaintext persists on the PC forever | A |
| Mock ComfyUI via import swap | `SETUP.md:111` | `ImportError` then `TypeError` | A |
| Losing `private_key.pem` loses vault results | `SETUP.md:77` | Vault uses the browser master key; PC key is per-job ECDH only | A |
| Required model downloads | `ComfyUI-Workflow/README.md:48-50` | Client default `Flux-2-Klein-9B-KV-*` not listed | A |
| Cloudflare ranges "updated for 2026" | `Caddyfile:27` | IPv4 only | C |

---

## What is done well

These were checked specifically because they are commonly wrong, and they are right here.

- **The two crypto halves match byte for byte.** Salt, info strings, wire offsets, big-endian key length. Direction-split keys carry matching WebCrypto usages so the browser physically cannot use the wrong key. The PC's payload parser bounds-checks the length prefix before slicing. (A, D)
- **Fingerprint pinning fails closed** and runs before ECDH on every submit; the production bundle was checked to confirm the constant is inlined and an unset value throws. (D, E)
- **BIP-39 is correct**, verified against the all-zero test vector and 2000 random round-trips, including the i=23 edge case. (D)
- **No web storage, no tokens in URLs, no secrets in logs** anywhere in the client; WebSocket auth is first-message specifically to keep JWTs out of proxy logs, and the reasoning is written at both sites. (D, E)
- **Session-scoped cancel authorisation** (`ownerSessionId`, not user id) closes a real multi-tenancy hole for shared access codes, and recovery/replay are skipped for code users for the same reason. (B, C)
- **Quota decrements are atomic** `UPDATE … WHERE uses_remaining > 0` with `changes` as the verdict; the post-decrement refetch broadcasts the authoritative value. (B, C)
- **Result access is user-scoped in the SQL**, so IDOR is structurally impossible rather than defended against. (C)
- **`sendJsonAck` waits for the socket flush before deleting the job**, and the comment explains why `send()` not throwing is a weaker signal. (B, C)
- **The v8 migration is textbook** (transaction, `foreign_keys` toggled outside it, restored in `finally`, crash window explained). It is the template the other four rebuilds should follow. (C)
- **The v12 migration deliberately tore out the earlier plaintext thumbnail column** and discarded the data rather than pretending it could be retrofitted. (B, C)
- **PC error messages are replaced with a fixed string at both ends**, so tracebacks never reach the phone. Prompt is logged as `***`. (A, B)
- **Workflow pruning is actually correct** in all three image-count modes and both LoRA branches; every node id and input key the code touches exists in the template. History clearing is in a `finally` and survives task cancellation. (A)
- **Format sniffing by magic bytes** on the PC and in `Result.svelte`, with server-side UUID filenames so the user controls neither name nor extension of what lands in ComfyUI. (A, E)
- **Rightmost-XFF reasoning is correct and written down**; the `clientToken` submit disambiguation fixes a genuinely subtle key-binding race and documents it. (B, E)
- **Docker privilege drop via `gosu` with the reasoning in a comment; no host ports on the server service; `.gitignore` covers `.env`, `*.pem`, and the DB.** `initAuth` refuses to start with an empty or `changeme` secret. (C)
- **`seed-admin.js` refuses to guess** when an email matches two rows. (B)

---

## Suggested order of work

If the findings are addressed in one pass, this order gets the most risk out earliest:

1. H2 (Google audience), H3 (migration atomicity), H5 (PC disconnect), M7 (audit prune) — each is a few lines.
2. H4 (recovery unlock), H6 (ToS for code users), M17 (email users save), M4/M5 (PC socket handling and fingerprint validation).
3. H1 (thumbnail encryption) plus the README/ARCHITECTURE corrections, which are the same change.
4. M1, M2, M6, M9, M10 (memory, error handling, deploy guards, lockfile, SSH pinning).
5. M8 (account deletion) and the PRIVACY.md metadata list, together, since they are the GDPR story.
6. Everything else in the Medium list, then the Lows.
