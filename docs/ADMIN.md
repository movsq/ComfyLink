# Admin Panel

[← Back to README](../README.md)

Accessible from the UI when logged in with an admin account. Contains two tabs.

---

## CODES tab

Create, view, edit, and revoke invite codes.

- Generate `registration` or `job_access` codes (see [AUTHENTICATION.md](AUTHENTICATION.md) for type definitions)
- Set use limits (e.g. single-use) and expiration times
- Patch remaining uses or expiry on existing codes
- Changes push immediately to connected admin and code-user sockets

> **`ACCESS_CODES_ENABLED=false`** — When access-code login is disabled via the server environment variable, a warning banner appears at the top of this tab. Code generation and management remain fully functional so you can prepare codes in advance. Users currently logged in with a code are kicked within 60 seconds. The login button is hidden from the frontend and `POST /auth/code` returns `403`.

---

## USERS tab

View all user accounts, change their status, and manage job quotas.

- Filter by status (`pending`, `active`, `suspended`)
- Activate pending users or suspend active ones
- Set a user's **uses remaining**: choose *Unlimited* or enter any number 0–999,999
- Uses count shown per row (highlighted amber when zero)
- Changes to uses are pushed to the user's live socket in real-time
- Cannot modify your own account or other admins

---

## Promote the first admin (CLI)

After signing in with Google for the first time, promote your account from the server:

```bash
cd server
node src/seed-admin.js your@email.com
```

This sets your account to `active` and grants admin privileges. From the Admin panel you can then generate invite codes for other users.
