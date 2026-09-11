# Review C — server data layer, job queue, and deployment

**Verdict.** The cryptographic story holds up where it matters most: I read every column in `server/src/db.js` and found no prompt text, no plaintext image, and no plaintext thumbnail anywhere in the schema. Thumbnails really are client-encrypted (`encrypted_thumb` + `iv_thumb`, written only from a browser-supplied base64 blob), full results really are stored with IVs, and PBKDF2/PRF salts are stored exactly as `docs/VAULT.md` describes. The "blind relay" claim survives contact with the data model. What does not survive contact is the *operational* half of the promise. Three things concern me most: the table-rebuild migrations (v7, v12) are not atomic and have a crash window in which a restart silently destroys every user's encrypted gallery; a PC disconnect mid-job permanently wedges the global queue for six hours because `processing` is never reset; and the in-memory job store holds the full encrypted payload for the life of every job, so the documented 50-job cap maps to several gigabytes of RAM on the 1 GB VPS the docs recommend. On the compliance side, two documented promises do not hold as written: the 6-month audit-log prune never fires on a server that restarts more often than once a day (which is every push to `main`), and there is no account-deletion path at all, so the GDPR erasure language in the TOS and `docs/PRIVACY.md` is aspirational.

---

## Findings

### 1. Critical-adjacent (High) — Non-atomic table-rebuild migrations can silently destroy every stored result

**Files:** `server/src/db.js:151-175` (v7), `server/src/db.js:302-334` (v12), `server/src/db.js:251-277` (v9), `server/src/db.js:279-289` (v10)

**Evidence.** v12 is a single `db.exec()` of seven statements with no `BEGIN`/`COMMIT`:

```js
db.exec(`
  DROP TABLE IF EXISTS stored_results_v12;
  CREATE TABLE stored_results_v12 ( ... );
  INSERT INTO stored_results_v12 (...) SELECT ... FROM stored_results;
  DROP TABLE stored_results;
  ALTER TABLE stored_results_v12 RENAME TO stored_results;
  ...
`);
db.pragma('user_version = 12');
```

`better-sqlite3`'s `exec()` runs these in autocommit mode — each statement commits independently. The author clearly knew this risk: the v8 block at `db.js:177-249` is explicitly wrapped in `BEGIN; ... COMMIT;` with a comment saying "a crash between DROP TABLE and RENAME would otherwise leave the DB without a users table." v7, v9, v10 and v12 did not get the same treatment.

**Failure scenario (CONFIRMED by reading the control flow, not by running it).** Crash, `SQLITE_FULL`, or `SQLITE_BUSY` between `DROP TABLE stored_results` and `ALTER TABLE ... RENAME`. State on disk: `stored_results` gone, `stored_results_v12` holds all the data, `user_version` still 11. On restart:

1. The top-level DDL at `db.js:60-69` runs `CREATE TABLE IF NOT EXISTS stored_results (...)` and **recreates it empty** (with the stale pre-v7 shape).
2. The v12 block runs again and its first statement is `DROP TABLE IF EXISTS stored_results_v12` — **this destroys the only surviving copy of every user's encrypted gallery.**
3. It then copies zero rows from the empty table and completes "successfully", setting `user_version = 12`.

No error is raised. Every user's vault contents are gone, and by design they are unrecoverable — the relay holds only ciphertext and the master key never left the browser, so there is no re-derivation path. The `DROP TABLE IF EXISTS ..._v12` guard that the v9 comment calls "safe to retry after a mid-migration crash" (`db.js:254`) is precisely the statement that causes the loss.

v7 (`db.js:156-173`) has the same window but a different outcome: its `CREATE TABLE stored_results_v7` has no `IF NOT EXISTS`, so a retry throws `table stored_results_v7 already exists` at import time and the server never starts. v9 retried after a crash throws `no such table: job_audit_log` — but only *after* its `DROP TABLE IF EXISTS job_audit_log_v9` has already discarded the recovered rows. v10's bare `ALTER TABLE stored_results ADD COLUMN job_id` (`db.js:284`) has no `try`/`catch`, unlike the otherwise-identical v1/v2/v4/v11 blocks, so a partial application bricks startup with `duplicate column name: job_id`.

**Fix.** Wrap every rebuild in an explicit transaction the way v8 already does, and make the recovery order safe: `CREATE ..._vN` → `INSERT` → `DROP old` → `RENAME` → `pragma user_version` all inside one `BEGIN`/`COMMIT`, and never `DROP` the staging table before you have confirmed the real table still exists. `db.transaction(() => { ... })` from better-sqlite3 is the idiomatic wrapper and is already used elsewhere in this file (`db.js:693`). Add the missing `try`/`catch` to v10 for consistency with v1/v2/v4/v11.

---

### 2. High — A PC disconnect mid-job deadlocks the entire queue for six hours

**Files:** `server/src/index.js:225-234`, `server/src/index.js:1399-1412`, `server/src/jobs.js:89-96`, `server/src/jobs.js:289-301`

**Evidence.** `'processing'` is assigned in exactly one place and cleared in none:

```
$ grep -n "'processing'" server/src/index.js
231:  updateJobStatus(next.id, 'processing');
1460:    if (!job || job.status !== 'processing') return;
1748:          const wasProcessing = job.status === 'processing';
```

`dispatchNextJob` short-circuits on any processing job (`index.js:227`): `if (getActiveJob()) return; // already processing one`. The PC close handler (`index.js:1399-1408`) only nulls `pcSocket` and `pcPublicKeyB64`; it touches no job. On reconnect, `index.js:1411` calls `dispatchNextJob()`, which immediately returns because `getActiveJob()` still finds the abandoned job.

**Failure scenario.** The PC crashes, loses its network, or is simply restarted while a job is dispatched. The job stays `processing` forever. `dispatchNextJob()` becomes a no-op for **every user on the relay**, permanently. Nothing recovers it: the job is non-terminal, so `pruneOldJobs` (`jobs.js:289`) only reaps it after `orphanMs = 6 * 60 * 60 * 1000`. Users' submissions pile up as `pending`, each consuming one of their three slots and holding its payload in RAM, and the only operator remedy is a server restart. Note the user whose job was dispatched has already had their quota decremented (`index.js:1847-1857`) and gets no refund.

**Fix.** In the PC `close` handler, find the active job and either (a) mark it `error`, notify the owner, and `deleteJob` it, or (b) reset it to `pending` so it redispatches on reconnect — (b) is better, since the payload is still held and the PC may come back in seconds. Either way, call `dispatchNextJob()` and `broadcastQueueUpdate()` afterwards. A cheap belt-and-braces addition: have `dispatchNextJob` skip a `processing` job whose `phoneWs`/dispatch timestamp is older than the PC's own 10-minute timeout.

---

### 3. High — Job payloads are never released, so the queue caps map to gigabytes of RAM

**Files:** `server/src/jobs.js:30-46`, `server/src/jobs.js:59-72`, `server/src/index.js:91`, `server/src/index.js:94`, `server/src/index.js:1216`, `docs/DEPLOYMENT.md:30`

**Evidence.** `createJob` stores the full base64 payload on the job object (`jobs.js:40`), `dispatchNextJob` reads it (`index.js:230`) but never clears it, and `completeJob` adds two more blobs on top:

```js
job.encryptedResult = encryptedResult;
job.thumbnail = thumbnail ?? null;
```

Nothing in `jobs.js` or `index.js` ever assigns `job.payload = null`. The caps: `MAX_PAYLOAD_B64 = 100 * 1024 * 1024` (`index.js:94`), `wss` `maxPayload: 100 * 1024 * 1024` (`index.js:1216`), `MAX_TOTAL_QUEUE_DEPTH` default 50 (`index.js:91`, `.env.example:54`). `docs/DEPLOYMENT.md:30` recommends "1 GB RAM is plenty."

**Failure scenario.** 50 queued jobs × 100 MB base64 = 5 GB of strings — and V8 stores these as two-byte-per-character strings, so the true heap cost is closer to 10 GB. A single authenticated user can reach 3 × 100 MB on their own; the per-user limit does not bound the global figure, and `MAX_TOTAL_QUEUE_DEPTH` does. The relay OOMs long before the cap is reached on the recommended VPS. Because the job store is in-memory, the OOM kill also drops every in-flight job. This is reachable by an ordinary quota-holding user, not just an attacker.

**Fix.** Set `job.payload = null` immediately after `sendJson(pcSocket, ...)` succeeds in `dispatchNextJob` — the payload is not needed again (there is no redispatch path today, and if you add one per finding #2, keep the payload only for the single `processing` job). Separately, either lower `MAX_PAYLOAD_B64` to something matched to the real image sizes (the HTTP body limit is already 30 MB — `index.js:310`) or scale `MAX_TOTAL_QUEUE_DEPTH` down so `MAX_PAYLOAD_B64 × MAX_TOTAL_QUEUE_DEPTH` fits the documented RAM budget, and say so in `docs/DEPLOYMENT.md`.

---

### 4. Medium — The claimed 6-month audit-log prune never runs on a server that restarts daily

**Files:** `server/src/index.js:1222-1226`, `server/src/index.js:1280-1281`, `server/src/index.js:1983-1984`, `.github/workflows/deploy.yml:20-22`, `.github/workflows/deploy.yml:125`, `docs/PRIVACY.md:53`, `README.md:94`

**Evidence.** `schedule()` is a bare `setInterval` with no leading call:

```js
function schedule(fn, intervalMs) {
  const t = setInterval(fn, intervalMs);
  backgroundTimers.push(t);
  return t;
}
```

and the audit prune is registered as:

```js
const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
schedule(() => pruneJobAuditLogsOlderThan(SIX_MONTHS_MS), 24 * 60 * 60 * 1000);
```

Compare the revoked-token prune three lines from the end of the file, which the author *did* remember to run at startup: `pruneRevokedTokens(); schedule(() => pruneRevokedTokens(), 60 * 60 * 1000);` (`index.js:1983-1984`).

**Failure scenario.** `deploy.yml` triggers on every push to `main` and ends with `docker compose up -d --build --force-recreate` (`deploy.yml:125`), which restarts the container. Any deploy cadence more frequent than 24 hours means the timer never reaches its first tick and `job_audit_log` grows without bound. `docs/PRIVACY.md:53` states entries are "**automatically deleted after 6 months** (pruned daily)" and `README.md:94` repeats "Entries auto-delete after 6 months." Those rows carry `email`, `google_sub`, and `ip_address` — plaintext personal data whose retention limit is the stated GDPR minimisation control. **CONFIRMED** by reading `schedule`; I did not run the server.

**Fix.** One line: call `pruneJobAuditLogsOlderThan(SIX_MONTHS_MS)` once before scheduling it, matching the `pruneRevokedTokens` pattern. Consider doing the same for `pruneCodeAuthFailures` / `pruneEmailLoginFailures` (their 5-minute intervals make this much less urgent, but stale IP rows survive a restart until the first tick either way).

---

### 5. Medium — No account-deletion path; the GDPR erasure claim does not hold, and a manual `DELETE` would fail

**Files:** `server/src/index.js:1133-1204` (the only `/admin` routes), `server/src/db.js:20-33`, `db.js:40`, `db.js:48`, `db.js:62`, `db.js:218`, `db.js:134-144`, `db.js:693-696`, `server/src/tos-content.js:79-85`, `docs/PRIVACY.md:19`, `docs/PRIVACY.md:41`

**Evidence.** The full route inventory (`grep -n "app\.\(get\|post\|put\|patch\|delete\)(" server/src/index.js`) contains `GET /admin/users` and `PATCH /admin/users/:id` and nothing else under `/admin`. `grep -n "DELETE FROM users\|deleteUser" server/src/*.js` returns nothing. The only erasure primitive is `deleteVault` (`db.js:693`), which is correctly transactional and does wipe both blobs and keys:

```js
export const deleteVault = db.transaction((userId) => {
  stmtDeleteAllResultsByUser.run(userId);
  stmtDeleteVault.run(userId);
});
```

but it leaves the `users` row, `invite_codes` created by them, their `job_audit_log` rows, and their `revoked_tokens` entries untouched.

Worse, a DBA doing this by hand would hit a wall. `PRAGMA foreign_keys = ON` is set at `db.js:16`, and only one child table declares a cascade:

- `invite_codes.created_by INTEGER NOT NULL REFERENCES users(id)` — no `ON DELETE` (`db.js:40`)
- `vault_keys.user_id INTEGER UNIQUE NOT NULL REFERENCES users(id)` — no `ON DELETE` (`db.js:48`)
- `stored_results.user_id INTEGER NOT NULL REFERENCES users(id)` — no `ON DELETE` (`db.js:62`, `db.js:314`)
- `email_auth.user_id ... REFERENCES users(id) ON DELETE CASCADE` — the only one (`db.js:218`)
- `job_audit_log` — **no foreign key at all** (`db.js:134-144`), so its `email` / `google_sub` / `ip_address` rows survive any user deletion by construction

`DELETE FROM users WHERE id = ?` therefore raises `FOREIGN KEY constraint failed` for any user who has a vault, a saved result, or an issued invite code.

**Failure scenario.** A user exercises GDPR Art. 17. The TOS the user legally accepted promises "Upon deletion, all vault keys and encrypted results are permanently destroyed" (`tos-content.js:82-85`) and `docs/PRIVACY.md:41` instructs the deployer to "Ensure your admin tooling can export and wipe a user record cleanly." No such tooling exists, and the obvious manual command errors out. The operator either leaves the request unfulfilled or starts hand-editing SQLite with FKs disabled.

**Fix.** Add a `DELETE /admin/users/:id` (and ideally a self-service account-deletion endpoint) implemented as a single `db.transaction` that removes, in order: `stored_results`, `vault_keys`, `email_auth`, `invite_codes` created by the user, `job_audit_log` rows for the user, and finally the `users` row. Adding `ON DELETE CASCADE` to the three child tables would need another table rebuild, so an explicit transaction is the cheaper and clearer route. Decide deliberately whether `job_audit_log` rows should be deleted or pseudonymised — there is an arguable legal-obligation basis for retaining them for the 6-month window, but that argument needs to be written down in `docs/PRIVACY.md`, not left implicit.

---

### 6. Medium — `.env.example` ships `DEPLOY_MODE=local`, which silently disables both production guards

**Files:** `.env.example:9`, `server/src/index.js:110-113`, `server/src/index.js:299-303`, `SETUP.md:34`, `docs/DEPLOYMENT.md:20`

**Evidence.** Two production safety checks are keyed exclusively on `DEPLOY_MODE === 'remote'`:

```js
if (!PC_KEY_FINGERPRINT && process.env.DEPLOY_MODE === 'remote') {
  console.error('[security] FATAL: PC_PUBLIC_KEY_FINGERPRINT is required in remote mode. ...');
  process.exit(1);
}
```
```js
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : undefined;
if (!allowedOrigins && process.env.DEPLOY_MODE === 'remote') {
  throw new Error('[security] ALLOWED_ORIGINS must be set in remote mode');
}
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : undefined));
```

`.env.example:9` sets `DEPLOY_MODE=local`, `.env.example:41` leaves `ALLOWED_ORIGINS` blank, and `.env.example:89` leaves `PC_PUBLIC_KEY_FINGERPRINT` blank. `SETUP.md:34` instructs `cp .env.example .env`. The variable's own documentation frames it as a *pc-client* concern — `.env.example:7-8` describes it purely in terms of where the pc-client connects, and `docs/CONFIGURATION.md:22` says "Tells the pc-client where the relay lives." Nothing signals that it gates server-side security.

**Failure scenario (two paths, both CONFIRMED from the docs).**
- Tier 1: `docs/DEPLOYMENT.md:20` explicitly instructs `DEPLOY_MODE=local` for a Tailscale deployment that is reachable from phones. That deployment runs with CORS accepting **every** origin and with PC public-key pinning unenforced server-side, and neither is surfaced as a warning. `SETUP.md:76` describes the fingerprint as "optional but recommended for Tier 1," which is consistent with the code but understates that the browser-side pin (`VITE_PC_KEY_FINGERPRINT`) is then the only check.
- Tier 2: a deployer who copies `.env.example` to the VPS rather than following `docs/DEPLOYMENT.md`'s hand-written recipe gets `DEPLOY_MODE=local` on a public host, with both guards off. `docker-compose.yml:16` defaults to `remote` only when the variable is *unset*; an explicit `local` wins.

**Fix.** Make the guards depend on the actual exposure rather than on a pc-client routing hint: fail hard whenever `ALLOWED_ORIGINS` is unset and `NODE_ENV !== 'development'`, or gate on `FLUX_KLEIN_HOST` being set. At minimum, log a loud startup warning in `local` mode listing exactly which checks are disabled, and rewrite the `.env.example:6-9` comment so it says that `DEPLOY_MODE=remote` also enables required-origin and required-fingerprint enforcement.

---

### 7. Medium — The Docker image ignores `package-lock.json`, so deployed dependency versions are whatever npm resolves that day

**Files:** `server/Dockerfile:10-13`, `server/package.json:11-23`, absent `.dockerignore`

**Evidence.**

```dockerfile
COPY package.json ./
RUN npm install --omit=dev \
    && (test -d node_modules/@node-rs/argon2 || ...)
```

`server/package-lock.json` is never copied and `npm install` is used rather than `npm ci`. Every dependency in `package.json` uses a caret range (`"express": "^4.19.2"`, `"ws": "^8.17.1"`, `"jsonwebtoken": "^9.0.2"`, …), so each image build resolves fresh. The lockfile that *is* committed pins reasonable versions — express 4.22.1, ws 8.20.0, jsonwebtoken 9.0.3, better-sqlite3 11.10.0, `@node-rs/argon2` 2.0.2, `path-to-regexp` 0.1.13, `qs` 6.14.2, `cookie` 0.7.2 — all current enough that I found no known-vulnerable pin. But nothing in the deployment path uses it.

Note the contrast with the frontend, where the author got it right: `deploy.yml:51` runs `npm ci` against `client/package-lock.json`.

**Failure scenario.** A malicious or broken minor release of any transitive dependency lands in production on the next `docker compose up --build`, with no lockfile review and no way to reproduce a known-good image. The build cannot even be bisected, since two builds of the same commit can differ. There is also no `.dockerignore` anywhere in the repo, so the build context is whatever happens to be in `server/` on the VPS.

**Fix.** `COPY package.json package-lock.json ./` and `RUN npm ci --omit=dev`. Add a `server/.dockerignore` containing at least `node_modules`, `data`, `.env*`. This also lets you drop the `rm -rf server/node_modules` workaround at `deploy.yml:124`.

---

### 8. Medium — The deploy workflow does no SSH host-key verification

**File:** `.github/workflows/deploy.yml:84-126`

**Evidence.** All four `appleboy/scp-action` and `appleboy/ssh-action` steps pass only `host`, `username`, `key` (and `source`/`target`/`script`). No `fingerprint:` input is set on any of them. Both actions fall back to accepting any host key when no fingerprint is supplied.

**Failure scenario.** An attacker able to influence DNS resolution or routing for `secrets.VPS_HOST` on a GitHub-hosted runner receives the SSH session — which means receiving `secrets.SSH_PRIVATE_KEY`'s authentication attempt, the full `server/` source, the built frontend, and the `docker-compose.yml`. This is a first-connection-every-time situation: the runner is ephemeral, so there is no `known_hosts` that could catch a change.

**Fix.** Capture the VPS host key once (`ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -`) and pass it as a `VPS_FINGERPRINT` repo secret via the actions' `fingerprint:` input on all four steps. While you are in the file, add a top-level `permissions: {}` block — the workflow needs no `GITHUB_TOKEN` scopes and currently inherits the repository default.

---

### 9. Medium — The v8 unique-index creation swallows every error, including the one that matters

**File:** `server/src/db.js:239-244`

**Evidence.**

```js
try {
  db.exec(`
    CREATE UNIQUE INDEX idx_users_email_unique_email_auth
      ON users(email) WHERE google_sub IS NULL
  `);
} catch { /* already exists on fresh DB */ }
```

The comment is wrong about its own premise: this index is created in exactly one place in the file, and v8 has just recreated the `users` table from scratch, so on a fresh DB it cannot already exist. The only realistic reason this statement fails is `UNIQUE constraint failed: users.email` — i.e. the existing data already contains two email-auth rows on one address. The catch discards that signal.

**Failure scenario.** A DB that already has duplicate email-auth users (from a pre-v8 bug or manual edit) migrates "successfully" with no index. From then on the only protection against duplicate email-auth accounts is the application-level check the comment at `db.js:236-238` describes as a supplement — and `findEmailUserByEmail` (`db.js:555-557`) uses `.get()`, silently returning whichever row SQLite picks first, so login becomes non-deterministic between the two accounts. The author was clearly aware of this class of ambiguity: `findAllUsersByEmail` (`db.js:546-548`) exists precisely to let callers disambiguate.

**Fix.** Drop the `try`/`catch` and let the migration fail loudly, or catch narrowly on `err.code === 'SQLITE_ERROR'` with an "index already exists" message and rethrow everything else. Logging the swallowed error would be the one-line improvement.

---

### 10. Low — Plaintext thumbnails are held in server RAM for the replay path, contradicting the inline comment

**Files:** `server/src/index.js:1488-1512`, `server/src/jobs.js:59-72`, `server/src/index.js:1673-1688`, `docs/PRIVACY.md:17`, `docs/VAULT.md:41`

**Evidence.** The comment at `index.js:1489-1490` says "We validate format here but never store it," and two lines later:

```js
completeJob(msg.jobId, msg.payload, relayedThumbnail);
```

which lands in `jobs.js:64` as `job.thumbnail = thumbnail ?? null` — a raw base64 WebP of the generated image, retained on the job object in the in-memory `jobs` Map. It is read back on reconnect at `index.js:1685`: `if (job.thumbnail) replayMsg.thumbnail = job.thumbnail;`.

**Failure scenario.** In the happy path this is genuinely brief: `sendJsonAck` deletes the job as soon as the socket flushes (`index.js:1516-1519`). But when the phone socket drops before the flush, the job stays `done` and the thumbnail persists in RAM until `pruneOldJobs` reaps terminal jobs at `maxAgeMs = 30 min`, on a 10-minute interval — so up to ~40 minutes. A relay memory dump, a core file, or a swap page during that window contains a 200 px rendering of the user's generated image. The DB is clean (this never touches disk — **CONFIRMED**, there is no `thumb` column post-v12), so this is a scope-of-claim issue, not a storage breach. `docs/PRIVACY.md:17` and `docs/VAULT.md:41` both say the relay "may see the thumbnail transiently during delivery," which is fair for the happy path and understated for the replay path.

**Fix.** Correct the `index.js:1489-1490` comment — it is actively misleading to a future reader auditing the encryption boundary. Then decide whether the replay convenience is worth it: dropping `job.thumbnail` and letting the gallery fetch the encrypted thumbnail after the user re-saves would remove the plaintext-in-RAM window entirely. If you keep it, add a sentence to `docs/PRIVACY.md:17` saying the raw thumbnail is held in relay memory (never on disk) for up to ~40 minutes when delivery fails.

---

### 11. Low — Caddy sets `X-Real-IP`, nothing reads it; and the Cloudflare trusted-proxy list omits IPv6

**Files:** `Caddyfile:23-24`, `Caddyfile:30`, `Caddyfile:53`, `Caddyfile:72`, `server/src/index.js:1283-1297`, `docs/DEPLOYMENT.md:149`

**Evidence.** The Caddyfile sets `header_up X-Real-IP {remote_host}` on both the `/ws*` and `@backend_routes` proxies, and its comment at line 24 claims this matters ("breaking rate-limiting, the audit log, and `header_up X-Real-IP` down to the Node.js relay"). But `grep -n "x-real-ip" server/src/index.js` returns nothing. The relay derives the client IP two ways, both from `X-Forwarded-For`: `app.set('trust proxy', 1)` for HTTP (`index.js:295-296`), and the rightmost-hop scan in `getUpgradeIp` for WS upgrades (`index.js:1289-1296`). The rightmost-hop reasoning at `index.js:1285-1288` is correct and well-argued for a single trusted proxy.

Separately, the `trusted_proxies static` list at `Caddyfile:30` contains only Cloudflare's IPv4 ranges. Cloudflare's published IPv6 ranges (`2400:cb00::/32`, `2606:4700::/32`, `2803:f800::/32`, `2405:b500::/32`, `2405:8100::/32`, `2a06:98c0::/29`, `2c0f:f248::/32`) are absent, despite the "Updated for 2026" comment at line 27.

**Failure scenario.** Both are conditional on a Cloudflare-proxied deployment, which `docs/DEPLOYMENT.md:145-157` documents as supported. When Cloudflare reaches Caddy over IPv6, the edge node is not a trusted proxy, so `{remote_host}` is the Cloudflare IPv6 address. Every visitor then shares one of a handful of source IPs from the relay's perspective, which (a) collapses `authLimiter` / `emailAuthLimiter` / the WS upgrade limiter into a shared bucket — one abusive client locks out everyone behind the same edge node — and (b) records a useless IP in `job_audit_log.ip_address`, the field whose whole purpose is compliance attribution. I have **INFERRED** the exact `X-Forwarded-For` composition Caddy produces under `trusted_proxies`; I did not run it. The dead `X-Real-IP` header and the missing IPv6 ranges are both **CONFIRMED** by reading.

**Fix.** Add the IPv6 ranges to `Caddyfile:30`. Either delete the two `header_up X-Real-IP` lines as dead config, or — better, and more robust than the rightmost-XFF heuristic — have `getUpgradeIp` prefer `req.headers['x-real-ip']` when `BEHIND_PROXY=true`, since Caddy's `{remote_host}` already resolves trusted proxies correctly. Then verify end-to-end behind a Cloudflare-proxied record before trusting the audit log's IP column.

---

### 12. Low — `ivFull` is unvalidated in `POST /results` while `ivThumb` is strictly validated

**File:** `server/src/index.js:738-815`

**Evidence.** `encryptedThumb`/`ivThumb` get a careful gauntlet — base64 regex, a pre-decode length check with a comment explaining that a 12-byte GCM IV is exactly 16 base64 chars, a post-decode `ivThumbBuf.length !== 12` check, and a size cap (`index.js:778-796`). `ivFull` gets only a truthiness check at line 741 and is then passed straight through:

```js
ivFull: Buffer.from(ivFull, 'base64'),
```

No base64 regex, no 12-byte length assertion. If `ivFull` is a non-string truthy value (`{}`, `[1,2]`, `42`), `Buffer.from` throws `TypeError`; the surrounding `catch` at `index.js:810` only special-cases `SQLITE_CONSTRAINT_UNIQUE` and rethrows, producing a 500. If it is a malformed string, `Buffer.from(s, 'base64')` silently yields a short or empty buffer that is stored and only fails later, at decrypt time in the browser.

**Failure scenario.** Low impact — this is the user's own row and their own key, so the worst case is a self-inflicted permanently-undecryptable gallery entry plus a noisy 500. But it is an inconsistency a reader will trip over, and it stores data the invariant says cannot exist.

**Fix.** Apply the same three checks to `ivFull` that lines 780-792 already apply to `ivThumb`, and return 400 rather than 500.

---

### 13. Low — SPA responses get only four security headers; helmet covers the API only

**Files:** `Caddyfile:41-47`, `server/src/index.js:307`

**Evidence.** `app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))` applies to responses the Node relay produces. In the Docker topology, Caddy serves the built Svelte app directly from `/var/www/html` (`Caddyfile:79-83`, `docker-compose.yml:38`) and helmet never sees those requests. The Caddy `header` block supplies `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, `Content-Security-Policy`, and `Referrer-Policy` — a good set, and the CSP is notably well-constructed (`script-src 'self' https://accounts.google.com`, no `'unsafe-inline'` on scripts). Missing from it: `base-uri` and `form-action`, neither of which falls back to `default-src`; and there is no `Permissions-Policy`, `Cross-Origin-Opener-Policy`, or `Cross-Origin-Resource-Policy` on the static responses.

**Failure scenario.** Requires an HTML-injection foothold to matter, and I found none in this slice — so this is defence-in-depth, not an active hole. With `base-uri` unset, an injected `<base href>` can redirect every relative script URL; `'self'` in `script-src` would still gate the origin, so the practical risk is genuinely small.

**Fix.** Append `base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'` to the CSP at `Caddyfile:45`, and add `Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()"`. Be careful with `Cross-Origin-Opener-Policy` — Google Sign-In's popup flow needs `same-origin-allow-popups` at most, so test before adding it.

---

### 14. Low — Quota is consumed before dispatch and never refunded

**File:** `server/src/index.js:1847-1857`, `server/src/index.js:1869-1889`

**Evidence.** `atomicDecrementUserUses` / `atomicDecrementCodeUses` run inside `handleJobSubmit` *before* `createJob`. Both are correctly atomic (`db.js:363-365`, `db.js:384-386`) — the TOCTOU-across-tabs race the comments call out is genuinely closed, and the re-read-after-decrement pattern for notifications is right. But there is no compensating increment on any failure path: PC error (`index.js:1528+`), user cancel (`index.js:1748-1756`), or the six-hour stall from finding #2.

**Failure scenario.** A user with a 10-generation quota loses a use every time the PC errors out or they cancel a running job. Combined with finding #2, a single PC crash burns a use and then blocks the user from retrying.

**Fix.** Refund on the `error` and `cancelled` transitions (an `UPDATE users SET uses_remaining = uses_remaining + 1 WHERE id = ? AND uses_remaining IS NOT NULL` guarded so a job can only be refunded once), or move the decrement to `completeJob`. The refund-on-terminal approach is less invasive and keeps the anti-flood property of charging up front.

---

### 15. Low — No backup story for `server_data`, and by design nobody else can reconstruct it

**Files:** `docker-compose.yml:21-22`, `docker-compose.yml:44-47`, `docs/DEPLOYMENT.md` (whole file), `server/src/db.js:15`

**Evidence.** The database lives in a Docker named volume (`server_data:/app/data`, `DB_PATH=/app/data/comfylink.db`). `docs/DEPLOYMENT.md` contains no `docker run --rm -v server_data:... tar` recipe, no mention of backups, and no warning before `docker compose down -v` (which `docs/DEPLOYMENT.md:154` comes close to, using the safe `up -d --force-recreate` form). `db.js` sets `journal_mode = WAL` but leaves `synchronous` at the WAL default of `NORMAL`, so an unclean host shutdown can lose recently committed transactions.

**Failure scenario.** Losing the volume destroys every user's vault permanently. This is worse here than in a typical app precisely *because* the encryption works: there is no server-side copy of anything, and the master key never left the browser, so there is no recovery path of any kind — not even a painful one.

**Fix.** Add a short "Backups" section to `docs/DEPLOYMENT.md` with a `sqlite3 .backup` or volume-tar one-liner and a note that this is unrecoverable if skipped. Consider `db.pragma('synchronous = FULL')` — the write volume here is tiny, so the durability is nearly free.

---

### 16. Info — Assorted smaller items

- **`countStoredResults` TOCTOU** (`index.js:746-748`): the quota check and the insert are separate statements, so concurrent uploads can exceed `MAX_RESULTS_PER_USER` by the number of in-flight requests. Bounded and low-impact; worth a `db.transaction` if you touch this code.
- **Pagination cursor mixes keys** (`db.js:435-437`): `WHERE user_id = ? AND id < ? ORDER BY created_at DESC`. `id` is autoincrement and `created_at` is `Date.now()` at insert, so they agree today; if a backfill or clock adjustment ever breaks that correlation, the gallery will skip or repeat rows. Ordering by `id DESC` would make the cursor self-consistent.
- **No forward-version guard** (`db.js:83-334`): opening a `user_version = 12` database with code that only knows through v10 runs no migration and then fails at `db.prepare` time with a confusing column error. A `if (userVersion > LATEST) throw new Error('DB is newer than this build')` check at the top would fail clearly instead.
- **`TOS_VERSION` is whitespace-sensitive** (`tos-content.js:14-15`): the version is a hash of the file's entire source, so editing a comment, reflowing a paragraph, or a stray trailing newline forces every user to re-accept. The file's own header comment presents this as the design, and it is a defensible trade (it can never under-bump), but it is worth knowing before a cosmetic edit.
- **`VPS_HOST` vs `VPS_SSH_HOST`** naming drift: `.env.example:119` and `docs/CONFIGURATION.md:44` call it `VPS_SSH_HOST`; `deploy.yml:5` and `docs/DEPLOYMENT.md:78` call the GitHub secret `VPS_HOST`. They are different things (one is for manual deploys, one is a repo secret) but the near-identical names invite a mix-up.
- **Stale files accumulate on the VPS**: `scp-action` copies over the existing tree without deleting, so a source file removed from the repo lingers in `$VPS_PATH/server/src` forever. Harmless today because the Dockerfile copies the whole `src/`, but it means deleted code can keep running.

---

## Data-at-rest inventory

Every column in `server/src/db.js` as of migration v12. "Metadata" means non-content data that is nonetheless linkable to a person.

| table.column | Classification | Who writes it | Retention |
|---|---|---|---|
| `users.id` | metadata | server, `createUser` (`db.js:563`) | until manual deletion (no endpoint — finding #5) |
| `users.google_sub` | **plaintext PII** (Google account identifier) | server, from a verified Google ID token | same |
| `users.email` | **plaintext PII** | server, from Google token or `/auth/register` | same |
| `users.name` | **plaintext PII** | server, from Google token | same |
| `users.picture` | **plaintext PII** (googleusercontent URL) | server, from Google token | same |
| `users.status`, `.is_admin`, `.uses_remaining` | metadata | admin via `PATCH /admin/users/:id` | same |
| `users.tos_accepted_at`, `.tos_version` | metadata | server, `updateTosAccepted` (`db.js:598`) | same |
| `users.created_at`, `.updated_at` | metadata | server | same |
| `invite_codes.code` | secret (bearer credential, plaintext) | admin via `POST /codes` | until deleted by creator |
| `invite_codes.created_by`, `.type`, `.uses_remaining`, `.expires_at`, `.created_at` | metadata | admin | same |
| `vault_keys.encrypted_master_key_bio` | **ciphertext** (AES-KW, key never server-side) | browser via `POST /vault/setup` | until `DELETE /vault` |
| `vault_keys.encrypted_master_key_pw` | **ciphertext** | browser | same |
| `vault_keys.encrypted_master_key_recovery` | **ciphertext** | browser | same |
| `vault_keys.prf_salt` | salt — non-secret by design, as `docs/VAULT.md:16` documents | browser | same |
| `vault_keys.pbkdf2_salt` | salt — same | browser | same |
| `vault_keys.prf_credential_id` | metadata (WebAuthn credential ID) | browser | same |
| `vault_keys.prf_public_key` | public key — non-secret | browser | same |
| `stored_results.encrypted_thumb` | **ciphertext** (AES-256-GCM, vault master key) | browser via `POST /results` | until `DELETE /results/:id` or `DELETE /vault` |
| `stored_results.iv_thumb` | IV — non-secret, 12 bytes enforced (`index.js:790`) | browser | same |
| `stored_results.encrypted_full` | **ciphertext** (AES-256-GCM, vault master key) | browser | same |
| `stored_results.iv_full` | IV — non-secret, **length unvalidated** (finding #12) | browser | same |
| `stored_results.full_size_bytes` | metadata (clamped to actual length, `index.js:766-772`) | server | same |
| `stored_results.job_id` | metadata (UUID; links a row to an audit entry) | browser, echoing the server's UUID | same |
| `stored_results.created_at` | metadata | server | same |
| `job_audit_log.email`, `.google_sub` | **plaintext PII** | server, `createJobAuditLog` (`db.js:802`) | nominally 6 months — **prune does not fire** (finding #4) |
| `job_audit_log.ip_address` | **plaintext PII** | server, from `req.ip` / `getUpgradeIp` | same |
| `job_audit_log.job_id`, `.user_type`, `.user_id`, `.code_id`, `.created_at` | metadata | server | same |
| `email_auth.password_hash` | hash (argon2id via `@node-rs/argon2` 2.0.2) | server, `/auth/register` | cascades on user delete (`db.js:218`) |
| `email_auth.verification_token`, `.token_expires_at` | secret (unused — `db.js:826-828` says sending is not implemented) | never written today | n/a |
| `email_auth.email_verified` | metadata (hardcoded `1`, `db.js:834`) | server | same |
| `revoked_tokens.jti` | metadata (JWT ID of a logged-out token) | server, `/auth/logout` | pruned hourly past expiry (`index.js:1983-1984`) |
| `code_auth_failures.ip_address`, `.attempted_at` | **plaintext PII** (IP) | server on failed `/auth/code` | pruned every 5 min, 5-min window (`index.js:1274`) |
| `email_login_failures.ip_address`, `.attempted_at` | **plaintext PII** (IP) | server on failed email login | pruned every 5 min, 15-min window (`index.js:1277`) |

**No prompt text, no plaintext image, and no plaintext thumbnail appears in any column.** Confirmed by reading the full schema and every `INSERT`/`UPDATE` prepared statement in `db.js`. The only plaintext image-derived data anywhere in the system is the in-RAM `job.thumbnail` (finding #10).

---

## Doc claims checked

| Claim | Source | Verdict | Pointer |
|---|---|---|---|
| Gallery thumbnails are stored encrypted, never plaintext server-side | `docs/PRIVACY.md:17`, `docs/VAULT.md:41`, `README.md:90` | **holds** | `db.js:312-322` (`encrypted_thumb`/`iv_thumb`), written only from browser base64 at `index.js:800-805`; v12 migration explicitly discarded the old plaintext `thumb` column (`db.js:302-334`) |
| The relay "may see the thumbnail transiently during delivery" | `docs/PRIVACY.md:17` | **partially** | true for the happy path; the replay path keeps the raw WebP in RAM up to ~40 min (finding #10). Never on disk. |
| Result blobs stored with IVs | `docs/VAULT.md:41` | **holds** | `iv_full` and `iv_thumb` are `BLOB NOT NULL` / `BLOB` (`db.js:316-318`); `iv_thumb` is strictly validated, `iv_full` is not (finding #12) |
| Prompts are never stored on the relay | `README.md:88`, `docs/PRIVACY.md:43`, `tos-content.js:72-73` | **holds** | no prompt column exists; the encrypted payload lives only in the in-memory job store (`jobs.js:40`) and is never written to SQLite |
| PBKDF2 and PRF salts are stored server-side | `docs/VAULT.md:16` | **holds** | `vault_keys.pbkdf2_salt`, `vault_keys.prf_salt` (`db.js:52-53`); written from browser-supplied values (`db.js:670-671`) |
| Audit log excludes payloads and image blobs | `docs/PRIVACY.md:53`, `README.md:94`, `db.js:800` | **holds** | `job_audit_log` has nine columns, all identity/IP/timestamp (`db.js:257-267`); `createJobAuditLog` (`db.js:802`) accepts no blob parameter |
| Audit log entries auto-delete after 6 months, pruned daily | `docs/PRIVACY.md:53`, `README.md:94` | **does not hold** | `schedule()` never calls its fn at startup (`index.js:1222-1226`); first tick is 24 h out and every deploy restarts the container (finding #4) |
| Upon deletion, all vault keys and encrypted results are destroyed | `tos-content.js:82-85`, `docs/PRIVACY.md:19` | **partially** | `DELETE /vault` does exactly this, transactionally (`db.js:693-696`). But there is no *account* deletion, and a manual `DELETE FROM users` fails on FK RESTRICT (finding #5) |
| "Ensure your admin tooling can export and wipe a user record cleanly" | `docs/PRIVACY.md:41` | **does not hold** | `/admin` exposes only `GET /admin/users` and `PATCH /admin/users/:id` (`index.js:1133`, `index.js:1154`) |
| The plaintext-metadata list in PRIVACY §4 | `docs/PRIVACY.md:41` | **partially** | lists email, `tos_accepted_at`, `tos_version`, quota counters, timestamps; omits `google_sub`, `name`, `picture`, `invite_codes.code`, and the plaintext IPs in `job_audit_log` / `code_auth_failures` / `email_login_failures` |
| `TOS_VERSION` is a hash of `tos-content.js`; acceptance is current only when `users.tos_version === TOS_VERSION` | `docs/TOS.md:5-7` | **holds** | hash at `tos-content.js:14-15`; per-version storage at `db.js:370-372`; enforcement at `index.js:1843` (`userRow.tos_version !== TOS_VERSION` blocks submission) |
| Code-user ToS acceptance is not persisted server-side | `docs/TOS.md:9` | **holds** | the `tos_version` gate at `index.js:1836-1845` sits inside the `jwtPayload?.type !== 'code_user'` branch |
| Queue is FIFO, in-memory, lost on restart, 3 jobs/user | `docs/ARCHITECTURE.md:40-56` | **holds** | `jobQueue` array scanned in insertion order (`jobs.js:81-87`); `MAX_QUEUE_PER_USER = 3` (`index.js:89`) enforced at `index.js:1806` |
| "On completion (or error/cancel), the server dispatches the next pending job" | `docs/ARCHITECTURE.md:46` | **partially** | true for those three transitions; silently false when the PC disconnects mid-job, which wedges dispatch for 6 h (finding #2) |
| `avgDuration` is a rolling average of the last 10, default 60 s | `docs/ARCHITECTURE.md:85` | **holds** | `MAX_DURATION_SAMPLES = 10`, `DEFAULT_AVG_DURATION_MS = 60_000` (`jobs.js:27-28`), computed at `jobs.js:193-197`. Note it measures submit→complete, so it includes queue wait — `jobs.js:66` documents this, `ARCHITECTURE.md` does not |
| Cloudflare trusted-proxy block is "Updated for 2026" | `Caddyfile:27` | **partially** | IPv4 ranges are current; all IPv6 ranges are missing (finding #11) |
| Every env var read by the server is documented | `docs/CONFIGURATION.md` | **holds** | all 15 vars in `grep -o "process\.env\.[A-Z_0-9]*" server/src` appear in the table. Two documented vars (`VPS_URL`, `GGUF_MODEL`) are real pc-client vars missing from `.env.example` — Info only |

---

## What is done well

These are not throwaway compliments; each is something I checked specifically because it is commonly gotten wrong.

- **The v8 migration is genuinely careful** (`db.js:177-249`). It wraps the `users` table rebuild in `BEGIN`/`COMMIT`, toggles `foreign_keys = OFF` *before* the transaction (SQLite silently ignores that pragma inside one — an easy trap), restores it in a `finally`, and the comment explains both the crash window and why the `IF EXISTS` guard makes a retry safe. Everything findings #1 asks for in v7/v9/v10/v12 is already demonstrated here.

- **Both quota decrements are properly atomic.** `stmtAtomicDecrementUserUses` (`db.js:363-365`) and `stmtAtomicDecrementCodeUses` (`db.js:384-386`) fold the check into the `UPDATE` with `AND uses_remaining > 0` and use `result.changes` as the verdict, closing the multi-tab TOCTOU the comments describe. The follow-up re-read before notifying (`index.js:1858-1862`, `index.js:1884-1887`) means clients see the authoritative value rather than a computed guess.

- **Result access is user-scoped at the SQL layer, not in the handler.** Every single-row statement carries `AND user_id = ?` — `stmtGetResultFull`, `stmtGetResultThumb`, `stmtDeleteResult` (`db.js:443-453`). There is no code path where forgetting a check in the route would leak another user's blob; the IDOR is structurally impossible rather than defended against.

- **`sendJsonAck`** (`index.js:246-263`) waits for the socket to actually flush before deleting the completed job, and the comment explains precisely why `send()` not throwing is a weaker signal. That is the difference between "usually delivers the result" and "never silently drops it," and most implementations get this wrong.

- **The rightmost-hop `X-Forwarded-For` reasoning** (`index.js:1283-1296`) is correct and, more importantly, *written down* — including why `hops[0]` is attacker-controlled. It matches `app.set('trust proxy', 1)` for the HTTP routes, so the two IP-derivation paths agree.

- **The cancel authorisation uses `ownerSessionId`, not `queueUserId`** (`index.js:1745-1747`), with a comment explaining that code users share a `queueUserId` and so the coarser check would let one session cancel another's job. The same reasoning drives skipping recovery and replay entirely for code users (`index.js:1647-1652`) — a subtle multi-tenancy hazard the author found and closed on purpose.

- **`deleteVault` is a real transaction** (`db.js:693-696`), so results and keys go together. A half-completed vault deletion would be exactly the sort of thing to make an erasure claim untrue.

- **`pruneOldJobs`'s two-tier policy** (`jobs.js:276-301`) has the best comment in the codebase: it explains why in-flight jobs deliberately outlive terminal ones, names the PC's 10-minute WS timeout, and says the orphan cutoff must stay above it. That is reasoning a future maintainer can actually act on.

- **`backgroundTimers` + `server.on('close')`** (`index.js:1219-1230`) means the process can actually quiesce. Most Node services accumulate orphan `setInterval` handles and hang on shutdown.

- **The frontend build uses `npm ci` against a lockfile** (`deploy.yml:38`, `deploy.yml:51`), and the "Verify build-time config was inlined" step (`deploy.yml:59-74`) catches a class of failure — an unset repo secret producing a silently broken bundle — that normally ships to production unnoticed. The step leaks nothing: the only value it greps for is a public-key fingerprint that is inlined into the public bundle by design.

- **The Docker privilege drop is done correctly and explained** (`server/Dockerfile:19-27`, `server/entrypoint.sh`): root only long enough to `chown` the volume, then `gosu` to `node` before `exec`, with a comment saying why there is no `USER` instruction. No host ports on the server service (`docker-compose.yml:5`) — Caddy is the only ingress, and the DB lives in a named volume rather than a bind mount.

- **`.gitignore` covers the real hazards**: `.env` plus `.env.*` with a `!.env.example` negation in the correct order, `*.pem` for the PC private key, and `data/` / `*.db` / `*.sqlite*` for the database. I found no path by which a secret or the DB could be committed.

- **`initAuth` fails closed** (`auth.js:17-27`): empty `JWT_SECRET` or `PC_SECRET` (and the literal `"changeme"`) throw at startup rather than silently signing tokens with `undefined`. Combined with `.env.example` shipping both blank, a half-configured deployment cannot start — which is exactly right, and makes the `DEPLOY_MODE` gap in finding #6 the only remaining foot-gun in that file.
