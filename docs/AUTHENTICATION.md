# Authentication & Access

[← Back to README](../README.md)

Users can authenticate in three ways:

- **Google OAuth** — ID token flow; no server-side redirect needed
- **Email + password** — register with an email address and a password (argon2id-hashed server-side)
- **Access code** — guest mode using a `job_access` invite code; no persistent account

---

## Account lifecycle

Google and email/password users share the same account states:

| State | Meaning |
|-------|---------|
| `pending` | Account created but not yet approved — cannot submit jobs |
| `active` | Approved; full access to job submission and vault |
| `suspended` | Access revoked by an admin |

New accounts start as `pending` **unless** the user supplies a `registration` invite code at sign-in, which immediately sets them to `active`.

---

## Email + password authentication

### Registration (`POST /auth/register`)

- Requires `email` and `password` in the request body.
- Password must be at least 8 characters.
- The password is hashed with **argon2id** (memory: 65 536 KiB, iterations: 3, parallelism: 1) before storage. The plaintext password is never stored or logged.
- If `INVITE_REQUIRED=true`, a valid `inviteCode` must also be provided — otherwise the request is rejected with `400`.
- On success, returns a JWT with `type: "email"` and the new user object.

### Login (`POST /auth/login/email`)

- Requires `email` and `password`.
- Brute-force protection: up to **15 failed attempts per IP** within any 15-minute window; thereafter returns `429` until the window clears.
- Invalid credentials always return `401 invalid_credentials` regardless of whether the email exists, to prevent account enumeration.
- Google-only accounts (no password set) return the same `401` response.

### Password policy

| Requirement | Value |
|-------------|-------|
| Minimum length | 8 characters |
| Maximum length | 1 024 characters (enforced server-side) |
| Complexity | Must include at least 2 of: letters, numbers, symbols |

### Rate limiting

Both `/auth/register` and `/auth/login/email` share a **10 requests per 1-minute window** per IP rate limiter (in addition to the per-endpoint brute-force counters above).

---

## Per-user AI use quota

Each Google account has a **uses remaining** quota:

| Value | Meaning |
|-------|---------|
| `0` | No access — job submission blocked until an admin grants uses |
| *N* (positive integer) | User may submit *N* more jobs; decremented by 1 on each successful submission |
| `null` / Unlimited | No limit — user may submit freely |

New accounts always start with **0 uses**. An admin must grant uses before the first job can be submitted. Existing accounts (created before this feature) are migrated to **Unlimited** automatically.

---

## Invite codes

Admins generate two types of invite code from the Admin panel or via the REST API:

| Type | Effect |
|------|--------|
| `registration` | Activates a new Google account immediately on sign-in |
| `job_access` | Grants a non-Google session scoped to job submission only (no vault, no admin) |

Codes have the format `KLEIN-XXXX-XXXX` (8 characters drawn from a 32-symbol unambiguous alphabet — no `I`, `O`, `0`, `1`), giving **40 bits of entropy per code**.  They can be configured with a use limit and expiry time.

### Brute-force protection

`POST /auth/code` now uses two layers:

- **Per-IP hard block:** 20 failed attempts from the same IP in 60 seconds → `429`
- **Global flood circuit breaker:** 500 failed attempts across all IPs in 60 seconds → `429`

This preserves normal per-IP protection while still slowing coordinated distributed guessing.

---

## Access code login (guest mode)

Users can enter a `job_access` code instead of signing in with Google. The server issues a short-lived JWT with `type: "code_user"` that allows job submission. The phone WebSocket receives `code_status` messages whenever remaining uses change.

### Session isolation

Each WebSocket connection that authenticates via an access code receives a unique **per-session identifier** (generated server-side with `uuidv4()`).  Jobs are linked to this identifier, not to the shared code ID.  This means:

- Two users sharing the same `job_access` code **cannot cancel each other's jobs**.
- Queue ownership display is scoped to the individual socket, not the code.
- Quota accounting (uses-remaining decrement) still keys on the code ID.

The code's validity (expiry, remaining uses) is re-checked on every WebSocket authentication attempt and at HTTP endpoints protected by `requireActiveOrCode`.  Revoked or exhausted codes are rejected immediately without waiting for a token refresh.

---

## Terms of Service

All users are subject to the Terms of Service regardless of how they authenticate.

**Google-authenticated and email/password users** must explicitly accept via the ToS modal — presented on first login and re-shown if the user attempts to generate without having accepted. Acceptance is recorded server-side in `users.tos_accepted_at` and `users.tos_version`.

`TOS_VERSION` is derived from a hash of `server/src/tos-content.js`, so it is treated as an opaque value. Current acceptance means `users.tos_version === TOS_VERSION`, not `>=`.

**Access code users** are bound by the same terms upon first use of the Service. The client still shows the modal, but acceptance is not persisted server-side because code-user sessions do not have a `users` row. Admins issuing `job_access` codes are expected to make recipients aware of the terms before distribution.

The terms reference Czech Republic applicable law:

- **Contract formation:** § 1724 et seq. of Act No. 89/2012 Coll. (Czech Civil Code)
- **Data protection:** Regulation (EU) 2016/679 (GDPR) as supplemented by Act No. 110/2019 Coll.
- **Prohibited content:** Act No. 40/2009 Coll. (Czech Criminal Code), Regulation (EU) 2024/1689 (AI Act)
- **Governing law:** Czech Republic; disputes resolved by Czech courts
