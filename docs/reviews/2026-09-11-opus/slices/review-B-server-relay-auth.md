# ComfyLink — server relay, auth, and WS protocol review (slice B)

**Scope:** `server/src/index.js` (all 1989 lines), `server/src/auth.js`, `server/src/seed-admin.js`, `server/package.json`, read in full; `server/src/db.js` and `server/src/jobs.js` read for the functions `index.js` calls; `client/src/lib/ws.js`, `client/src/App.svelte`, `client/src/components/Result.svelte`, `pc-client/main.py`, `Caddyfile`, `docker-compose.yml`, `server/Dockerfile`, `.env.example` and the docs consulted only to confirm message shapes and claims. Read-only; nothing in the repo was modified.

## Verdict

The relay is genuinely blind to job payloads and full results: every path that touches `payload` or `encryptedResult` treats them as opaque strings, nothing decrypts them, nothing logs them, and the only persisted image data (`stored_results`) is client-encrypted ciphertext — migration v12 in `db.js` deliberately undid the earlier plaintext-thumbnail design. The **thumbnail is the exception**: the PC sends a 200 px WebP rendition of every generated image in the clear, and the server holds it in process memory for as long as the job object lives (up to 30 minutes, and it is re-sent from memory on reconnect). `docs/PRIVACY.md` is honest about this; `README.md` and `docs/ARCHITECTURE.md` are not. Authentication is carefully built in most places — session-ID-scoped cancel authorization, atomic quota decrements, revocation list, argon2id, constant-time PC secret — but it has one serious conditional hole (Google ID-token audience is not enforced when `GOOGLE_CLIENT_ID` is unset, a configuration the docs explicitly bless), and the job state machine has a hard availability bug: a PC that dies mid-job stalls the entire queue for six hours with no recovery path. Below, "CONFIRMED" means I read the code path end to end; "INFERRED" means I am reasoning about runtime or deployment behaviour I could not execute here.

---

## Findings

### 1. High — Google ID tokens are accepted with no audience check when `GOOGLE_CLIENT_ID` is unset

`server/src/auth.js:6`, `server/src/auth.js:13`, `server/src/auth.js:17-20`, `server/src/auth.js:32-44`; call sites `server/src/index.js:336` (`POST /auth/google`) and `server/src/index.js:681` (vault step-up).

```js
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
...
export function initAuth() {
  if (!GOOGLE_CLIENT_ID) {
    console.warn('[auth] WARNING: GOOGLE_CLIENT_ID is not set. Google OAuth will fail.');
  }
```
```js
const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
```

CONFIRMED by reading the vendored library: `server/node_modules/google-auth-library/build/src/auth/oauth2client.js:738` —

```js
if (typeof requiredAudience !== 'undefined' && requiredAudience !== null) {
```

When `audience` is `undefined` the entire `aud` comparison is skipped and the ticket is returned. The comment in `initAuth` ("Google OAuth will fail") is wrong: it does not fail, it succeeds for *every* Google-signed ID token regardless of which application it was issued to.

This is not a hypothetical configuration. `.env.example:21` ships `GOOGLE_CLIENT_ID=` empty, `docker-compose.yml:9` passes it straight through, and `docs/CONFIGURATION.md:20` states it is "Optional when running e-mail/password-only deployments." `POST /auth/google` stays mounted either way.

**Failure scenario.** Deployer runs email/password-only, leaves `GOOGLE_CLIENT_ID` blank. Attacker stands up any site with "Sign in with Google" and gets the victim to use it, obtaining an ID token with `aud` = the attacker's own client ID and `sub` = the victim's Google subject. Replaying that token to `POST /auth/google` returns a ComfyLink session JWT for the victim's account (`index.js:344`, `findUserByGoogleSub(googleUser.sub)`) — quota, gallery ciphertext, `/vault/unlock` blobs, and the admin panel if the victim is an admin. The same token also satisfies the vault step-up at `index.js:681`, so `/vault/rekey` and `DELETE /vault` are reachable too. Classic audience-confusion; nothing about it requires the deployer to have enabled Google login.

**Fix.** In `initAuth()`, make the missing value fatal for the Google path rather than a warning — either `throw` when `GOOGLE_CLIENT_ID` is unset, or set a module flag and have `POST /auth/google` / `requireVaultStepUp` return `503 google_login_disabled`. Do not leave `verifyIdToken` reachable with `audience: undefined`. Consider also asserting `payload.email_verified === true` and `payload.iss` while you are there (issuer *is* checked by the library, `aud` and `email_verified` are not).

---

### 2. High — A PC that disconnects mid-job stalls the whole queue for six hours

`server/src/index.js:224-234`, `server/src/index.js:1398-1407`, `server/src/jobs.js:90-96`, `server/src/jobs.js:289-300`.

```js
function dispatchNextJob() {
  if (!pcSocket || pcSocket.readyState !== 1) return;
  if (getActiveJob()) return; // already processing one
```
```js
    ws.on('close', (code, reason) => {
      ...
      if (pcSocket === ws) {
        pcSocket = null;
        pcPublicKeyB64 = null;
      }
    });
```

CONFIRMED: the PC close handler clears `pcSocket` and the cached pubkey and nothing else. The job that was `'processing'` keeps that status forever. `getActiveJob()` (`jobs.js:90`) scans for `status === 'processing'` and finds it, so every subsequent `dispatchNextJob()` — on PC reconnect (`index.js:1410`), on every new submit (`index.js:1925`), on every result — returns immediately. `pruneOldJobs` is scheduled with `maxAgeMs = 30 min` (`index.js:1980`) but `orphanMs` defaults to **6 hours** and non-terminal jobs are only pruned by `orphanMs` (`jobs.js:296`).

**Failure scenario.** The home PC loses its network or ComfyUI crashes while a job is processing. The relay accepts new submissions, decrements quotas, writes audit rows, broadcasts `queue_update` — and dispatches nothing. The owner of the stuck job is never told; their quota is already spent. The queue fills to `MAX_TOTAL_QUEUE_DEPTH` (50) and then rejects everyone. Recovery happens only if the stuck job's owner happens to reconnect, see it in `job_recovery`, and cancel it (`index.js:1747-1755`, which resets state and re-dispatches). For a **code user** that path does not exist at all — `index.js:1645-1648` deliberately skips job recovery for code users — so their stuck job is uncancellable and the relay is dead for six hours.

**Fix.** In the PC close handler, when `pcSocket === ws`, walk the queue and either (a) reset any `'processing'` job back to `'pending'` so it is re-dispatched when the PC returns, or (b) mark it `'error'`, send `{type:'error', jobId, message:'Processing failed'}` to `job.phoneWs`, refund the quota decrement, and `deleteJob`. (a) is friendlier but needs the PC to tolerate a repeat of a job it may have half-finished; (b) is simpler and matches the existing error path. Either way, call `broadcastQueueUpdate()` afterwards.

---

### 3. Medium — The plaintext thumbnail lives in server memory for up to 30 minutes and is replayed from there, which the top-level docs deny

`server/src/index.js:126-134`, `server/src/index.js:1489-1522`, `server/src/jobs.js:59-72`, `server/src/index.js:1675-1690`, `server/src/jobs.js:289-300`.

```js
    completeJob(msg.jobId, msg.payload, relayedThumbnail);
```
```js
export function completeJob(id, encryptedResult, thumbnail) {
  const job = jobs.get(id);
  ...
  job.thumbnail = thumbnail ?? null;
```
```js
      const replayMsg = { type: 'result', jobId: job.id, payload };
      if (job.thumbnail) replayMsg.thumbnail = job.thumbnail;
```

CONFIRMED. The comment block at `index.js:126-134` describes the design accurately ("The server may therefore see the thumbnail transiently during live relay"), but "transiently" understates what the code does. `completeJob` stores the raw base64 WebP on the in-memory job object *before* the relay attempt, and `deleteJob` runs only inside the `sendJsonAck` flush callback when delivery succeeded (`index.js:1516-1519`). If the phone socket is closed, slow, or drops before flush, the job — with the plaintext thumbnail attached — persists in `jobs` until `pruneOldJobs` collects terminal jobs older than 30 minutes (`index.js:1980`). On the owner's next connection it is re-sent from that memory copy (`index.js:1685`).

Nothing is written to disk or DB in plaintext — `stored_results` has only `encrypted_thumb`/`iv_thumb` since migration v12 (`db.js:304-336`), `POST /results` validates the client-encrypted blob and 12-byte IV (`index.js:762-787`), and the only logging is a byte count (`index.js:1506`). So the DB claim holds. What does not hold is the headline claim: a 200 px rendition of every generated image is readable by the relay process, and therefore by anyone with a heap dump, a core file, or root on the VPS. `README.md:5` ("the relay forwards encrypted blobs it cannot read"), `README.md:50` ("it never decrypts anything") and `docs/ARCHITECTURE.md:11` ("No prompts, images, or results are visible to it at any point") are each false for thumbnails. `docs/PRIVACY.md:17` gets it right.

**Fix.** Two independent changes. (a) Stop retaining it: do not pass the thumbnail to `completeJob` at all — relay it in the live `result` message only, and accept that a reconnecting owner saves without a thumbnail (or have the client regenerate one from the decrypted full image, which `client/src/lib/vault-crypto.js:312` already knows how to do). If you keep the retention, at minimum null `job.thumbnail` once delivered and cap retention far below 30 minutes. (b) Fix `README.md:5`/`:50` and `docs/ARCHITECTURE.md:11` to match `docs/PRIVACY.md:17` — the "blind relay" claim should carry the thumbnail caveat everywhere it appears, not only in the privacy doc.

---

### 4. Medium — 100 MB WebSocket frames plus per-job payload retention make memory exhaustion cheap

`server/src/index.js:88-94`, `server/src/index.js:1216`, `server/src/index.js:1798-1803`, `server/src/jobs.js:30-46`.

```js
const MAX_PAYLOAD_B64 = 100 * 1024 * 1024;
...
const wss = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 });
```

CONFIRMED, three compounding problems.

- `maxPayload` applies to **every** socket on `wss`, including a not-yet-authenticated `/ws/phone` or `/ws/admin` socket whose very first frame is the auth message. The upgrade limiter allows 20 upgrades per IP per minute (`index.js:1250-1251`); each can buffer 100 MB before the 2 s / 3 s auth timeout fires. Reaching multiple GB of resident memory from a single IP needs no credentials at all.
- After auth, `ws.on('message')` at `index.js:1702` does `JSON.parse(raw.toString())` before any rate check. The per-user submit limiter (10/min) never sees oversized non-`submit` messages, so an authenticated user can stream 100 MB frames as fast as the socket allows.
- `job.payload` (`jobs.js:40`) is never cleared after dispatch. With `MAX_TOTAL_QUEUE_DEPTH = 50` and a 100 MB cap, the queue alone can pin 5 GB. The comment at `index.js:92-93` says the real workload is "Two 15 MB images ≈ 40 MB base64" — the cap is 2.5× the stated worst case with no accounting for concurrency.

**Fix.** Drop `maxPayload` to something near the real ceiling (48–64 MB), and give the pre-auth sockets a much smaller one — the `ws` library lets you use a second `WebSocketServer` instance, or you can check `raw.length` in the `once('message')` auth handler before parsing. Null `job.payload` in `dispatchNextJob` right after the send. Consider deriving `MAX_TOTAL_QUEUE_DEPTH × MAX_PAYLOAD_B64` and refusing to boot if it exceeds a configured memory budget.

---

### 5. Medium — Unhandled errors return full Node stack traces, and several routes are easy to throw from

`server/Dockerfile` (no `ENV NODE_ENV`), `docker-compose.yml:6-20` (no `NODE_ENV`), `server/src/index.js:805`, `server/src/index.js:606-624`.

CONFIRMED: `NODE_ENV` is set nowhere in the repository (grepped across `*.yml`, `Dockerfile`, `package.json`, `*.js`). `server/node_modules/finalhandler/index.js:81` defaults `env` to `'development'`, and line 173-178 then sends `err.stack` as the response body. There is also no `app.use((err,req,res,next)=>...)` error handler and no `process.on('uncaughtException')` anywhere in `server/src/`.

Reaching it is trivial for any authenticated user, because several handlers call `Buffer.from(x, 'base64')` on unvalidated input. `POST /results` validates `encryptedFull`, `encryptedThumb` and `ivThumb` meticulously (base64 regex, 16-char cap, 12-byte length check — `index.js:768-787`) but then does:

```js
      ivFull: Buffer.from(ivFull, 'base64'),
```

with no type or format check at all (`index.js:805`); `{"encryptedFull":"AA==","ivFull":123}` throws a `TypeError` out of the handler. `POST /vault/setup` (`index.js:606-624`) and `POST /vault/rekey` (`index.js:711-720`) have the same shape for all seven blob fields. Unauthenticated callers can get there too: a malformed JSON body produces a `SyntaxError` from `express.json` which the same finalhandler renders with a stack.

**Fix.** Set `NODE_ENV=production` in the Dockerfile and compose file, add a terminal `app.use` error handler that logs server-side and returns `{ error: 'Internal error' }`, and give `ivFull` and the vault blob fields the same validation `encryptedThumb`/`ivThumb` already get (type check, base64 regex, byte-length bound). Add `process.on('uncaughtException')` / `('unhandledRejection')` that log and exit deliberately.

---

### 6. Medium — Behind Cloudflare, the audit log and rate limits record the CDN's IP; Caddy already sends `X-Real-IP` and the server ignores it

`server/src/index.js:293-298`, `server/src/index.js:1268-1282`, `server/src/index.js:1900-1908`; `Caddyfile:73`, `Caddyfile:53`; `docs/DEPLOYMENT.md:145-157`.

```js
  if (process.env.BEHIND_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const hops = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length > 0) return hops[hops.length - 1];
    }
  }
```

CONFIRMED: `getUpgradeIp` takes the right-most `X-Forwarded-For` hop, and `app.set('trust proxy', 1)` (`index.js:298`) makes Express's `req.ip` resolve the same way. That is exactly right for a **single** trusted proxy. The shipped Tier-2 topology has two: `Caddyfile:19-33` enables Cloudflare's ranges as `trusted_proxies` by default and `docs/DEPLOYMENT.md:147` says this is on for everyone.

CONFIRMED: `Caddyfile:73` and `Caddyfile:53` set `header_up X-Real-IP {remote_host}` on both the API and `/ws*` routes, with the comment "so OAuth redirects and IP-based rate-limiting work correctly behind any proxy layer" — and `grep -rn 'X-Real-IP' server/src/` returns nothing. The header the reverse proxy goes out of its way to send is never read.

INFERRED (needs a live check): whether the right-most XFF hop that reaches Node is the Cloudflare edge address or the real visitor depends on Caddy's XFF-append behaviour when the immediate peer is a trusted proxy, which I cannot determine from this repo. If Caddy appends its direct peer, every visitor behind Cloudflare collapses onto a few hundred edge IPs — meaning `job_audit_log.ip_address` (`index.js:1906`, the row `docs/PRIVACY.md:53` describes as the compliance record) is wrong, the per-IP code brute-force block (`index.js:891-895`) and the email login block (`index.js:1081-1083`) become shared-fate, and `WS_RATE_MAX = 20` upgrades/minute is enforced across all users at once.

**Fix.** Verify first: log `req.headers['x-forwarded-for']` and `req.headers['x-real-ip']` for one request through the proxied hostname. Then prefer `X-Real-IP` when `BEHIND_PROXY === 'true'` (both in `getUpgradeIp` and via a custom `keyGenerator` on the rate limiters), falling back to the XFF logic. Since Caddy sets it from `{remote_host}` with `trusted_proxies` configured, it is the correct value in both the Cloudflare and no-Cloudflare cases.

---

### 7. Medium — `handlePcMessage` operates on the global `pcSocket` instead of the socket that sent the message

`server/src/index.js:1397` (`ws.on('message', handlePcMessage)`), `server/src/index.js:1414-1449`, `server/src/index.js:1391-1395`.

```js
    if (pcSocket && pcSocket.readyState === 1) {
      console.log('[pc] Replacing previous PC socket.');
      pcSocket.close(1000, 'Replaced by new connection');
    }
    pcSocket = ws;
```
```js
      if (!timingSafeEqual(incoming, PC_KEY_FINGERPRINT)) {
        console.warn('[pc] Public key fingerprint mismatch — rejecting connection.');
        if (pcSocket) pcSocket.close(4003, 'Public key fingerprint mismatch');
```

CONFIRMED: `handlePcMessage(raw)` receives no socket reference and never checks whether the sender is the current `pcSocket`. A replaced socket is asked to close gracefully but stays readable until the close handshake completes, and its `message` listener is still attached.

**Failure scenarios.** (a) A stale socket sends a bad `pubkey`; the handler closes and nulls **the new, legitimate** `pcSocket` (`index.js:1436-1442`), taking the relay offline. (b) During the overlap window, results, progress, and `error` messages from the stale socket are processed as authoritative — `completeJob` is called with whatever payload it supplies. (c) `pcPublicKeyB64 = msg.publicKey` (`index.js:1445`) is global, so the last writer wins regardless of which socket is active.

Related, smaller: the close handler's `if (pcSocket === ws)` guard (`index.js:1403`) means a socket that gets replaced never clears `pcPublicKeyB64`, so a newly connected PC inherits the previous PC's cached key until it sends its own `pubkey`. Phones fetching `/pc-pubkey` in that window encrypt to a key the connected PC cannot use — a stuck job, not a confidentiality break (the attacker in this scenario still does not hold the pinned private key).

**Fix.** Bind the handler per socket: `ws.on('message', (raw) => handlePcMessage(ws, raw))` and make the first line `if (ws !== pcSocket) return;`. In the fingerprint-mismatch branch, close `ws`, not the global.

---

### 8. Medium — A malformed `PC_PUBLIC_KEY_FINGERPRINT` silently disables pinning, or crashes the process on the first `pubkey`

`server/src/index.js:106-112`, `server/src/index.js:1436`.

```js
const _pcFingerprintHex = (process.env.PC_PUBLIC_KEY_FINGERPRINT ?? '').replace(/:/g, '').toLowerCase();
const PC_KEY_FINGERPRINT = _pcFingerprintHex.length === 64
  ? Buffer.from(_pcFingerprintHex, 'hex')
  : null;
```

The guard checks the **string** length, not the decoded buffer length. `Buffer.from(str, 'hex')` stops at the first invalid pair. CONFIRMED by running `node -e`: `Buffer.from('z'.repeat(64),'hex').length === 0`, and `timingSafeEqual` with mismatched lengths throws `"Input buffers must have the same byte length"`.

Two outcomes, both bad:
- A fingerprint that is not 64 characters (a truncated paste, a trailing newline that survives, the `sha256:` prefix form) yields `PC_KEY_FINGERPRINT = null`. In local mode that **silently turns pinning off** with no log line. In remote mode the process exits, which is the right behaviour.
- A fingerprint that is exactly 64 characters but contains a non-hex character yields a short buffer. `timingSafeEqual` at `index.js:1436` then throws inside a `ws` `message` listener. With no `process.on('uncaughtException')` anywhere (see finding 5), the process dies. Under `restart: unless-stopped` the PC reconnects, sends `pubkey`, and it dies again — a crash loop that also wipes the in-memory job queue each time.

**Fix.** Validate with `/^[0-9a-f]{64}$/` after stripping colons and whitespace, and `console.warn` loudly whenever pinning ends up disabled in local mode. Guard the comparison with `incoming.length === PC_KEY_FINGERPRINT.length` regardless.

---

### 9. Low/Medium — Account enumeration at `POST /auth/register`, and a timing oracle at `POST /auth/login/email`

`server/src/index.js:1039-1044`, `server/src/index.js:1086-1101`; claim at `docs/AUTHENTICATION.md:41`.

```js
  const existingAny = findUserByEmail(normalizedEmail);
  if (existingAny) {
    // Surface the same generic message regardless of which auth method was used
    // to avoid leaking whether an account exists with a specific sign-in method.
    return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
  }
```

CONFIRMED. The comment is about not leaking *which method* — but the `409` itself discloses that an account exists at all, with only the 10/min `emailAuthLimiter` in the way and no failure counter. `docs/AUTHENTICATION.md:41` claims enumeration is prevented; that claim is scoped to login, and register is the easier oracle.

CONFIRMED separately at `index.js:1088-1092`: when the email is unknown, the handler returns immediately without an argon2 verify. A real account takes an argon2id verify at 64 MiB / 3 iterations (tens of milliseconds); an unknown one returns in under a millisecond. That is a comfortably measurable side channel on the endpoint the doc says is enumeration-safe.

**Fix.** For login, run a dummy `argon2Verify` against a fixed throwaway hash on the not-found and no-password-row branches so both paths cost the same. For register, the usual remedy is to return the same `200 { status: 'registration_pending' }` regardless and deliver the "you already have an account" information by email — if that is too much machinery here, at least add register misses to a per-IP failure counter like the login one, and say plainly in `docs/AUTHENTICATION.md` that registration discloses existence.

---

### 10. Low — A suspended admin is accepted on `/ws/admin` and stays connected for up to five minutes

`server/src/index.js:1944-1947`, `server/src/index.js:1962-1966`.

```js
    const adminUser = getUserById(payload.userId);
    if (!adminUser || !adminUser.is_admin) { sendJson(ws, { type: 'auth_failed' }); ws.close(4003, 'Not admin'); return; }
```

CONFIRMED: the WS admin handshake checks `is_admin` but not `status === 'active'`, unlike `requireAdmin` in `auth.js:140-145` which checks both. The 5-minute revalidation timer at `index.js:1962` does check status, so the window is bounded. Exposure is limited — `handleAdminSocket` registers no message handler and the socket only receives `{type:'codes_changed'}` / `{type:'users_changed'}` pings — but it is an inconsistency with the HTTP path and it tells a suspended admin that things are happening.

**Fix.** Add `|| adminUser.status !== 'active'` to the line 1945 condition.

---

### 11. Low — `ALLOWED_ORIGINS` entries are not trimmed, and the same untrimmed array gates the WebSocket Origin check

`server/src/index.js:300-305`, `server/src/index.js:1315-1327`.

```js
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : undefined;
```

CONFIRMED. `ALLOWED_ORIGINS=https://a.example, https://b.example` produces `" https://b.example"` with a leading space, which matches neither the CORS check nor `allowedOrigins.includes(reqOrigin)` at `index.js:1324`. The failure is a confusing 403 on WebSocket upgrade for the second hostname, which a deployer is likely to "fix" by clearing the variable — and clearing it disables both the CORS restriction *and* the CSWSH Origin check (`index.js:1317`). The DEPLOY_MODE guard at `index.js:303` only catches the empty case when `DEPLOY_MODE=remote` happens to be set on the server container. Note `docs/CONFIGURATION.md:22` describes `DEPLOY_MODE` purely as a pc-client setting, so an operator deploying without `docker-compose.yml` has no reason to set it on the relay — and then neither the `ALLOWED_ORIGINS` nor the `PC_PUBLIC_KEY_FINGERPRINT` production guard fires.

**Fix.** `.split(',').map(s => s.trim()).filter(Boolean)`. Separately, document `DEPLOY_MODE` in `docs/CONFIGURATION.md` as also being read by the server to enforce the two production guards.

---

### 12. Low — PC-controlled strings of unbounded length reach the logs

`server/src/index.js:1477`, `:1481`, `:1506`, `:1541`, `:1548`.

```js
  console.warn(`[pc] Unhandled message type: ${msg.type}`);
```

CONFIRMED. `msg.type`, `msg.jobId` and `msg.message` are interpolated into log lines with no length bound, and the WS frame cap is 100 MB. The phone handler explicitly defends against exactly this — `index.js:1761-1762`: "Do NOT echo msg.type back — an attacker could send a large string to inflate log output" — so the intent is there, it just was not applied to the PC side. Requires `PC_SECRET`, hence Low; the consequence is log-volume amplification and disk pressure on the VPS.

**Fix.** Truncate: `String(msg.type).slice(0, 64)`, same for `jobId` and the PC error message.

---

### 13. Low — CSP is disabled in helmet; only the Caddy edge supplies one

`server/src/index.js:306`.

```js
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
```

CONFIRMED. In the Tier-2 deployment this is covered: `Caddyfile:45` sets a well-constructed CSP and Caddy serves the SPA from `/var/www/html`, so the Node server never serves HTML in that topology. In Tier-1 (local/Tailscale), `index.js:1198-1203` mounts `express.static(clientDist)` and an `app.get('*')` SPA fallback, and those responses go out with no CSP, no `X-Frame-Options` beyond helmet's defaults, and no `Referrer-Policy` tuning. That is the deployment where the user's browser holds the vault master key in memory.

**Fix.** Give helmet the same directives the Caddyfile uses (or read them from one shared place) rather than switching CSP off wholesale.

---

### 14. Low — Per-code and per-user socket maps accumulate empty `Set`s

`server/src/index.js:145-152`, `server/src/index.js:167-174`.

```js
function unregisterCodeSocket(codeId, ws) {
  phoneCodeSockets.get(codeId)?.delete(ws);
}
```

CONFIRMED: the `Set` is removed from, never the key from the `Map`. Growth is bounded by the number of distinct invite codes and user IDs ever seen, so this is housekeeping rather than a DoS — worth noting only because the author fixed the equivalent leak carefully for `submitRateLimiter` (`index.js:1255-1263`) and `wsUpgradeTracker` (`index.js:1245-1250`).

**Fix.** `if (set && set.size === 0) phoneCodeSockets.delete(codeId);` in both unregister functions.

---

### 15. Info — Progress is broadcast to every connected phone, and result replay is not session-scoped

`server/src/index.js:1465-1471`, `server/src/index.js:1675-1690`.

```js
    const publicPayload = { type: 'progress', value, max };
    for (const [ws] of allPhoneSockets) {
      if (ws.readyState !== 1) continue;
      sendJson(ws, ws === job?.phoneWs ? ownerPayload : publicPayload);
```

CONFIRMED and deliberate — `docs/API.md:72-73` documents both shapes, and the owner-only variant is what carries `jobId` and `node`. The residual leak is that every connected session learns another user's step count and step total, which reveals the `steps` setting and roughly how long each job runs. Acceptable for the stated "personal or small-group" threat model; flagging it so the choice stays conscious.

Separately: the completed-job replay loop (`index.js:1675`) keys on `queueUserId` with no `isSessionOnline` guard, unlike the recovery loop above it (`index.js:1641-1643`). A user's second tab therefore drains and deletes results the first tab was still waiting for. Same-user only, so not a confidentiality issue, but it will look like a lost result.

---

### 16. Info — A stolen session JWT yields the wrapped master key for offline attack

`server/src/index.js:650-665` (`POST /vault/unlock`).

CONFIRMED: the endpoint returns the requested wrapped blob to any caller passing `requireActive`, with no step-up and no rate limit beyond the 200/min `apiLimiter`. This is inherent to the design — the browser must fetch the blob to unwrap it — and PBKDF2 at 600 000 iterations (`docs/ARCHITECTURE.md:113`) is a reasonable work factor. Worth stating explicitly in `docs/VAULT.md` (owned by another reviewer) that session-token theft downgrades vault security to the strength of the vault password, since `docs/PRIVACY.md:15` frames the master key as simply unreachable.

---

## Thumbnail trace

The exact path, hop by hop. **Answer: no plaintext thumbnail is ever written to disk or to the database, but yes, the server process holds it in plaintext memory well beyond transient forwarding — up to 30 minutes, and it re-sends it from that copy on reconnect.**

| # | Hop | Location | What happens to the plaintext thumbnail |
|---|-----|----------|------------------------------------------|
| 1 | PC generates it | `pc-client/main.py:184-189` | 200 px WebP from the *decrypted* result image, base64-encoded. Not encrypted — the full image next to it is (`main.py:194`). |
| 2 | PC sends it | `pc-client/main.py:197-200` | `{type:'result', jobId, payload:<encrypted>, thumbnail:<plain b64 webp>}` |
| 3 | Server validates | `server/src/index.js:1489-1509` | Length ≤ `THUMB_MAX_B64_LEN` (350 000), base64 charset regex, and a RIFF/WEBP magic check on the decoded bytes. Plaintext bytes are materialised here (`Buffer.from(msg.thumbnail,'base64')`). |
| 4 | Server logs | `server/src/index.js:1506` | Only `jobId` and `thumbBuf.length`. No image data in logs. **Clean.** |
| 5 | **Server stores in RAM** | `server/src/index.js:1512` → `server/src/jobs.js:59-64` | `completeJob(...)` sets `job.thumbnail = <plain b64 webp>` on the in-memory job object. **This is the retention.** |
| 6 | Server relays | `server/src/index.js:1513-1520` | `sendJsonAck` to `job.phoneWs`; `deleteJob` runs only in the flush callback **if `delivered`**. |
| 7 | If not delivered | `server/src/jobs.js:289-300`, `server/src/index.js:1980` | The job stays in the `jobs` Map, thumbnail attached, until `pruneOldJobs` collects terminal jobs older than **30 minutes**. |
| 8 | Replay on reconnect | `server/src/index.js:1675-1690` | `if (job.thumbnail) replayMsg.thumbnail = job.thumbnail;` — re-sent from the retained plaintext copy, then deleted. |
| 9 | Browser encrypts | `client/src/App.svelte:187`, `client/src/components/Result.svelte:156-167` | AES-256-GCM under the vault master key, before upload. |
| 10 | Server stores ciphertext | `server/src/index.js:762-812` → `server/src/db.js:700-713` | `POST /results` re-validates base64, enforces the 12-byte IV and the 270 KB ciphertext cap, writes `encrypted_thumb`/`iv_thumb`. |
| 11 | DB schema | `server/src/db.js:304-336` (migration v12) | Only `encrypted_thumb BLOB` + `iv_thumb BLOB`. The earlier plaintext `thumb` column from v7 was dropped and its data discarded. **No plaintext column exists.** |
| 12 | Read back | `server/src/index.js:850-864` | Returns the ciphertext and IV; the browser decrypts. |

No path writes the plaintext thumbnail to disk, to SQLite, or to a log. The residual exposure is memory: heap dump, core file, swap, or root access on the relay host reveals a recognisable 200 px version of every image generated in the last 30 minutes.

---

## Doc claims checked

| Claim | Source | Verdict | Pointer |
|---|---|---|---|
| "the relay forwards encrypted blobs it cannot read" / "it never decrypts anything" | README.md:5, :50 | Does not hold | Plaintext WebP thumbnail of every result: index.js:1489-1520 |
| "No prompts, images, or results are visible to it at any point" | ARCHITECTURE.md:11 | Does not hold | Same; contradicted by PRIVACY.md:17 |
| "the relay may see the thumbnail transiently during delivery… never stored server-side in plaintext" | PRIVACY.md:17 | Partially | DB claim holds (db.js:304-336). "Transiently" understates 30-min RAM retention + replay (jobs.js:64, index.js:1685) |
| Prompts / reference images never stored on relay | PRIVACY.md:61-62, README.md:88 | Holds | `payload` only ever forwarded as an opaque string; index.js:231, :1512; never logged |
| Audit log stores identity + IP + timestamp, no payloads, pruned after 6 months | PRIVACY.md:53, README.md:94 | Holds | index.js:1900-1908, db.js:487-491, index.js:1272-1273 (24 h schedule) |
| Plaintext metadata is "email, tos_accepted_at, tos_version, quota counters, job timestamps" | PRIVACY.md:41 | Partially | Also `users.name`, `users.picture` (Google profile URL) and `job_audit_log.ip_address` — the last is disclosed two sections later but missing from this list |
| PC_SECRET compared in constant time | ARCHITECTURE.md:119 | Holds | auth.js:75-81 (early length return leaks only the length — standard) |
| PC fingerprint pinning required when `DEPLOY_MODE=remote`, `timingSafeEqual` | ARCHITECTURE.md:127 | Holds, with caveats | index.js:109-112, :1436. Silently off for a malformed value in local mode; can crash on a 64-char non-hex value (finding 8) |
| `ALLOWED_ORIGINS` required in production | CONFIGURATION.md:40 | Partially | Enforced only when `DEPLOY_MODE === 'remote'` is set *on the server*, which CONFIGURATION.md:22 describes as a pc-client variable |
| `GOOGLE_CLIENT_ID` "optional when running e-mail/password-only deployments" | CONFIGURATION.md:20 | Does not hold | Leaving it unset turns `/auth/google` into an unauthenticated login oracle (finding 1) |
| Login returns 401 regardless of whether the email exists, "to prevent account enumeration" | AUTHENTICATION.md:41 | Partially | Response body is identical (index.js:1088-1101) but timing is not; and register discloses via 409 (index.js:1041) |
| Register: argon2id 65 536 KiB / 3 iterations / parallelism 1 | AUTHENTICATION.md:33 | Holds | index.js:1022 |
| Register + login share a 10 req/min per-IP limiter | AUTHENTICATION.md:54 | Holds | index.js:317, :322-323, with `authLimiter` skipping both (index.js:316) so each request uses one bucket |
| Login brute force: 15 failures per IP per 15 min | AUTHENTICATION.md:40 | Holds | index.js:1078-1083 |
| Code brute force: 20/IP/60 s hard, 500 global/60 s soft | AUTHENTICATION.md:87-88 | Holds | index.js:889-905 |
| Codes are 40 bits of entropy | AUTHENTICATION.md:81 | Holds | index.js:494-501; 32-char alphabet divides 256 evenly, so `bytes[i] % 32` is unbiased |
| New accounts always start with 0 uses | AUTHENTICATION.md:68 | Holds | `users.uses_remaining INTEGER DEFAULT 0` (db.js:30); `createUser` never sets it |
| Two users on one `job_access` code cannot cancel each other's jobs | AUTHENTICATION.md:100-104 | Holds | Cancel authorises on `ownerSessionId` (index.js:1747); recovery and replay skipped for code users (index.js:1645, :1675) |
| Admins "cannot modify your own account or other admins" | ADMIN.md:31 | Partially | Self `status` change blocked and other admins blocked (index.js:1164-1178), but an admin *may* set their own `usesRemaining` — deliberate per the comment at index.js:1169 |
| `queue`/`activeJobId` only for the owning socket; others get aggregates | API.md:69 | Holds | index.js:208-217, jobs.js:204-240 |
| Phone auth is first-message, 2 s timeout, JWT never in the URL | API.md:60 | Holds | index.js:1341-1345, :1550-1556 |
| `/pc-pubkey` requires active-or-code | API.md:22 | Holds | index.js:440 |
| `POST /results` max 20 MB | API.md:35 | Holds | index.js:773-776 |
| `{type:"submit", payload}` is the full submit shape | API.md:67 | Partially | The server also accepts and echoes `clientToken` (index.js:1915-1919); undocumented |
| Max queued jobs per user = 3 | ARCHITECTURE.md:53 | Holds | index.js:87, :1805-1808 |

---

## What is done well

These are not courtesies — each one is a mistake the code specifically avoids.

- **Cancel authorization is session-scoped, not identity-scoped.** `index.js:1747` checks `job.ownerSessionId === wsSessionId`, and `handlePhoneSocketAuthenticated` mints a fresh `uuidv4()` per connection (`index.js:1628`). This is the right call for shared `job_access` codes, and the reasoning is written down at `index.js:1745-1746`. The matching decision to skip job recovery and result replay entirely for code users (`index.js:1641-1648`) closes the other half of the same hole.
- **Quota decrements are atomic.** `atomicDecrementUserUses` and `atomicDecrementCodeUses` are `UPDATE … WHERE id = ? AND uses_remaining > 0` (`db.js:165-167`, `db.js:186-188`) and the handlers branch on `result.changes === 0` (`index.js:1843`, `index.js:1873`). No read-then-write race across tabs. The post-decrement refetch to broadcast the authoritative value (`index.js:1849`, `index.js:1878`) is the detail most implementations get wrong.
- **`POST /results` validates the thumbnail envelope properly.** Base64 charset regex, a 16-character cap on the IV *before* decoding to prevent oversized-IV injection, then an exact 12-byte check after (`index.js:777-786`). `fullSizeBytes` is clamped to the actual buffer length because the client value is advisory (`index.js:793-799`). That is careful work.
- **Registration is a single SQLite transaction with the argon2 hash computed outside it.** `index.js:1030-1052` — no orphaned user row, no consumed invite code on failure, and no 100 ms hash held inside a write transaction. The `isKnown400` marker to distinguish the invite-code race from a real failure is clean.
- **JWTs are never put in URLs.** Both `/ws/phone` and `/ws/admin` authenticate via a first message with a short timeout (`index.js:1331-1345`), specifically so tokens do not land in proxy access logs — and the reasoning is in the comment.
- **PC error messages are never forwarded.** `index.js:1533-1537` replaces the PC's message with a fixed `'Processing failed'` because tracebacks carry file paths and library versions; the detail goes to the server log only. The pc-client does the same on its side (`pc-client/main.py:208-211`). Defence at both ends.
- **`sendJsonAck` waits for the socket flush before deleting the job.** `index.js:246-263` and `index.js:1516-1519` — the distinction between "`send()` did not throw" and "the OS accepted the bytes" is one most people never make, and here it is the difference between a delivered result and a silently lost one.
- **`clientToken` is echoed back on the `queued` ack.** The comment at `index.js:1911-1914` describes the exact bug it prevents: a one-shot `queued` listener for submit B firing on submit A's ack and binding B's AES key to A's job. That is a bug found by thinking, not by a crash.
- **`getUpgradeIp` takes the right-most XFF hop and says why.** `index.js:1268-1278` — the left-most entry is attacker-controlled, and most codebases take `[0]`. The logic is correct for the single-proxy case; finding 6 is about the two-proxy topology the Caddyfile enables by default.
- **Duplicate-submit and per-user-across-reconnect rate limiting.** The submit limiter is keyed on `queueUserId` at module scope (`index.js:118-120`) so it survives reconnects, and the per-socket payload-hash dedupe (`index.js:1817-1825`) catches double-taps. Both maps are pruned on a timer (`index.js:1255-1263`).
- **The v12 migration is the right instinct.** `db.js:304-336` deliberately tore out the plaintext `thumb` column introduced in v7, discarded the data rather than pretending it could be retrofitted, and wrote down why. Whoever made that call understood the threat model; finding 3 is about finishing the job in memory.
- **Background timers are collected and cleared on shutdown.** `index.js:1219-1232` — the `schedule()` helper exists so nothing leaks a `setInterval` past `server.close()`.
- **`seed-admin.js` refuses to guess.** When an email matches both a Google and an email-auth row it prints both and exits rather than promoting the wrong one (`seed-admin.js:31-42`).
