import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, '../../data/comfylink.db');

// Ensure the directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ── Pragmas ───────────────────────────────────────────────────────────────────
db.pragma('journal_mode = WAL');
// FULL fsyncs the WAL on every commit. The write volume here is tiny and the DB
// holds ciphertext nobody — not even the server — can recreate, so durability is
// worth far more than the throughput it costs.
db.pragma('synchronous = FULL');
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
    encrypted_thumb BLOB,
    iv_thumb        BLOB,
    encrypted_full  BLOB    NOT NULL,
    iv_full         BLOB    NOT NULL,
    full_size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_stored_results_user_date
    ON stored_results(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS code_auth_failures (
    attempted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_code_auth_failures_at
    ON code_auth_failures(attempted_at);
`);

// ── Runtime migrations ───────────────────────────────────────────────────────
// Uses PRAGMA user_version to track applied migrations.
const LATEST_DB_VERSION = 12;
const _dbVersion = db.pragma('user_version', { simple: true });

// Forward-version guard: a database written by a newer build runs no migration
// here and would otherwise fail much later with a confusing "no such column"
// from db.prepare(). Fail immediately with a message that names the cause.
if (_dbVersion > LATEST_DB_VERSION) {
  throw new Error(
    `[db] Database schema is v${_dbVersion} but this build only knows up to v${LATEST_DB_VERSION}. `
    + 'Refusing to start — downgrading would corrupt data. Deploy a newer build or restore an older DB.',
  );
}

const stmtTableExists = db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
);
const tableExists = (name) => !!stmtTableExists.get(name);
const tableRowCount = (name) => db.prepare(`SELECT COUNT(*) AS cnt FROM "${name}"`).get().cnt;

/**
 * Repair a database left half-applied by a crash during a table rebuild.
 *
 * The dangerous state is: the real table was dropped (or recreated empty by the
 * top-level CREATE TABLE IF NOT EXISTS above) while the only copy of the rows
 * still lives in the staging table and user_version is still at N-1. Older
 * builds opened their rebuild with `DROP TABLE IF EXISTS <staging>`, which
 * destroyed exactly that copy. Rename it back instead.
 *
 * If the real table exists and holds rows, it is authoritative and any leftover
 * staging table is stale — rebuildTable() drops it inside its own transaction.
 */
function recoverStagingTable(table, staging) {
  if (!tableExists(staging)) return;
  if (!tableExists(table)) {
    console.warn(`[db] recovering "${staging}" → "${table}" after an interrupted migration`);
    db.exec(`ALTER TABLE "${staging}" RENAME TO "${table}"`);
    return;
  }
  if (tableRowCount(table) === 0 && tableRowCount(staging) > 0) {
    console.warn(`[db] "${table}" is empty but "${staging}" holds rows — recovering the staging copy`);
    db.exec(`DROP TABLE "${table}"; ALTER TABLE "${staging}" RENAME TO "${table}"`);
  }
}

/**
 * Run a table-rebuild migration atomically.
 *
 * SQLite cannot ALTER a column type or a CHECK constraint, so these migrations
 * create a staging table, copy the rows across, drop the original and rename.
 * Every step must land together: a crash between `DROP TABLE <table>` and the
 * RENAME leaves the rows only in <staging>, and the next boot would recreate
 * <table> empty. Wrapping the whole sequence — CREATE → INSERT → DROP → RENAME →
 * user_version — in one transaction closes that window, and recoverStagingTable()
 * repairs databases already damaged by the pre-transactional version.
 */
function rebuildTable(table, staging, version, sql) {
  db.transaction(() => {
    recoverStagingTable(table, staging);
    // Safe now: recovery above has already salvaged a staging table that held
    // the only copy, so anything still here is a stale leftover.
    db.exec(`DROP TABLE IF EXISTS "${staging}"`);
    db.exec(sql);
    db.pragma(`user_version = ${version}`);
  })();
}

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

if (db.pragma('user_version', { simple: true }) < 4) {
  // v4: track which TOS version the user accepted; NULL or 0 means must re-accept current version
  try { db.exec('ALTER TABLE users ADD COLUMN tos_version INTEGER DEFAULT NULL'); } catch { /* already exists on fresh DB */ }
  db.pragma('user_version = 4');
}

if (db.pragma('user_version', { simple: true }) < 5) {
  // v5: JWT revocation list — short-lived blocklist for logged-out tokens
  db.exec(`
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti        TEXT    PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires
      ON revoked_tokens(expires_at);
  `);
  db.pragma('user_version = 5');
}

if (db.pragma('user_version', { simple: true }) < 6) {
  // v6: Job audit log for legal compliance (ČTÚ AI Act, GDPR)
  // Logs IP address + identity for every job submitted. NO image blobs stored.
  // Entries are automatically pruned after 6 months (see pruneJobAuditLogsOlderThan).
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      TEXT    NOT NULL,
      user_type   TEXT    NOT NULL CHECK (user_type IN ('google', 'code')),
      user_id     INTEGER,
      google_sub  TEXT,
      email       TEXT,
      code_id     INTEGER,
      ip_address  TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_audit_log_created_at
      ON job_audit_log(created_at);
  `);
  db.pragma('user_version = 6');
}

if (db.pragma('user_version', { simple: true }) < 7) {
  // v7: Replace vault-encrypted thumbnails with server-side trusted thumbnails.
  // The browser no longer encrypts and uploads thumbnail blobs; instead the PC
  // client generates a 200px WebP thumbnail and sends it alongside the encrypted
  // result. This removes encrypted_thumb / iv_thumb and adds the thumb column.
  // Crash window closed by rebuildTable: between DROP TABLE stored_results and
  // the RENAME, every user's saved result existed only in stored_results_v7.
  // The previous non-transactional form also used a bare CREATE TABLE, so a
  // retry after such a crash threw "table stored_results_v7 already exists" at
  // import time and the server never started.
  rebuildTable('stored_results', 'stored_results_v7', 7, `
    CREATE TABLE stored_results_v7 (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      thumb           BLOB,
      encrypted_full  BLOB    NOT NULL,
      iv_full         BLOB    NOT NULL,
      full_size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );
    INSERT INTO stored_results_v7 (id, user_id, encrypted_full, iv_full, full_size_bytes, created_at)
      SELECT id, user_id, encrypted_full, iv_full, full_size_bytes, created_at
      FROM stored_results;
    DROP TABLE stored_results;
    ALTER TABLE stored_results_v7 RENAME TO stored_results;
    CREATE INDEX IF NOT EXISTS idx_stored_results_user_date
      ON stored_results(user_id, created_at DESC);
  `);
}

if (db.pragma('user_version', { simple: true }) < 8) {
  // v8: Add email+password authentication support.
  // - users.google_sub becomes nullable (email-registered users have no Google sub)
  // - New email_auth table stores argon2id password hashes
  // - New email_login_failures table for per-IP brute-force protection
  // Wrapped in a transaction for atomic execution — a crash between DROP TABLE
  // and RENAME would otherwise leave the DB without a users table. The
  // IF EXISTS guard allows the transaction to be safely retried if it committed
  // but user_version was not yet updated.
  // foreign_keys is temporarily disabled so DROP TABLE users does not fail on FK
  // constraint checks from child tables (invite_codes, vault_keys, stored_results…).
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      DROP TABLE IF EXISTS users_v8;
      CREATE TABLE users_v8 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        google_sub      TEXT    UNIQUE,
        email           TEXT    NOT NULL,
        name            TEXT    NOT NULL DEFAULT '',
        picture         TEXT    NOT NULL DEFAULT '',
        status          TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'active', 'suspended')),
        is_admin        INTEGER NOT NULL DEFAULT 0
                                CHECK (is_admin IN (0, 1)),
        uses_remaining  INTEGER DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        tos_accepted_at INTEGER DEFAULT NULL,
        tos_version     INTEGER DEFAULT NULL
      );
      INSERT INTO users_v8
        SELECT id, google_sub, email, name, picture, status, is_admin,
               uses_remaining, created_at, updated_at, tos_accepted_at, tos_version
        FROM users;
      DROP TABLE users;
      ALTER TABLE users_v8 RENAME TO users;

      CREATE TABLE IF NOT EXISTS email_auth (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id             INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        password_hash       TEXT    NOT NULL,
        email_verified      INTEGER NOT NULL DEFAULT 0,
        verification_token  TEXT    DEFAULT NULL,
        token_expires_at    INTEGER DEFAULT NULL,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_login_failures (
        ip_address   TEXT    NOT NULL,
        attempted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_email_login_failures_ip_at
        ON email_login_failures(ip_address, attempted_at);
      COMMIT;
    `);
    // Partial unique index: one non-Google (email-auth) account per email address.
    // The WHERE google_sub IS NULL clause means Google accounts are not covered by
    // this constraint, but application-level checks still block cross-method
    // email duplicates at runtime.
    try {
      db.exec(`
        CREATE UNIQUE INDEX idx_users_email_unique_email_auth
          ON users(email) WHERE google_sub IS NULL
      `);
    } catch (err) {
      // Only "index already exists" is benign. The realistic failure here is
      // "UNIQUE constraint failed: users.email" — pre-existing duplicate
      // email-auth rows — and silently continuing would leave the table
      // unindexed and findEmailUserByEmail non-deterministic. Fail loudly.
      if (!/already exists/i.test(err.message)) throw err;
    }
    db.pragma('user_version = 8');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

if (db.pragma('user_version', { simple: true }) < 9) {
  // v9: Expand job_audit_log user_type to include 'email'.
  // SQLite cannot ALTER a CHECK constraint, so we recreate the table.
  // Crash window closed by rebuildTable: between DROP TABLE job_audit_log and
  // the RENAME the compliance rows existed only in job_audit_log_v9, and the
  // previous leading `DROP TABLE IF EXISTS job_audit_log_v9` was precisely what
  // discarded them on the retry it claimed to make safe.
  rebuildTable('job_audit_log', 'job_audit_log_v9', 9, `
    CREATE TABLE job_audit_log_v9 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      TEXT    NOT NULL,
      user_type   TEXT    NOT NULL,
      user_id     INTEGER,
      google_sub  TEXT,
      email       TEXT,
      code_id     INTEGER,
      ip_address  TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );
    INSERT INTO job_audit_log_v9
      SELECT id, job_id, user_type, user_id, google_sub, email, code_id, ip_address, created_at
      FROM job_audit_log;
    DROP TABLE job_audit_log;
    ALTER TABLE job_audit_log_v9 RENAME TO job_audit_log;
    CREATE INDEX IF NOT EXISTS idx_job_audit_log_created_at
      ON job_audit_log(created_at);
  `);
}

if (db.pragma('user_version', { simple: true }) < 10) {
  // v10: Add job_id to stored_results for save-deduplication.
  // A per-user unique index on (user_id, job_id) prevents double-saves of the same job.
  // The WHERE clause makes the index partial so rows with NULL job_id are not constrained.
  // Crash window: the column add, the index and the user_version bump ran as
  // three independent statements, so a crash after the ALTER left the column in
  // place with user_version still 9 — and the retry threw "duplicate column
  // name: job_id" at import time, bricking startup. Now transactional, with the
  // same try/catch the other ADD COLUMN migrations (v1/v2/v4/v11) already have.
  db.transaction(() => {
    try { db.exec('ALTER TABLE stored_results ADD COLUMN job_id TEXT DEFAULT NULL'); } catch { /* already exists */ }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stored_results_user_job_id
        ON stored_results(user_id, job_id) WHERE job_id IS NOT NULL;
    `);
    db.pragma('user_version = 10');
  })();
}

if (db.pragma('user_version', { simple: true }) < 11) {
  // v11: Add ip_address column to code_auth_failures to enable per-IP rate limiting,
  // replacing the previous global-only lockout that could be weaponised for DoS.
  try { db.exec("ALTER TABLE code_auth_failures ADD COLUMN ip_address TEXT NOT NULL DEFAULT ''"); } catch { /* already exists on fresh DB */ }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_code_auth_failures_ip_at
      ON code_auth_failures(ip_address, attempted_at);
  `);
  db.pragma('user_version = 11');
}

if (db.pragma('user_version', { simple: true }) < 12) {
  // v12: Replace plaintext server-side thumbnails with client-encrypted thumbnails.
  // The old `thumb` column stored raw WebP bytes that were readable by anyone with
  // DB access. The new `encrypted_thumb` + `iv_thumb` columns store AES-256-GCM
  // ciphertext encrypted by the browser with the user's vault master key, giving
  // thumbnails the same E2E encryption guarantee as the full images.
  // Existing plaintext thumb data is discarded — it cannot be retroactively
  // encrypted because the vault key never leaves the browser.
  // Crash window closed by rebuildTable: between DROP TABLE stored_results and
  // the RENAME every user's encrypted gallery existed only in
  // stored_results_v12 with user_version still 11. On the next boot the
  // top-level CREATE TABLE IF NOT EXISTS recreated stored_results empty and the
  // old leading `DROP TABLE IF EXISTS stored_results_v12` destroyed the only
  // surviving copy — silently, and with no possible recovery, since the relay
  // holds ciphertext under keys it has never seen.
  rebuildTable('stored_results', 'stored_results_v12', 12, `
    CREATE TABLE stored_results_v12 (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      encrypted_thumb BLOB,
      iv_thumb        BLOB,
      encrypted_full  BLOB    NOT NULL,
      iv_full         BLOB    NOT NULL,
      full_size_bytes INTEGER NOT NULL DEFAULT 0,
      job_id          TEXT    DEFAULT NULL,
      created_at      INTEGER NOT NULL
    );
    INSERT INTO stored_results_v12 (id, user_id, encrypted_full, iv_full, full_size_bytes, job_id, created_at)
      SELECT id, user_id, encrypted_full, iv_full, full_size_bytes, job_id, created_at
      FROM stored_results;
    DROP TABLE stored_results;
    ALTER TABLE stored_results_v12 RENAME TO stored_results;
    CREATE INDEX IF NOT EXISTS idx_stored_results_user_date
      ON stored_results(user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stored_results_user_job_id
      ON stored_results(user_id, job_id) WHERE job_id IS NOT NULL;
  `);
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

// Atomic refund: the mirror of the decrement above. The IS NOT NULL guard keeps
// unlimited users (NULL) unlimited instead of turning them into "1 use left".
const stmtRefundUserUses = db.prepare(
  'UPDATE users SET uses_remaining = uses_remaining + 1, updated_at = @updated_at WHERE id = @id AND uses_remaining IS NOT NULL',
);

const stmtFindByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const stmtFindByEmailNoGoogleSub = db.prepare('SELECT * FROM users WHERE email = ? AND google_sub IS NULL');

const stmtUpdateTosAccepted = db.prepare(
  'UPDATE users SET tos_accepted_at = @tos_accepted_at, tos_version = @tos_version, updated_at = @updated_at WHERE id = @id',
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

// Atomic refund for invite codes — see stmtRefundUserUses.
const stmtRefundCodeUses = db.prepare(
  'UPDATE invite_codes SET uses_remaining = uses_remaining + 1 WHERE id = ? AND uses_remaining IS NOT NULL',
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
  INSERT INTO stored_results (user_id, encrypted_thumb, iv_thumb, encrypted_full, iv_full, full_size_bytes, job_id, created_at)
  VALUES (@user_id, @encrypted_thumb, @iv_thumb, @encrypted_full, @iv_full, @full_size_bytes, @job_id, @created_at)
`);

const stmtFindResultByJobId = db.prepare(
  'SELECT id FROM stored_results WHERE user_id = ? AND job_id = ? LIMIT 1',
);

// Ordered by id, not created_at, so the ORDER BY and the `id < ?` cursor use the
// same key. They agree today (id is autoincrement, created_at is Date.now() at
// insert) but a backfill or a clock adjustment would break that correlation and
// make the gallery skip or repeat rows.
const stmtListResults = db.prepare(
  'SELECT id, (encrypted_thumb IS NOT NULL) AS has_thumb, full_size_bytes, created_at FROM stored_results WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
);

const stmtListResultsFirst = db.prepare(
  'SELECT id, (encrypted_thumb IS NOT NULL) AS has_thumb, full_size_bytes, created_at FROM stored_results WHERE user_id = ? ORDER BY id DESC LIMIT ?',
);

const stmtGetResultFull = db.prepare(
  'SELECT encrypted_full, iv_full FROM stored_results WHERE id = ? AND user_id = ?',
);

const stmtGetResultThumb = db.prepare(
  'SELECT encrypted_thumb, iv_thumb FROM stored_results WHERE id = ? AND user_id = ?',
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

// Account deletion. `users` is referenced with no ON DELETE clause by
// invite_codes, vault_keys and stored_results, so every child row has to go
// first or SQLite raises FOREIGN KEY constraint failed (PRAGMA foreign_keys is
// ON). email_auth cascades, but is deleted explicitly so the order reads the
// same way for every table. job_audit_log has no FK at all — its rows would
// otherwise survive the user by construction.
const stmtDeleteEmailAuthByUser = db.prepare(
  'DELETE FROM email_auth WHERE user_id = ?',
);
const stmtDeleteCodesByCreator = db.prepare(
  'DELETE FROM invite_codes WHERE created_by = ?',
);
const stmtDeleteAuditLogsByUser = db.prepare(
  "DELETE FROM job_audit_log WHERE user_id = ? AND user_type IN ('google', 'email')",
);
const stmtDeleteUser = db.prepare('DELETE FROM users WHERE id = ?');

const stmtGetAllUsers = db.prepare(
  'SELECT id, email, name, picture, status, is_admin, uses_remaining, tos_accepted_at, tos_version, created_at, updated_at FROM users ORDER BY created_at DESC',
);

const stmtGetUsersByStatus = db.prepare(
  'SELECT id, email, name, picture, status, is_admin, uses_remaining, tos_accepted_at, tos_version, created_at, updated_at FROM users WHERE status = ? ORDER BY created_at DESC',
);

// Revoked tokens (JWT blocklist)
const stmtInsertRevokedToken = db.prepare(
  'INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)',
);
const stmtIsTokenRevoked = db.prepare(
  'SELECT 1 FROM revoked_tokens WHERE jti = ?',
);
const stmtPruneRevokedTokens = db.prepare(
  'DELETE FROM revoked_tokens WHERE expires_at < ?',
);

// Job audit log
const stmtCreateJobAuditLog = db.prepare(`
  INSERT INTO job_audit_log (job_id, user_type, user_id, google_sub, email, code_id, ip_address, created_at)
  VALUES (@job_id, @user_type, @user_id, @google_sub, @email, @code_id, @ip_address, @created_at)
`);
const stmtPruneJobAuditLogs = db.prepare(
  'DELETE FROM job_audit_log WHERE created_at < ?',
);

// Global code auth failure tracking (brute-force protection)
const stmtInsertAuthFailure = db.prepare(
  "INSERT INTO code_auth_failures (ip_address, attempted_at) VALUES (?, ?)",
);
const stmtCountRecentAuthFailures = db.prepare(
  'SELECT COUNT(*) AS cnt FROM code_auth_failures WHERE attempted_at >= ?',
);
const stmtCountRecentAuthFailuresByIp = db.prepare(
  'SELECT COUNT(*) AS cnt FROM code_auth_failures WHERE ip_address = ? AND attempted_at >= ?',
);
const stmtPruneOldAuthFailures = db.prepare(
  'DELETE FROM code_auth_failures WHERE attempted_at < ?',
);

// Email auth (password-based login)
const stmtCreateEmailAuth = db.prepare(`
  INSERT INTO email_auth (user_id, password_hash, email_verified, created_at, updated_at)
  VALUES (@user_id, @password_hash, @email_verified, @created_at, @updated_at)
`);
const stmtFindEmailAuthByUserId = db.prepare(
  'SELECT * FROM email_auth WHERE user_id = ?',
);

// Email login brute-force tracking (per-IP)
const stmtInsertEmailLoginFailure = db.prepare(
  'INSERT INTO email_login_failures (ip_address, attempted_at) VALUES (?, ?)',
);
const stmtCountRecentEmailLoginFailures = db.prepare(
  'SELECT COUNT(*) AS cnt FROM email_login_failures WHERE ip_address = ? AND attempted_at >= ?',
);
const stmtPruneOldEmailLoginFailures = db.prepare(
  'DELETE FROM email_login_failures WHERE attempted_at < ?',
);

// ── Public API ────────────────────────────────────────────────────────────────

export function findUserByGoogleSub(googleSub) {
  return stmtFindByGoogleSub.get(googleSub) ?? null;
}

export function findUserByEmail(email) {
  return stmtFindByEmail.get(email) ?? null;
}

/**
 * Return every user row matching this email. The email column is only unique
 * for email-auth users (partial index where google_sub IS NULL); a Google user
 * and an email-auth user can legitimately share the same email, and a manual
 * DB edit could even create two Google users on one address. Use this when the
 * caller must disambiguate rather than silently pick the first row.
 */
export function findAllUsersByEmail(email) {
  return stmtFindByEmail.all(email);
}

/**
 * Find a user by email who registered via email/password (not Google).
 * Used during email login to avoid leaking whether a Google account exists
 * with that email.
 */
export function findEmailUserByEmail(email) {
  return stmtFindByEmailNoGoogleSub.get(email) ?? null;
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

/**
 * Give a use back after a job failed, was cancelled, or never ran. Quota is
 * charged up front (anti-flood), so every terminal failure owes a refund.
 * Returns the new uses_remaining, or null when the user is unlimited (NULL) —
 * callers can hand that straight to the client as the authoritative value.
 */
export function refundUserUse(id) {
  stmtRefundUserUses.run({ id, updated_at: Date.now() });
  return stmtGetUserById.get(id)?.uses_remaining ?? null;
}

export function updateTosAccepted(id, version) {
  const now = Date.now();
  return stmtUpdateTosAccepted.run({ id, tos_accepted_at: now, tos_version: version, updated_at: now });
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

/**
 * Give a use back to an invite code — the code-user counterpart of
 * refundUserUse. Returns the new uses_remaining, or null for an unlimited code.
 */
export function refundCodeUse(codeId) {
  stmtRefundCodeUses.run(codeId);
  return stmtFindCodeById.get(codeId)?.uses_remaining ?? null;
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
    encrypted_thumb: data.encryptedThumb ?? null,
    iv_thumb: data.ivThumb ?? null,
    encrypted_full: data.encryptedFull,
    iv_full: data.ivFull,
    full_size_bytes: data.fullSizeBytes ?? 0,
    job_id: data.jobId ?? null,
    created_at: now,
  });
  return { id: Number(result.lastInsertRowid), createdAt: now };
}

export function findStoredResultByJobId(userId, jobId) {
  return stmtFindResultByJobId.get(userId, jobId) ?? null;
}

export function getStoredResultThumb(id, userId) {
  return stmtGetResultThumb.get(id, userId) ?? null;
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

/**
 * Erase a user and everything linked to them, in one transaction.
 *
 * Deletion order is dictated by the foreign keys: stored_results, vault_keys,
 * email_auth and invite_codes all reference users(id), only email_auth cascades,
 * and PRAGMA foreign_keys is ON — so a bare DELETE FROM users fails for any user
 * who ever saved a result, set up a vault, or issued a code.
 *
 * Invite codes created by the user are deleted rather than reassigned: the code
 * is a bearer credential handed out by that user, and leaving live codes behind
 * would let their guests keep generating after the account is gone.
 *
 * job_audit_log rows for the user are deleted too. They are the compliance
 * record (identity + IP, no payloads), and the user-facing promise in the TOS
 * and docs/PRIVACY.md is unconditional destruction; the 6-month prune remains
 * the retention control for accounts that still exist. Code-user rows carry no
 * user_id, hence the user_type filter. revoked_tokens has no user column (it is
 * keyed by jti and prunes itself past expiry), so there is nothing to remove.
 *
 * Returns { deleted: false } when no such user row existed.
 */
export const deleteUserCompletely = db.transaction((userId) => {
  stmtDeleteAllResultsByUser.run(userId);
  stmtDeleteVault.run(userId);
  stmtDeleteEmailAuthByUser.run(userId);
  stmtDeleteCodesByCreator.run(userId);
  stmtDeleteAuditLogsByUser.run(userId);
  const result = stmtDeleteUser.run(userId);
  return { deleted: result.changes > 0 };
});

export function getAllUsers(status = null) {
  if (status) {
    return stmtGetUsersByStatus.all(status);
  }
  return stmtGetAllUsers.all();
}

// Global code-auth brute-force tracking

/**
 * Record a failed invite-code auth attempt, keyed by client IP for per-IP rate limiting.
 * Call this whenever a /auth/code request fails validation.
 */
export function recordCodeAuthFailure(ip = '') {
  stmtInsertAuthFailure.run(ip, Date.now());
}

/**
 * Count global failed code-auth attempts within the given window (ms).
 */
export function getRecentCodeAuthFailureCount(windowMs) {
  return stmtCountRecentAuthFailures.get(Date.now() - windowMs)?.cnt ?? 0;
}

/**
 * Count failed code-auth attempts from a specific IP within the given window (ms).
 */
export function getRecentCodeAuthFailureCountByIp(ip, windowMs) {
  return stmtCountRecentAuthFailuresByIp.get(ip, Date.now() - windowMs)?.cnt ?? 0;
}

/**
 * Prune failure records older than maxAgeMs to keep the table small.
 */
export function pruneCodeAuthFailures(maxAgeMs) {
  return stmtPruneOldAuthFailures.run(Date.now() - maxAgeMs);
}

// Revoked tokens (JWT blocklist)

export function insertRevokedToken(jti, expiresAt) {
  return stmtInsertRevokedToken.run(jti, expiresAt);
}

export function isTokenRevoked(jti) {
  return !!stmtIsTokenRevoked.get(jti);
}

export function pruneRevokedTokens() {
  return stmtPruneRevokedTokens.run(Date.now());
}

// Job audit log

/**
 * Record a job submission for compliance logging.
 * Stores identity + IP + timestamp. Never stores image blobs or payloads.
 */
export function createJobAuditLog({ jobId, userType, userId = null, googleSub = null, email = null, codeId = null, ipAddress }) {
  return stmtCreateJobAuditLog.run({
    job_id: jobId,
    user_type: userType,
    user_id: userId ?? null,
    google_sub: googleSub ?? null,
    email: email ?? null,
    code_id: codeId ?? null,
    ip_address: ipAddress,
    created_at: Date.now(),
  });
}

/**
 * Delete audit log entries older than maxAgeMs (e.g. 6 × 30 days).
 * Called on a daily interval by the server.
 */
export function pruneJobAuditLogsOlderThan(maxAgeMs) {
  return stmtPruneJobAuditLogs.run(Date.now() - maxAgeMs);
}

// Email auth

/**
 * Create an email_auth row for a user. Sets email_verified=1 (mocked — real
 * verification flow infrastructure is present but sending is not yet implemented).
 */
export function createEmailAuth(userId, passwordHash) {
  const now = Date.now();
  return stmtCreateEmailAuth.run({
    user_id: userId,
    password_hash: passwordHash,
    email_verified: 1,
    created_at: now,
    updated_at: now,
  });
}

export function findEmailAuthByUserId(userId) {
  return stmtFindEmailAuthByUserId.get(userId) ?? null;
}

// Email login brute-force tracking

export function recordEmailLoginFailure(ip) {
  return stmtInsertEmailLoginFailure.run(ip, Date.now());
}

export function getRecentEmailLoginFailureCount(ip, windowMs) {
  return stmtCountRecentEmailLoginFailures.get(ip, Date.now() - windowMs)?.cnt ?? 0;
}

export function pruneEmailLoginFailures(maxAgeMs) {
  return stmtPruneOldEmailLoginFailures.run(Date.now() - maxAgeMs);
}

export default db;
