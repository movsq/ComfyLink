# Review D — Client crypto, vault, and auth (ComfyLink)

**Verdict.** The primitives are, with one exception, chosen and used correctly. ECDH P-256 + HKDF-SHA-256 with direction-split info strings, AES-256-GCM with a fresh 96-bit random IV per operation, AES-KW envelope wrapping, PBKDF2-SHA-256 at 600 000 iterations, and a byte-exact, standards-conformant BIP-39 24-word recovery encoding (I verified the bit-packing and checksum against the canonical all-zero test vector and 2 000 random round-trips). PC key fingerprint pinning is genuinely fail-closed and runs *before* the ECDH import. Session tokens live only in memory — never `localStorage`, never in a URL, never in the WebSocket query string — and the master key is cleared on logout. The exception is significant and it is not in the crypto: **the PC ships a 200 px plaintext WebP preview of every generated image through the relay alongside the encrypted payload**, which the relay reads, stores on the in-memory job object, and forwards. Three documents disclose this honestly; `docs/ARCHITECTURE.md` and `README.md` state the opposite in absolute terms. Separately, **recovery-phrase unlock is wired up but throws the recovered master key away** — a user who loses both password and passkey cannot actually recover, despite the recovery phrase being the documented last resort. Everything else is hardening, dead code, and doc drift.

---

## Findings

### 1. High — Recovery-phrase unlock derives the master key and then discards it

`client/src/components/VaultSettings.svelte:101-133`

```js
const mk = await unwrapMasterKey(wrappedBuf, wrappingKey);

// Recovery unlock succeeded — pass the key up so vault is unlocked
onClose();
// Use the onUnlocked callback pattern — but here we go through onRequestUnlock's pending flow
// For now, just close and let the user know
success = 'Recovery key verified';
mode = 'main';
```

**CONFIRMED by reading.** `mk` is never passed anywhere. `VaultSettings` does not even accept an `onUnlocked` prop — its prop list at `VaultSettings.svelte:12` is `{ token, vaultInfo, masterKey, userEmail, userType, onClose, onUpdated, onRequestUnlock, onVaultReset, requestFreshGoogleToken }` — and the call site at `App.svelte:659-671` passes no unlock callback either. `onClose()` fires first, so the `success` and `mode` assignments on the two following lines run against a component the parent has already torn down (`App.svelte:668` sets `showVaultSettings = false`), meaning even the "Recovery key verified" message is never rendered.

`VaultUnlock.svelte` offers only Biometric (`:80-88`) and Password (`:90-98`); the only route to recovery is the "Manage unlock methods" link at `VaultUnlock.svelte:105`, which lands in this dead end.

**Failure scenario.** A user forgets the vault password and replaces their phone (platform authenticator gone, so the PRF credential is gone with it). They open Vault Settings, enter their 24 words, see nothing happen, and press "RESTORE ACCESS" repeatedly. The vault is permanently inaccessible and the only remaining button is "Reset vault", which deletes every stored image. `docs/VAULT.md:17` and `VaultSetup.svelte:327` ("this is the **only way** to restore your saved results") both promise this path works.

**Fix.** Add an `onUnlocked` prop to `VaultSettings`, wire it to `App.svelte`'s `handleVaultUnlocked` the way `VaultUnlock` is wired at `App.svelte:653`, and call `onUnlocked(mk)` before `onClose()`. Recovery unlock should also lead the user to set a new password (a `rekeyVault` call with a fresh `encryptedMasterKeyPw` + `pbkdf2Salt`), otherwise they are back in the same position on the next visit. Consider surfacing recovery directly in `VaultUnlock` rather than behind a settings link.

---

### 2. High — The relay sees a plaintext thumbnail of every result; two documents claim it sees nothing

Wire path, all **CONFIRMED by reading**:

- `pc-client/main.py:184-199` — the PC generates the thumbnail from the *plaintext* image and attaches it to the result message as raw base64, outside the encrypted payload:
  ```python
  thumb_bytes = await loop.run_in_executor(None, generate_thumbnail, result_bytes)
  thumbnail_b64 = base64.b64encode(thumb_bytes).decode()
  ...
  result_msg: dict = {"type": "result", "jobId": job_id, "payload": encrypted_result}
  if thumbnail_b64:
      result_msg["thumbnail"] = thumbnail_b64
  ```
- `server/src/jobs.js:59-64` — `completeJob(id, encryptedResult, thumbnail)` stores it on the job: `job.thumbnail = thumbnail ?? null;`
- `client/src/App.svelte:187` — the browser takes it straight off the wire: `thumbnail: typeof msg.thumbnail === 'string' ? msg.thumbnail : null`
- `client/src/components/Result.svelte:159-168` — only *then* is it encrypted, with the vault master key, before upload.

The client-side handling is correct: at rest on the server the thumbnail is AES-256-GCM ciphertext under the master key, with its own fresh IV. The problem is purely the live hop.

**What this contradicts (verbatim):**
- `docs/ARCHITECTURE.md:11` — "The relay is **intentionally blind** — it only forwards opaque encrypted blobs. No prompts, images, or results are visible to it at any point."
- `docs/ARCHITECTURE.md:91` — "The relay is a **blind relay** — it cannot read job payloads or results."
- `README.md:72` — "so the relay only ever holds opaque blobs"

**What already discloses it correctly:** `docs/VAULT.md:39`, `docs/PRIVACY.md:17`, `docs/API.md:52` and `:74`, and the comment at `server/src/index.js:128-131`. So this is a deliberate, mostly-documented trade-off, not a hidden leak — but a reader who stops at the README or the architecture overview will believe something false, and a 200 px preview of a generated image is not a trivial disclosure.

**Failure scenario.** A relay operator (or anyone who compromises the relay, or any subpoena) recovers a browsable visual index of every image generated through the service, in real time, without touching a single key. `docs/PRIVACY.md:19`'s GDPR Article 15 position ("those blobs — meaningless without your key") is weaker than stated for anyone whose session was live during collection.

**Fix.** Either (a) encrypt the thumbnail under the per-job result key on the PC — it costs one extra `AESGCM.encrypt` in `pc-client/main.py` and one `decryptPayload` in the browser, and the browser can then re-encrypt under the master key as it does today — or (b) drop the PC-side thumbnail entirely and generate it in the browser from the already-decrypted full image. Note that option (b) is already written and sitting unused: `client/src/lib/vault-crypto.js:316` `generateThumbnail()`. If neither is done, change `ARCHITECTURE.md:11`, `:91` and `README.md:72` to match what `PRIVACY.md:17` already says.

---

### 3. Medium — No Content-Security-Policy, and a third-party script runs on the page that holds the master key

`client/index.html:1-17` ships no CSP meta tag, and `server/src/index.js:306` disables helmet's:

```js
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
```

**CONFIRMED.** The page loads `https://accounts.google.com/gsi/client` (`index.html:11`) and a Google Fonts stylesheet (`index.html:10`), both without SRI (GSI cannot have it). The stale comment at `client/src/components/Result.svelte:150` ("avoids fetch(blob:) which is blocked by CSP connect-src") suggests a CSP existed at some point; there is none now.

**Failure scenario.** The GSI script has full DOM and JS access on the origin that holds `masterKey`, the decrypted `imageBytes` (`Result.svelte:95`), and the session token. Any script injection — from that dependency, from a future XSS, or from a compromised CDN — can call `crypto.subtle.exportKey` on the master key (it is extractable, see finding 4) and exfiltrate it with no CSP `connect-src` to stop the request. For an application whose entire pitch is that the server cannot read your data, the browser-side attack surface should be the tightest part of the stack.

**Fix.** Set a CSP with `default-src 'self'`, an explicit `script-src 'self' https://accounts.google.com`, `connect-src 'self' https://accounts.google.com`, `style-src 'self' https://fonts.googleapis.com 'unsafe-inline'`, `font-src https://fonts.gstatic.com`, `frame-src https://accounts.google.com`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`. Self-host the two font families to drop `fonts.googleapis.com` entirely. Re-enable helmet's CSP with an explicit directive set rather than `false`.

---

### 4. Medium — The unlocked master key is unwrapped as extractable even where it never needs to be

`client/src/lib/vault-crypto.js:97-107`

```js
export async function unwrapMasterKey(wrappedBytes, wrappingKey) {
  return subtle.unwrapKey(
    'raw', wrappedBytes, wrappingKey, 'AES-KW',
    { name: 'AES-GCM', length: 256 },
    true, // extractable
    ['encrypt', 'decrypt'],
  );
}
```

**CONFIRMED.** Extractability is hardcoded `true` for all three callers. Two of them — `VaultUnlock.svelte:34` (bio) and `VaultUnlock.svelte:55` (password) — only ever use the key for `encryptBlob`/`decryptBlob`; they never re-wrap it. Only `VaultSettings.svelte:73` (`wrapMasterKey(masterKey, bioWrappingKey)` when adding a passkey) needs raw access, and WebCrypto requires extractability for `wrapKey`.

**Failure scenario.** With an extractable key living in `App.svelte:65` `masterKey` for the whole session, any script running on the origin (finding 3) turns "read what is on screen" into "steal the key that decrypts the entire vault, forever." Non-extractable keys do not prevent an attacker from using the key while the tab is open, but they do stop the key from being carried away.

**Fix.** Add an `extractable = false` parameter to `unwrapMasterKey` and pass `true` only from `VaultSettings.handleAddBiometric`. Better still: in that one flow, unwrap a second, short-lived extractable copy from the blob just for the re-wrap and let it go out of scope, keeping the long-lived `App.svelte` key non-extractable.

---

### 5. Medium — WebAuthn `user.id` is the raw e-mail, contradicting both the spec and the function's own docstring

`client/src/lib/webauthn.js:44-63`

```js
export async function registerCredential(userId, userName, prfSalt) {
  // Create a user handle from the userId string
  const userIdBytes = new TextEncoder().encode(userId);
  ...
    user: { id: userIdBytes, name: userName, displayName: userName },
```

The JSDoc at `webauthn.js:38` says `@param {string} userId — opaque user ID (e.g. Google sub hash)`. Both call sites pass the e-mail address: `VaultSetup.svelte:67` `registerCredential(userEmail, userEmail, prfSalt)` and `VaultSettings.svelte:63`, identically. **CONFIRMED.**

**Failure scenario.** Two problems. (a) WebAuthn L2 §5.4.3 requires `user.id` to be an opaque byte sequence not containing personally identifying information; with `residentKey: 'preferred'` (`webauthn.js:72`) the credential is discoverable, so the e-mail is written into the authenticator/passkey provider's storage and can be displayed in credential pickers and synced to the platform account. (b) `user.id` is capped at 64 bytes by the spec — a user with an e-mail longer than 64 characters gets a `TypeError` from `navigator.credentials.create()` surfaced as the generic "Biometric setup failed" at `VaultSetup.svelte:92`.

**Fix.** Generate a random 32-byte handle at vault setup, store it server-side alongside `prf_credential_id`, return it from `/vault/info`, and pass it as `user.id`. Keep the e-mail in `user.name`/`user.displayName`, which is where it belongs.

---

### 6. Medium — The WebAuthn ceremony is a PRF oracle only; the stored public key is never verified and cannot be

`client/src/lib/webauthn.js:49` and `:121` both generate the challenge client-side:

```js
challenge: crypto.getRandomValues(new Uint8Array(32)),
```

`registerCredential` returns `publicKey` (`webauthn.js:87`), `VaultSetup.svelte:126` sends it as `prfPublicKey`, and `server/src/index.js:609,630` stores it. I grepped `server/src/index.js` for any assertion verification and found none — there is no endpoint that consumes a WebAuthn signature. **CONFIRMED that the client generates its own challenge; INFERRED (from the grep, not a full read of the server — that file is another reviewer's) that the stored `prf_public_key` is write-only data.**

This is *not* a vulnerability as designed: the security of the bio path comes from the PRF secret, which never leaves the authenticator, not from the assertion. But it has two consequences worth writing down. `POST /vault/unlock` with `method: 'bio'` (`api.js:134`, `server/src/index.js:655-668`) hands the bio-wrapped blob to anyone holding a valid JWT, with no biometric proof — "biometric" is a key-wrapping method here, not an access control. And because the challenge is client-generated, the stored public key can never be upgraded into an authentication factor without also moving challenge issuance server-side.

**Fix.** No code change required for the current design. Add a comment at `webauthn.js:49` and a line in `docs/VAULT.md` stating that the ceremony is used purely to evaluate PRF and that the challenge is deliberately client-side and unverified, so nobody later mistakes `prf_public_key` for an authenticator. If server-side WebAuthn assertion is ever wanted, issue the challenge from the server and verify origin, rpIdHash, flags (UV), and signature counter.

---

### 7. Low — `VaultSettings` imports `exportMasterKey` and never uses it; `deriveKeyFromPassword` is absent, so there is no way to change the vault password

`client/src/components/VaultSettings.svelte:4` imports `exportMasterKey`; grep shows no call in that file. More substantively, the only `rekeyVault` call in the whole client is `VaultSettings.svelte:84`, and it only ever sends `encryptedMasterKeyBio` + `prfCredentialId` + `prfPublicKey`. **CONFIRMED** — there is no "change vault password" flow anywhere in the client.

`docs/VAULT.md:28` describes rekey as "Replace wrapped key blobs (e.g. change password or register new passkey)". Only the passkey half exists. A user whose vault password is compromised has no remedy short of "Reset vault", which deletes all stored images.

**Fix.** Add a change-password flow: unlock, derive a new PBKDF2 key with a fresh 32-byte salt, `wrapMasterKey`, and `rekeyVault({ encryptedMasterKeyPw, pbkdf2Salt, ...stepUp })`. The server already accepts both fields (`server/src/index.js:712-716`). Until then, soften `VAULT.md:28`.

---

### 8. Low — `b64ToBuf` silently decodes non-strings; `null` becomes a 3-byte "salt"

`client/src/lib/vault-crypto.js:349-353` and the near-identical `crypto.js:222-227`:

```js
export function b64ToBuf(b64) {
  const binary = atob(b64);
  ...
```

`atob(null)` coerces to the string `"null"`, which is four valid base64 characters, and returns three bytes — no exception. **CONFIRMED by inspection of the coercion; the reachable paths are narrow.** `server/src/index.js:628` permits `prf_salt` to be `NULL`, and `/vault/info` (`:648`) then returns `prfSalt: null`. `VaultSettings.svelte:60` and `:115` and `VaultUnlock.svelte:28` all do `b64ToBuf(vaultInfo.prfSalt)` with no guard.

**Failure scenario.** Both current setup paths always send a real `prfSalt` (`VaultSetup.svelte:123` and `:173`), so this is not reachable today. But a vault created by an older client, a hand-crafted row, or a future setup path that skips `prfSalt` would silently derive every recovery and PRF wrapping key from the 3-byte constant `[0x9e, 0xe9, 0x65]` instead of failing loudly. Deterministic, so it would appear to work — until someone tries to interoperate.

**Fix.** Throw on a non-string input in both `b64ToBuf` and `b64ToBuffer`, and guard the three `vaultInfo.prfSalt` call sites with an explicit "vault is missing its PRF salt" error.

---

### 9. Low — Vault crypto reads `crypto.subtle` at module load with no secure-context guard

`client/src/lib/vault-crypto.js:13`

```js
const subtle = crypto.subtle;
```

`crypto.js:20-29` does this properly, with a `getSubtle()` accessor that throws the helpful "This app requires a secure context / open it via https:// or http://localhost" message. `vault-crypto.js` does not — on an insecure origin every vault function fails with `Cannot read properties of undefined (reading 'generateKey')`, surfaced to the user as that raw string via `VaultSetup.svelte:92` / `:179`. **CONFIRMED.** Partially mitigated by the banner at `App.svelte:526-530` (`!window.isSecureContext`), which at least explains the situation elsewhere on the page.

**Fix.** Import and use `crypto.js`'s `getSubtle()` in `vault-crypto.js`, or duplicate the guard. Also worth adding `window.isSecureContext` to `checkWebAuthnSupport()` (`webauthn.js:15-19`), which currently reports support on origins where `navigator.credentials.create` will reject.

---

### 10. Low — The relay controls the client's internal event namespace

`client/src/lib/ws.js:110`

```js
emit(msg.type, msg);
```

**CONFIRMED.** After authentication, any `msg.type` the server sends is dispatched straight into the listener table. That table also carries the client's own lifecycle events: `open` (`ws.js:78`), `close` (`:115`), `connection_state` (`:42`), `reconnect_failed` (`:131`), `ws_error` (`:141`). `App.svelte` subscribes to all of them (`:220`, `:226`, `:230`, `:295`).

**Failure scenario.** A compromised or malicious relay can send `{"type":"connection_state","state":"connected"}` to clear the "connection lost" banner while withholding results, or `{"type":"reconnect_failed"}` to make a healthy session look dead. Confidentiality is unaffected — `result` messages still have to carry a `jobId` the tab holds an AES key for (`App.svelte:168-179`), and that check is correct. This is availability/UI spoofing by a party that already controls availability, so the impact is small; the design smell is that trusted-local and untrusted-remote events share one namespace.

**Fix.** Namespace server-originated events (`emit('srv:' + msg.type, msg)`), or validate `msg.type` against an allowlist of the eight protocol messages the app actually handles and `console.warn` on anything else.

---

### 11. Low — Sensitive UI state is not cleared after use

- `client/src/components/VaultSetup.svelte:204-210` — `handleContinue()` clears `password`, `confirmPassword`, and `recoveryBytes`, but **not** `recoveryWords`. The 24-word mnemonic stays in component state and in the rendered DOM (`:329-333`) until the modal unmounts.
- `client/src/components/VaultSetup.svelte:187-191` — `handleCopyWords()` writes the mnemonic to the system clipboard and never offers to clear it. On mobile, clipboard contents are readable by other apps and may sync across devices.
- `client/src/components/VaultUnlock.svelte:44-63` — `password` is never cleared after a successful unlock.
- `client/src/components/Login.svelte:75` — `googleIdToken` is retained in state after login succeeds.

**CONFIRMED.** All are short-lived (the components unmount soon after), so this is hygiene rather than a live exposure. **Fix.** Null the fields in the success paths, and add a "clear clipboard" hint or a timed `navigator.clipboard.writeText('')` after the copy.

---

### 12. Low — `handleDownloadJSON` revokes the blob URL synchronously after `a.click()`

`client/src/components/VaultSetup.svelte:193-202`

```js
const url = URL.createObjectURL(blob);
const a = document.createElement('a'); a.href = url; a.download = 'comfylink-recovery.json';
a.click();
URL.revokeObjectURL(url);
```

**CONFIRMED.** The anchor is never appended to the document, and the URL is revoked in the same synchronous turn as the click. This is a known-flaky pattern — Firefox in particular can cancel the download. If it fails, the user believes their recovery file is saved when it is not, which given finding 1 means both recovery routes silently fail.

**Fix.** Append the anchor to `document.body`, click, then `setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0)`.

---

### 13. Low — Dead code

All **CONFIRMED** by grep across `client/src`; the repository contains no test files at all (`find` for `*test*` returns nothing outside `node_modules`/`.venv`).

| Symbol | Location | Note |
|---|---|---|
| `generateThumbnail` + `_injectWebPAiMetadata` + `_makeWebPChunk` | `vault-crypto.js:230-335` | ~105 lines, no callers. This is the browser-side thumbnail generator that would fix finding 2. |
| `importMasterKey` | `vault-crypto.js:32-40` | No callers. |
| `decodeJobPayload` | `crypto.js:176-184` | Comment says "for the crypto roundtrip test only" — no such test exists. |
| `getResultThumb` | `api.js:208-214` | `Gallery.svelte:69-71` inlines its own `fetch` instead. |
| `exportMasterKey` import | `VaultSettings.svelte:4` | Imported, never called. |
| `masterKeyRaw` | `VaultSetup.svelte:157` | Assigned, never read. Same for the discarded result at `:60`. |

**Fix.** Delete, or (for `generateThumbnail`) put it to work per finding 2.

---

### 14. Info — No forward secrecy against compromise of the PC's static key

`client/src/lib/crypto.js:72-98` derives both direction keys from `ECDH(ephemeral_phone_private, pc_static_public)`; `pc-client/crypto_utils.py:101-130` mirrors it with the PC's long-term private key from disk. The ephemeral half is genuinely fresh per job (`crypto.js:34-36`, called at `Submit.svelte:396`), so a leaked *session* key compromises exactly one job — which is what `docs/ARCHITECTURE.md:101` literally claims, and that claim holds.

But the sentence is easy to misread as full forward secrecy, and it is not: the PC key is static (`pc-client/crypto_utils.py:50-77`, loaded from a PEM and cached). An adversary who records relay traffic and later obtains `PC_PRIVATE_KEY` can re-derive every past session key and decrypt every recorded job and result. **CONFIRMED** from both halves of the implementation.

**Fix.** Either tighten the wording at `ARCHITECTURE.md:101` to "compromise of one job's session key does not affect other jobs; note that compromise of the PC's long-term private key retroactively exposes all recorded traffic", or move to an ephemeral-ephemeral exchange with the PC signing its per-job ephemeral key under the pinned static key.

---

### 15. Info — `VITE_PC_KEY_FINGERPRINT` normalisation does not trim whitespace

`client/src/lib/crypto.js:194`

```js
const pinned = (import.meta.env.VITE_PC_KEY_FINGERPRINT ?? '').replace(/:/g, '').toLowerCase();
if (!pinned || pinned.length !== 64) { throw ... }
```

I verified the built bundle: `client/dist/assets/index-B3aiIR8E.js` contains the literal `"53eebf04…09408".replace(/:/g,"").toLowerCase()`, so the value is inlined at build time as expected, and when the variable is unset Vite emits `void 0`, `?? ''` yields `''`, and the length check throws. **There is no bypass — the pinning is fail-closed, and it runs at `Submit.svelte:394`, before `importPcPublicKey` at `:395`.** Colon-separated digests normalise correctly (64 hex + 31 colons → 64). Case is handled.

The only gap: a stray space or newline around the value survives normalisation and pushes the length past 64, producing the misleading error "PC key fingerprint is not configured" for what is actually a formatting problem. (`loadEnv`/dotenv trims in the common case, so this needs a quoted value with interior padding to bite.) **Fix.** Add `.trim()` before `.replace()`, and split the two failure messages ("not configured" vs "not a 64-hex-character digest").

---

## Crypto parameter table

| Primitive | Algorithm / params | Key size | IV / nonce | KDF | Salt location | file:line |
|---|---|---|---|---|---|---|
| Job key exchange | ECDH P-256, ephemeral phone key × static PC key, `deriveBits(256)` (x-coordinate) | 256-bit shared secret | — | — | — | `crypto.js:34,72-78`; PC mirror `crypto_utils.py:116` |
| Job key (phone→PC) | AES-256-GCM, usage `['encrypt']` only | 256 | 12 B, `crypto.getRandomValues`, fresh per job | HKDF-SHA-256, `info="flux2-klein-v1:job"` | 32 zero bytes (constant, both sides) | `crypto.js:55-56,83-89,109`; PC `crypto_utils.py:96-97,118-123` |
| Result key (PC→phone) | AES-256-GCM, usage `['decrypt']` only | 256 | 12 B, `os.urandom` on the PC | HKDF-SHA-256, `info="flux2-klein-v1:result"` | same 32 zero bytes | `crypto.js:57,90-96`; PC `crypto_utils.py:98,124-129,250` |
| Job wire format | `[u16 BE keyLen][SPKI][12 B IV][ct‖tag]`, big-endian | — | — | — | — | `crypto.js:148-157`; PC decode + bounds checks `crypto_utils.py:135-160` |
| Result wire format | `[12 B IV][ct‖tag]` | — | — | — | — | `crypto.js:166-171`; PC `crypto_utils.py:163-169` |
| PC key pinning | SHA-256 over base64-decoded SPKI DER, hex compare vs build-time constant | 256-bit digest | — | — | — | `crypto.js:193-209`, enforced at `Submit.svelte:394` |
| Vault master key | AES-GCM 256, `generateKey`, extractable | 256 | — | — | — | `vault-crypto.js:18-24` |
| Bio wrapping key | AES-KW, usages `['wrapKey','unwrapKey']` | 256 | — (AES-KW uses the RFC 3394 fixed IV internally) | HKDF-SHA-256, `info="vault-prf-v1"`, IKM = WebAuthn PRF `results.first` | 32 B CSPRNG `prfSalt`, stored server-side, returned by `/vault/info` | `vault-crypto.js:65-74`; salt gen `VaultSetup.svelte:64` |
| Password wrapping key | AES-KW | 256 | — | PBKDF2-SHA-256, **600 000** iterations | 32 B CSPRNG `pbkdf2Salt`, server-side | `vault-crypto.js:44,47-62`; salt gen `VaultSetup.svelte:110,160` |
| Recovery wrapping key | AES-KW | 256 | — | HKDF-SHA-256, `info="vault-recovery-v1"`, IKM = 32 B CSPRNG recovery key | reuses `prfSalt` (see note) | `vault-crypto.js:77-86,130-132`; `VaultSetup.svelte:115,164` |
| Master-key wrapping | AES-KW (RFC 3394), 32 B key → 40 B blob, integrity-checked on unwrap | 256 | — | — | — | `vault-crypto.js:91-107` |
| Vault blob encryption | AES-256-GCM under the master key, 16 B tag appended by WebCrypto | 256 | 12 B, `crypto.getRandomValues`, fresh per blob | — | IV stored next to each ciphertext (`ivFull`, `ivThumb`) | `vault-crypto.js:112-125`; call sites `Result.svelte:154,162` |
| Recovery phrase | 256 bits entropy + 8-bit SHA-256 checksum → 24 × 11-bit BIP-39 indices | 256 | — | — | — | `vault-crypto.js:138-206`; wordlist `bip39-wordlist.js` |

**Notes on the table.**
- The zero HKDF salt is fine and matches RFC 5869's guidance for the "no salt" case; the IKM is a fresh ECDH secret per job, so there is nothing for a salt to add. Both halves agree on it (`crypto.js:55` / `crypto_utils.py:96`).
- The direction split is real and correctly mirrored: I diffed the two info strings byte for byte, and the key `usages` arrays (`['encrypt']` / `['decrypt']`) mean WebCrypto itself would reject a role confusion.
- **Salt reuse:** `prfSalt` is used both as the WebAuthn PRF evaluation salt and as the HKDF salt for the recovery key (`VaultSetup.svelte:115`, `VaultSettings.svelte:116`). The two derivations use different `info` strings and different IKM, so HKDF's domain separation holds and this is not exploitable. It is confusing enough to deserve a separate `recoverySalt` column. Note that in the password-only path (`VaultSetup.svelte:161`) a `prfSalt` is generated purely to serve as the recovery salt, with no WebAuthn credential in sight.
- **IV uniqueness:** every IV is 96-bit random from a CSPRNG and each job key encrypts exactly one message, so job/result IV collision is structurally impossible. The vault master key encrypts many blobs under random 96-bit IVs; at personal-gallery scale (≪ 2³² blobs) the birthday risk is negligible. A deterministic counter would be stronger but is not warranted here.
- **BIP-39 verified, not assumed.** `bip39-wordlist.js` is exactly 2048 entries, sorted, no duplicates, `abandon`…`zoo`. I reimplemented `recoveryKeyToWords`/`wordsToRecoveryKey` line for line and ran 2000 random round-trips: 0 failures. All-zero entropy produces `abandon ×23 art`, which is the canonical BIP-39 256-bit test vector. The awkward two-branch bit extraction at `vault-crypto.js:156-162` is correct: the `else` branch is reached only for i=23 (byteIdx=31, bitOffset=5, shift 0). The checksum is `hash[0]`, the full first byte, which is the correct ENT/32 = 8 bits for 256-bit entropy. Word lookup lowercases and trims (`:178`); the list is pure ASCII so the missing NFKD normalisation is harmless.

---

## Doc claims checked

| Claim | Source | Verdict | Pointer |
|---|---|---|---|
| "The relay is intentionally blind — no prompts, images, or results are visible to it at any point" | `ARCHITECTURE.md:11` | **Does not hold** | Plaintext 200 px thumbnail: `pc-client/main.py:198-199` → `server/src/jobs.js:64` → `App.svelte:187`. Finding 2. |
| "the relay only ever holds opaque blobs" | `README.md:72` | **Does not hold** | Same. |
| "the relay may see a thumbnail transiently during live WebSocket delivery" | `VAULT.md:39`, `PRIVACY.md:17`, `API.md:52,74` | **Holds** | Accurate and matches the code, including `server/src/index.js:128-131`. |
| HKDF info is `"flux2-klein-v1"` | `ARCHITECTURE.md:98` | **Does not hold (stale)** | Two infos since the direction split: `crypto.js:56-57`, `crypto_utils.py:97-98`. |
| "Per-job forward secrecy: fresh ephemeral keypair every job; past jobs remain protected even if a session key is later compromised" | `ARCHITECTURE.md:101` | **Holds as written, misleading in effect** | True for session-key compromise (`crypto.js:34` per job). Not true for compromise of the PC's static key. Finding 14. |
| "Recovery wrapping \| Raw AES-KW" | `ARCHITECTURE.md:114` | **Partially** | The recovery key is not used raw — it is HKDF-SHA-256 stretched with `info="vault-recovery-v1"` first (`vault-crypto.js:77-86`). |
| "Master key … Generated in browser, never sent in plaintext" | `ARCHITECTURE.md:111` | **Holds** | `vault-crypto.js:18`; only AES-KW blobs go to `/vault/setup` (`VaultSetup.svelte:119-127,169-174`). |
| PBKDF2-SHA-256, 600 000 iterations, salt stored server-side | `ARCHITECTURE.md:113`, `VAULT.md:14` | **Holds** | `vault-crypto.js:44,56`; salt at `VaultSetup.svelte:110/160`, returned by `/vault/info` (`server/src/index.js:649`). |
| Recovery key = 24 BIP-39 words, 256 bits + 8-bit checksum | `ARCHITECTURE.md:115`, `VAULT.md:16` | **Holds** | Verified numerically, see table notes. |
| "At least the recovery method is always configured" | `VAULT.md:19` | **Holds** | Both setup paths always wrap a recovery blob (`VaultSetup.svelte:116,167`); server rejects a setup without one (`server/src/index.js:612-613`). |
| Recovery phrase is "the only way to restore your saved results" if bio and password are lost | `VaultSetup.svelte:327`, implied by `VAULT.md:16-19` | **Does not hold** | Recovery unlock discards the key. Finding 1. |
| Rekey covers "change password or register new passkey" | `VAULT.md:28` | **Partially** | Only the passkey half is implemented. Finding 7. |
| "Thumbnails are not stored server-side in plaintext" | `VAULT.md:39`, `PRIVACY.md:17` | **Holds** | Encrypted with the master key before upload (`Result.svelte:159-168`); server validates only base64 shape (`server/src/index.js:775-780`). |
| Client-side pinning: SHA-256 of the SPKI DER, "throws before encrypting", colons stripped | `ARCHITECTURE.md:49,130` | **Holds** | `crypto.js:193-209`; call order at `Submit.svelte:394-395`. Build-time inlining verified in `client/dist/assets/index-B3aiIR8E.js`. |
| Vault password minimum | not documented; UI enforces 12 | **n/a** | `VaultSetup.svelte:100,144`. Note the *account* password minimum is 8 with 2 character classes (`EmailAuthModal.svelte:33-38`, `AUTHENTICATION.md:48-50`) — the two are unrelated and the docs correctly say so at `server/src/index.js:943`. |

---

## What is done well

- **Pinning is enforced in the right place and fails closed.** `Submit.svelte:394` calls `verifyPcKeyFingerprint` *before* `importPcPublicKey` at `:395` and before any ECDH, so a substituted key never gets used for encryption. When `VITE_PC_KEY_FINGERPRINT` is unset, `crypto.js:195` throws rather than defaulting to "unpinned" — I confirmed this survives into the production bundle. The colon-stripping and `toLowerCase()` normalisation is the right shape for a value users copy out of `keygen.py` output.
- **Direction-split keys with matching WebCrypto usages.** `crypto.js:83-96` derives `jobKey` with `['encrypt']` and `resultKey` with `['decrypt']`, so the browser physically cannot use the wrong key for the wrong direction. The Python side (`crypto_utils.py:118-129`) derives both from the same shared secret with the same info strings. The comments at `crypto.js:59-67` and `crypto_utils.py:105-114` explain *why* the split exists rather than just asserting it.
- **The BIP-39 implementation is genuinely correct**, not merely plausible. The 11-bit extraction, the 33-byte packing, and the checksum all match the spec, and the canonical all-zero vector reproduces exactly. The wordlist is the unmodified official English list. Writing this by hand and getting the i=23 edge case right is the sort of thing that usually goes wrong.
- **Tokens never touch persistent storage or a URL.** `grep` for `localStorage`/`sessionStorage`/`indexedDB`/`document.cookie` across `client/src` returns nothing. The JWT lives in `App.svelte:31` `$state` and travels as an `Authorization: Bearer` header (`api.js`, throughout) or as a first WebSocket message (`ws.js:53-55`) — with the comment at `ws.js:48-49` explaining that this is specifically to keep it out of proxy access logs. That is a deliberate, correct choice.
- **Logout clears everything, including the master key.** `App.svelte:536-557` nulls `token`, `user`, `masterKey`, `vaultInfo`, `pendingJobs`, revokes result object URLs (`clearResultCards`), closes the socket and the `BroadcastChannel`, and then best-effort revokes the token server-side (`api.js:46-53`).
- **Cross-tab isolation is thought through.** `App.svelte:93-97` broadcasts job *lifecycle* over `BroadcastChannel` but deliberately never the AES keys, with the reasoning written down. The `result` handler at `:167-179` then handles the "another tab owns this key" case explicitly instead of throwing.
- **Per-submit `clientToken` disambiguation.** `Submit.svelte:417-431` — the comment documents a real bug that was fixed (concurrent submits binding the wrong AES key to a jobId) and the one-shot listener is cleaned up on `error` and `no_pc` as well as `queued` (`:439-441`), so the listener table does not leak.
- **The password-fallback-after-biometric flow is right.** `VaultSetup.svelte:54-140` registers the passkey, then *requires* a password before calling `/vault/setup`, and holds the intermediate state in `_pendingBio` so nothing is persisted until all three blobs exist. A passkey-only vault dies with the device; the server independently enforces the same rule (`server/src/index.js:620`).
- **No secrets in logs.** The only `console.*` calls in the crypto/auth slice are the five connection-state messages in `ws.js`; no password, key, PRF output, or token is logged anywhere.
- **Error messages avoid oracles where it matters.** `VaultUnlock.svelte:59` collapses every password-path failure to a single "Wrong password or unlock failed" rather than distinguishing network failure from unwrap failure.
- **Reconnect logic is disciplined.** `ws.js:126-137` — exponential backoff capped at 30 s with up to 1 s of jitter, a hard 5-attempt ceiling, and `closed = true` on auth failure (`:88`) and on `session_invalid` (`:99`) so the client does not hammer the relay with a token the server has already rejected.
- **`decode_job_payload` on the PC side does the bounds checking the browser's decoder omits** (`crypto_utils.py:145-160`): minimum length, a sane cap on the declared key length, and a truncation check before slicing. That is the side where it matters, since that is the side parsing attacker-influenced input.
