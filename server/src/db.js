import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const DB_PATH = process.env.DB_PATH || './data/comfylink.db';

// Ensure the directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ── Pragmas ───────────────────────────────────────────────────────────────────
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub      TEXT    UNIQUE NOT NULL,
    email           TEXT    NOT NULL,
    name            TEXT    NOT NULL DEFAULT '',
    picture         TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'suspended')),
    is_admin        INTEGER NOT NULL DEFAULT 0
                            CHECK (is_admin IN (0, 1)),
    uses_remaining  INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT    UNIQUE NOT NULL,
    type            TEXT    NOT NULL DEFAULT 'registration'
                            CHECK (type IN ('registration', 'job_access')),
    created_by      INTEGER NOT NULL REFERENCES users(id),
    uses_remaining  INTEGER,
    expires_at      INTEGER,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_keys (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                     INTEGER UNIQUE NOT NULL REFERENCES users(id),
    encrypted_master_key_bio    BLOB,
    encrypted_master_key_pw     BLOB,
    encrypted_master_key_recovery BLOB,
    prf_salt                    BLOB,
    pbkdf2_salt                 BLOB,
    prf_credential_id           TEXT,
    prf_public_key              BLOB,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stored_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    encrypted_thumb BLOB    NOT NULL,
    encrypted_full  BLOB    NOT NULL,
    iv_thumb        BLOB    NOT NULL,
    iv_full         BLOB    NOT NULL,
    full_size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_stored_results_user_date
    ON stored_results(user_id, created_at DESC);
`);

// ── Runtime migrations ───────────────────────────────────────────────────────
// Uses PRAGMA user_version to track applied migrations.
const _dbVersion = db.pragma('user_version', { simple: true });

if (_dbVersion < 1) {
  // v1: add uses_remaining to users; pre-existing users become unlimited (NULL)
  try { db.exec('ALTER TABLE users ADD COLUMN uses_remaining INTEGER DEFAULT 0'); } catch { /* already exists on fresh DB */ }
  db.exec('UPDATE users SET uses_remaining = NULL WHERE uses_remaining = 0');
  db.pragma('user_version = 1');
}

if (db.pragma('user_version', { simple: true }) < 2) {
  // v2: add tos_accepted_at to users — NULL means not yet accepted
  try { db.exec('ALTER TABLE users ADD COLUMN tos_accepted_at INTEGER DEFAULT NULL'); } catch { /* already exists on fresh DB */ }
  db.pragma('user_version = 2');
}

if (db.pragma('user_version', { simple: true }) < 3) {
  // v3: global code-auth failure log for brute-force protection
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_auth_failures (
      attempted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_auth_failures_at
      ON code_auth_failures(attempted_at);
  `);
  db.pragma('user_version = 3');
}

// ── Prepared statements ───────────────────────────────────────────────────────

// Users
const stmtFindByGoogleSub = db.prepare(
  'SELECT * FROM users WHERE google_sub = ?',
);

const stmtCreateUser = db.prepare(`
  INSERT INTO users (google_sub, email, name, picture, status, is_admin, created_at, updated_at)
  VALUES (@google_sub, @email, @name, @picture, @status, @is_admin, @created_at, @updated_at)
`);

const stmtGetUserById = db.prepare('SELECT * FROM users WHERE id = ?');

const stmtUpdateUserStatus = db.prepare(
  'UPDATE users SET status = @status, updated_at = @updated_at WHERE id = @id',
);

const stmtSetAdmin = db.prepare(
  'UPDATE users SET is_admin = @is_admin, updated_at = @updated_at WHERE id = @id',
);

const stmtUpdateUserUses = db.prepare(
  'UPDATE users SET uses_remaining = @uses_remaining, updated_at = @updated_at WHERE id = @id',
);

// Atomic decrement: only succeeds if uses_remaining > 0. Returns result.changes = 1 on success.
const stmtAtomicDecrementUserUses = db.prepare(
  'UPDATE users SET uses_remaining = uses_remaining - 1, updated_at = @updated_at WHERE id = @id AND uses_remaining > 0',
);

const stmtFindByEmail = db.prepare('SELECT * FROM users WHERE email = ?');

const stmtUpdateTosAccepted = db.prepare(
  'UPDATE users SET tos_accepted_at = @tos_accepted_at, updated_at = @updated_at WHERE id = @id',
);

// Invite codes
const stmtCreateCode = db.prepare(`
  INSERT INTO invite_codes (code, type, created_by, uses_remaining, expires_at, created_at)
  VALUES (@code, @type, @created_by, @uses_remaining, @expires_at, @created_at)
`);

const stmtFindCode = db.prepare('SELECT * FROM invite_codes WHERE code = ?');
const stmtFindCodeById = db.prepare('SELECT * FROM invite_codes WHERE id = ?');

// Atomic decrement: only succeeds if uses_remaining > 0. Returns result.changes = 1 on success.
const stmtAtomicDecrementCodeUses = db.prepare(
  'UPDATE invite_codes SET uses_remaining = uses_remaining - 1 WHERE id = ? AND uses_remaining > 0',
);

const stmtGetCodesByCreator = db.prepare(
  'SELECT * FROM invite_codes WHERE created_by = ? ORDER BY created_at DESC',
);

const stmtDeleteCode = db.prepare(
  'DELETE FROM invite_codes WHERE id = ? AND created_by = ?',
);

const stmtUpdateCode = db.prepare(
  'UPDATE invite_codes SET uses_remaining = @uses_remaining, expires_at = @expires_at WHERE id = @id AND created_by = @created_by',
);

// Vault keys
const stmtGetVaultByUser = db.prepare(
  'SELECT * FROM vault_keys WHERE user_id = ?',
);

const stmtCreateVault = db.prepare(`
  INSERT INTO vault_keys (user_id, encrypted_master_key_bio, encrypted_master_key_pw, encrypted_master_key_recovery,
    prf_salt, pbkdf2_salt, prf_credential_id, prf_public_key, created_at, updated_at)
  VALUES (@user_id, @encrypted_master_key_bio, @encrypted_master_key_pw, @encrypted_master_key_recovery,
    @prf_salt, @pbkdf2_salt, @prf_credential_id, @prf_public_key, @created_at, @updated_at)
`);

const stmtUpdateVault = db.prepare(`
  UPDATE vault_keys SET
    encrypted_master_key_bio = @encrypted_master_key_bio,
    encrypted_master_key_pw = @encrypted_master_key_pw,
    encrypted_master_key_recovery = @encrypted_master_key_recovery,
    prf_salt = @prf_salt,
    pbkdf2_salt = @pbkdf2_salt,
    prf_credential_id = @prf_credential_id,
    prf_public_key = @prf_public_key,
    updated_at = @updated_at
  WHERE user_id = @user_id
`);

// Stored results
const stmtCreateResult = db.prepare(`
  INSERT INTO stored_results (user_id, encrypted_thumb, encrypted_full, iv_thumb, iv_full, full_size_bytes, created_at)
  VALUES (@user_id, @encrypted_thumb, @encrypted_full, @iv_thumb, @iv_full, @full_size_bytes, @created_at)
`);

const stmtListResults = db.prepare(
  'SELECT id, encrypted_thumb, iv_thumb, full_size_bytes, created_at FROM stored_results WHERE user_id = ? AND id < ? ORDER BY created_at DESC LIMIT ?',
);

const stmtListResultsFirst = db.prepare(
  'SELECT id, encrypted_thumb, iv_thumb, full_size_bytes, created_at FROM stored_results WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
);

const stmtGetResultFull = db.prepare(
  'SELECT encrypted_full, iv_full FROM stored_results WHERE id = ? AND user_id = ?',
);

const stmtDeleteResult = db.prepare(
  'DELETE FROM stored_results WHERE id = ? AND user_id = ?',
);

const stmtDeleteAllResultsByUser = db.prepare(
  'DELETE FROM stored_results WHERE user_id = ?',
);

const stmtCountResultsByUser = db.prepare(
  'SELECT COUNT(*) AS cnt FROM stored_results WHERE user_id = ?',
);

const stmtDeleteVault = db.prepare(
  'DELETE FROM vault_keys WHERE user_id = ?',
);

const stmtGetAllUsers = db.prepare(
  'SELECT id, email, name, picture, status, is_admin, uses_remaining, tos_accepted_at, created_at, updated_at FROM users ORDER BY created_at DESC',
);

const stmtGetUsersByStatus = db.prepare(
  'SELECT id, email, name, picture, status, is_admin, uses_remaining, tos_accepted_at, created_at, updated_at FROM users WHERE status = ? ORDER BY created_at DESC',
);

// Global code auth failure tracking (brute-force protection)
const stmtInsertAuthFailure = db.prepare(
  'INSERT INTO code_auth_failures (attempted_at) VALUES (?)',
);
const stmtCountRecentAuthFailures = db.prepare(
  'SELECT COUNT(*) AS cnt FROM code_auth_failures WHERE attempted_at >= ?',
);
const stmtPruneOldAuthFailures = db.prepare(
  'DELETE FROM code_auth_failures WHERE attempted_at < ?',
);

// ── Public API ────────────────────────────────────────────────────────────────

export function findUserByGoogleSub(googleSub) {
  return stmtFindByGoogleSub.get(googleSub) ?? null;
}

export function findUserByEmail(email) {
  return stmtFindByEmail.get(email) ?? null;
}

export function getUserById(id) {
  return stmtGetUserById.get(id) ?? null;
}

export function createUser({ googleSub, email, name, picture, status = 'pending', isAdmin = false }) {
  const now = Date.now();
  const result = stmtCreateUser.run({
    google_sub: googleSub,
    email,
    name,
    picture,
    status,
    is_admin: isAdmin ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  return stmtGetUserById.get(result.lastInsertRowid);
}

export function updateUserStatus(id, status) {
  return stmtUpdateUserStatus.run({ id, status, updated_at: Date.now() });
}

export function setUserAdmin(id, isAdmin) {
  return stmtSetAdmin.run({ id, is_admin: isAdmin ? 1 : 0, updated_at: Date.now() });
}

export function updateUserUses(id, usesRemaining) {
  return stmtUpdateUserUses.run({ id, uses_remaining: usesRemaining ?? null, updated_at: Date.now() });
}

/**
 * Atomically decrement uses_remaining by 1, only if currently > 0.
 * Returns { changes: 1 } on success, { changes: 0 } if already at 0 or NULL.
 */
export function atomicDecrementUserUses(id) {
  return stmtAtomicDecrementUserUses.run({ id, updated_at: Date.now() });
}

export function updateTosAccepted(id) {
  return stmtUpdateTosAccepted.run({ id, tos_accepted_at: Date.now(), updated_at: Date.now() });
}

// Invite codes

export function createInviteCode({ code, type = 'registration', createdBy, usesRemaining = null, expiresAt = null }) {
  return stmtCreateCode.run({
    code,
    type,
    created_by: createdBy,
    uses_remaining: usesRemaining,
    expires_at: expiresAt,
    created_at: Date.now(),
  });
}

export function findInviteCode(code) {
  return stmtFindCode.get(code) ?? null;
}

export function findInviteCodeById(id) {
  return stmtFindCodeById.get(id) ?? null;
}

/**
 * Atomically decrement uses_remaining by 1 for an invite code, only if currently > 0.
 * Returns { changes: 1 } on success, { changes: 0 } if already at 0.
 */
export function atomicDecrementCodeUses(id) {
  return stmtAtomicDecrementCodeUses.run(id);
}

export function getCodesByCreator(userId) {
  return stmtGetCodesByCreator.all(userId);
}

export function deleteInviteCode(id, createdBy) {
  return stmtDeleteCode.run(id, createdBy);
}

export function updateInviteCode(id, createdBy, { usesRemaining, expiresAt }) {
  return stmtUpdateCode.run({ id, created_by: createdBy, uses_remaining: usesRemaining ?? null, expires_at: expiresAt ?? null });
}

/**
 * Validate an invite code: exists, not expired, has remaining uses, correct type.
 * Returns the code row if valid, null otherwise.
 */
export function validateInviteCode(code, type = 'registration') {
  const row = findInviteCode(code);
  if (!row) return null;
  if (row.type !== type) return null;
  if (row.expires_at !== null && Date.now() > row.expires_at) return null;
  if (row.uses_remaining !== null && row.uses_remaining <= 0) return null;
  return row;
}

// Vault keys

export function getVaultByUser(userId) {
  return stmtGetVaultByUser.get(userId) ?? null;
}

export function createVault(userId, data) {
  const now = Date.now();
  return stmtCreateVault.run({
    user_id: userId,
    encrypted_master_key_bio: data.encryptedMasterKeyBio ?? null,
    encrypted_master_key_pw: data.encryptedMasterKeyPw ?? null,
    encrypted_master_key_recovery: data.encryptedMasterKeyRecovery ?? null,
    prf_salt: data.prfSalt ?? null,
    pbkdf2_salt: data.pbkdf2Salt ?? null,
    prf_credential_id: data.prfCredentialId ?? null,
    prf_public_key: data.prfPublicKey ?? null,
    created_at: now,
    updated_at: now,
  });
}

export function updateVault(userId, data) {
  return stmtUpdateVault.run({
    user_id: userId,
    encrypted_master_key_bio: data.encryptedMasterKeyBio ?? null,
    encrypted_master_key_pw: data.encryptedMasterKeyPw ?? null,
    encrypted_master_key_recovery: data.encryptedMasterKeyRecovery ?? null,
    prf_salt: data.prfSalt ?? null,
    pbkdf2_salt: data.pbkdf2Salt ?? null,
    prf_credential_id: data.prfCredentialId ?? null,
    prf_public_key: data.prfPublicKey ?? null,
    updated_at: Date.now(),
  });
}

export const deleteVault = db.transaction((userId) => {
  stmtDeleteAllResultsByUser.run(userId);
  stmtDeleteVault.run(userId);
});

// Stored results

export function createStoredResult(userId, data) {
  const now = Date.now();
  const result = stmtCreateResult.run({
    user_id: userId,
    encrypted_thumb: data.encryptedThumb,
    encrypted_full: data.encryptedFull,
    iv_thumb: data.ivThumb,
    iv_full: data.ivFull,
    full_size_bytes: data.fullSizeBytes ?? 0,
    created_at: now,
  });
  return { id: Number(result.lastInsertRowid), createdAt: now };
}

export function listStoredResults(userId, { limit = 20, before = null } = {}) {
  if (before) {
    return stmtListResults.all(userId, before, limit);
  }
  return stmtListResultsFirst.all(userId, limit);
}

export function getStoredResultFull(id, userId) {
  return stmtGetResultFull.get(id, userId) ?? null;
}

export function deleteStoredResult(id, userId) {
  return stmtDeleteResult.run(id, userId);
}

export function countStoredResults(userId) {
  return stmtCountResultsByUser.get(userId)?.cnt ?? 0;
}

// Admin: user management

export function getAllUsers(status = null) {
  if (status) {
    return stmtGetUsersByStatus.all(status);
  }
  return stmtGetAllUsers.all();
}

// Global code-auth brute-force tracking

/**
 * Record a failed invite-code auth attempt.
 * Call this whenever a code_auth or /auth/code request fails validation.
 */
export function recordCodeAuthFailure() {
  stmtInsertAuthFailure.run(Date.now());
}

/**
 * Count global failed code-auth attempts within the given window (ms).
 */
export function getRecentCodeAuthFailureCount(windowMs) {
  return stmtCountRecentAuthFailures.get(Date.now() - windowMs)?.cnt ?? 0;
}

/**
 * Prune failure records older than maxAgeMs to keep the table small.
 */
export function pruneCodeAuthFailures(maxAgeMs) {
  return stmtPruneOldAuthFailures.run(Date.now() - maxAgeMs);
}

export default db;
