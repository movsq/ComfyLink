import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import {
  initAuth,
  isGoogleLoginEnabled,
  verifyGoogleToken,
  signJwt,
  verifyJwt,
  verifyPcSecret,
  requireActive,
  requireAdmin,
  requireActiveOrCode,
} from './auth.js'; // authentication & authorization middleware
import db, {
  findUserByGoogleSub,
  createUser,
  getUserById,
  validateInviteCode,
  atomicDecrementCodeUses,
  findInviteCodeById,
  createInviteCode,
  getCodesByCreator,
  deleteInviteCode,
  updateInviteCode,
  getVaultByUser,
  createVault,
  updateVault,
  deleteVault,
  createStoredResult,
  listStoredResults,
  getStoredResultFull,
  getStoredResultThumb,
  deleteStoredResult,
  countStoredResults,
  findStoredResultByJobId,
  getAllUsers,
  updateUserStatus,
  updateUserUses,
  atomicDecrementUserUses,
  updateTosAccepted,
  recordCodeAuthFailure,
  getRecentCodeAuthFailureCount,
  getRecentCodeAuthFailureCountByIp,
  pruneCodeAuthFailures,
  insertRevokedToken,
  pruneRevokedTokens,
  createJobAuditLog,
  pruneJobAuditLogsOlderThan,
  findEmailUserByEmail,
  findUserByEmail,
  createEmailAuth,
  findEmailAuthByUserId,
  recordEmailLoginFailure,
  getRecentEmailLoginFailureCount,
  pruneEmailLoginFailures,
  deleteUserCompletely,
  refundUserUse,
  refundCodeUse,
} from './db.js';
import {
  createJob,
  completeJob,
  getJob,
  updateJobStatus,
  updateJobProgress,
  pruneOldJobs,
  getNextPendingJob,
  getActiveJob,
  getJobSnapshot,
  reclaimJob,
  getRecoverableJobsByUserId,
  getCompletedJobsByUserId,
  getUserJobCount,
  getTotalActiveJobCount,
  getQueueState,
  getPublicQueueState,
  getOwnerQueueState,
  deleteJob,
} from './jobs.js';
import { TOS_VERSION, tos } from './tos-content.js';

const MAX_QUEUE_PER_USER = 3;
// Global queue depth — prevents many different identities from filling the queue
const MAX_TOTAL_QUEUE_DEPTH = parseInt(process.env.MAX_TOTAL_QUEUE_DEPTH ?? '50', 10);
// Maximum encrypted payload size (base64 chars). Two 15 MB images ≈ 40 MB base64,
// so 64 MB is ~1.5× the real worst case — enough headroom for the envelope while
// keeping MAX_TOTAL_QUEUE_DEPTH × MAX_PAYLOAD_B64 within reach of a small VPS.
// Payloads are released as soon as a job reaches a terminal state (see below).
const MAX_PAYLOAD_B64 = 64 * 1024 * 1024;
const MAX_RESULTS_PER_USER = parseInt(process.env.MAX_RESULTS_PER_USER ?? '500', 10);
// When false, POST /auth/code returns 403 and the login button is hidden via /config.
const ACCESS_CODES_ENABLED = process.env.ACCESS_CODES_ENABLED !== 'false';
// When true (default), ALL new registrations require a valid registration invite code.
// Set to false only for trusted-network open-registration deployments.
const INVITE_REQUIRED = process.env.INVITE_REQUIRED !== 'false';

// PC public key fingerprint pinning.
// Set PC_PUBLIC_KEY_FINGERPRINT in .env to the SHA-256 hex digest printed by keygen.py.
// Colons and whitespace are stripped for convenience (both '4a3b...' and
// '4a:3b:...' forms accepted, and a trailing newline from a paste is tolerated).
// The value must decode to exactly 32 bytes: checking the *string* length is not
// enough, because Buffer.from(str, 'hex') stops at the first invalid pair and a
// 64-character non-hex value would yield a short buffer that makes timingSafeEqual
// throw inside a WS listener. Validate the charset up front instead.
// When set, a pubkey message from the PC whose key does not match is rejected immediately.
const _pcFingerprintHex = (process.env.PC_PUBLIC_KEY_FINGERPRINT ?? '').replace(/[\s:]/g, '').toLowerCase();
const PC_KEY_FINGERPRINT = /^[0-9a-f]{64}$/.test(_pcFingerprintHex)
  ? Buffer.from(_pcFingerprintHex, 'hex')
  : null;
if (!PC_KEY_FINGERPRINT) {
  const malformed = _pcFingerprintHex.length > 0;
  if (process.env.DEPLOY_MODE === 'remote') {
    console.error(malformed
      ? '[security] FATAL: PC_PUBLIC_KEY_FINGERPRINT is malformed — expected 64 hex characters (colons and whitespace are stripped). Regenerate it with: cd pc-client && python keygen.py'
      : '[security] FATAL: PC_PUBLIC_KEY_FINGERPRINT is required in remote mode. Generate it with: cd pc-client && python keygen.py');
    process.exit(1);
  }
  console.warn(malformed
    ? '[security] WARNING: PC_PUBLIC_KEY_FINGERPRINT is malformed (expected 64 hex characters) — PC public key pinning is DISABLED. Any PC that knows PC_SECRET can publish its own public key. Regenerate it with: cd pc-client && python keygen.py'
    : '[security] WARNING: PC_PUBLIC_KEY_FINGERPRINT is not set — PC public key pinning is DISABLED. Any PC that knows PC_SECRET can publish its own public key. Generate it with: cd pc-client && python keygen.py');
}

// ── Last-resort process guards ───────────────────────────────────────────────
// Without these, a throw inside a WebSocket listener (or a rejected promise in
// an async route) kills the process with an unhandled-error dump and no line in
// the application log explaining what happened. Log the full error, then exit
// deliberately so the supervisor restarts a known-good process rather than
// leaving a half-broken one serving traffic.
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err?.stack ?? err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled promise rejection:', reason?.stack ?? reason);
  process.exit(1);
});

// ── Per-user submit rate limiter (persists across reconnects) ─────────────────
const WS_SUBMIT_WINDOW_MS = 60_000;
const WS_SUBMIT_MAX = 10;
const submitRateLimiter = new Map(); // Map<queueUserId, number[]>

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── PC relay state ────────────────────────────────────────────────────────────
let pcSocket = null;
let pcPublicKeyB64 = null;

// ── Thumbnail size guard ─────────────────────────────────────────────────────
// The PC sends the 200px WebP thumbnail encrypted end-to-end under the per-job
// result key, in the same envelope shape as `payload`: base64 of
// [12-byte IV][AES-GCM ciphertext+tag]. The relay never sees it in plaintext —
// it cannot decrypt it, cannot inspect its format, and only the browser holding
// the job's result key can. The server therefore treats it as an opaque string:
// base64 charset plus a length cap, nothing more. Retaining it on the job object
// for replay-on-reconnect is safe for the same reason.
// Max thumbnail size as base64 chars: 256 KB binary ≈ 344 KB base64, plus IV and
// GCM tag overhead — 400 000 leaves room without admitting oversized blobs.
const THUMB_MAX_B64_LEN = 400_000;

// ── Admin WebSocket connections ───────────────────────────────────────────────
// Map<WebSocket, userId> for all currently-connected admin sockets
const adminSockets = new Map();

function notifyAdmins(type) {
  for (const ws of adminSockets.keys()) {
    sendJson(ws, { type });
  }
}

// ── Code-user phone socket tracking ──────────────────────────────────────────
// Map<codeId, Set<WebSocket>> — live connections authenticated via an invite code
const phoneCodeSockets = new Map();

function registerCodeSocket(codeId, ws) {
  if (!phoneCodeSockets.has(codeId)) phoneCodeSockets.set(codeId, new Set());
  phoneCodeSockets.get(codeId).add(ws);
}

function unregisterCodeSocket(codeId, ws) {
  const set = phoneCodeSockets.get(codeId);
  if (!set) return;
  set.delete(ws);
  // Drop the key too, otherwise the Map keeps one empty Set per code ever seen.
  if (set.size === 0) phoneCodeSockets.delete(codeId);
}

function notifyCodeUsers(codeId, usesRemaining) {
  const sockets = phoneCodeSockets.get(codeId);
  if (!sockets) return;
  for (const ws of sockets) {
    sendJson(ws, { type: 'code_status', usesRemaining });
  }
}
// ── Google-user phone socket tracking ───────────────────────────────────────────────
// Map<userId, Set<WebSocket>> — live connections authenticated as Google users
const phoneUserSockets = new Map();

function registerUserSocket(userId, ws) {
  if (!phoneUserSockets.has(userId)) phoneUserSockets.set(userId, new Set());
  phoneUserSockets.get(userId).add(ws);
}

function unregisterUserSocket(userId, ws) {
  const set = phoneUserSockets.get(userId);
  if (!set) return;
  set.delete(ws);
  // Drop the key too, otherwise the Map keeps one empty Set per user ever seen.
  if (set.size === 0) phoneUserSockets.delete(userId);
}

function notifyUserSockets(userId, usesRemaining) {
  const sockets = phoneUserSockets.get(userId);
  if (!sockets) return;
  for (const ws of sockets) {
    sendJson(ws, { type: 'uses_updated', usesRemaining });
  }
}

/**
 * Give back the quota use that handleJobSubmit charged up front, for a job that
 * will never produce a result (PC error, or the owner cancelling). Charging on
 * submit is deliberate — it is what stops a flood from queueing for free — so
 * the compensating increment lives here rather than moving the decrement later.
 *
 * `job.refunded` makes this idempotent: a cancelled job can still draw a late
 * `error` message from the PC for the same jobId, and that must not pay twice.
 * A null uses_remaining means unlimited quota, and the DB helpers return null
 * for that case — nothing to refund and nothing to broadcast.
 */
function refundJobQuota(job) {
  if (!job || job.refunded) return;
  job.refunded = true;
  const owner = job.userId; // 'user:<id>' or 'code:<id>'
  if (typeof owner !== 'string') return;
  if (owner.startsWith('user:')) {
    const id = parseInt(owner.slice(5), 10);
    if (!Number.isInteger(id)) return;
    const remaining = refundUserUse(id);
    if (remaining == null) return;
    notifyAdmins('users_changed');
    notifyUserSockets(id, remaining);
  } else if (owner.startsWith('code:')) {
    const id = parseInt(owner.slice(5), 10);
    if (!Number.isInteger(id)) return;
    const remaining = refundCodeUse(id);
    if (remaining == null) return;
    notifyAdmins('codes_changed');
    notifyCodeUsers(id, remaining);
  }
}

// ── Queue broadcast ──────────────────────────────────────────────────────────
// All connected phone sockets (for queue_update broadcasts)
const allPhoneSockets = new Map(); // Map<WebSocket, { userId: string|null, sessionId: string|null }>

function registerPhoneSocket(ws, userId, sessionId) {
  allPhoneSockets.set(ws, { userId, sessionId });
}

function unregisterPhoneSocket(ws) {
  allPhoneSockets.delete(ws);
}

function isSessionOnline(sessionId) {
  if (!sessionId) return false;
  for (const [, meta] of allPhoneSockets) {
    if (meta.sessionId === sessionId) return true;
  }
  return false;
}

/** Broadcast queue_update to all connected phone sockets.
 *  Non-owners receive only aggregate data (no job IDs).
 *  The owner receives per-job detail for their own jobs.
 */
function broadcastQueueUpdate() {
  const pub = getPublicQueueState();
  for (const [ws, meta] of allPhoneSockets) {
    if (ws.readyState !== 1) continue;
    if (meta.sessionId) {
      // Send private detail (own jobs) merged with public summary
      const own = getOwnerQueueState(meta.sessionId);
      sendJson(ws, { type: 'queue_update', ...pub, ...own, maxQueuePerUser: MAX_QUEUE_PER_USER });
    } else {
      sendJson(ws, { type: 'queue_update', ...pub, maxQueuePerUser: MAX_QUEUE_PER_USER });
    }
  }
}

/** Dispatch the next pending job to PC, if PC is connected and no job is processing. */
function dispatchNextJob() {
  if (!pcSocket || pcSocket.readyState !== 1) return;
  if (getActiveJob()) return; // already processing one
  const next = getNextPendingJob();
  if (!next) return;
  sendJson(pcSocket, { type: 'job', jobId: next.id, payload: next.payload });
  updateJobStatus(next.id, 'processing');
  console.log(`[queue] Dispatched job ${next.id} to PC.`);
  broadcastQueueUpdate();
}
function sendJson(ws, obj) {
  if (!ws) return false;
  if (ws.readyState !== 1 /* OPEN */) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

/**
 * Send and wait for the underlying socket to actually flush the bytes. The ws
 * library invokes the callback with an err once the OS accepts the data (or
 * when the connection drops before it can be sent), which is a much better
 * "delivered to the wire" signal than sendJson()'s "send() did not throw".
 * Use this for messages whose loss is unacceptable, e.g. the encrypted result.
 */
function sendJsonAck(ws, obj, onFlushed) {
  if (!ws || ws.readyState !== 1) {
    onFlushed(false);
    return;
  }
  try {
    ws.send(JSON.stringify(obj), (err) => onFlushed(!err));
  } catch {
    onFlushed(false);
  }
}

function getSessionInvalidReason(jwtPayload, rawToken) {
  const verified = verifyJwt(rawToken);
  if (!verified) return 'token_expired';

  if (jwtPayload.type === 'code_user') {
    if (!ACCESS_CODES_ENABLED) return 'codes_disabled';
    const code = findInviteCodeById(jwtPayload.codeId);
    if (!code) return 'code_not_found';
    if (code.expires_at !== null && Date.now() > code.expires_at) return 'code_expired';
    if (code.uses_remaining !== null && code.uses_remaining <= 0) return 'code_exhausted';
    return null;
  }

  // Google users and email users share the same DB status path
  const user = getUserById(jwtPayload.userId);
  if (!user || user.status !== 'active') return 'account_suspended';
  return null;
}

function invalidatePhoneSession(ws, reason) {
  sendJson(ws, { type: 'session_invalid', reason });
  ws.close(4003, 'Session invalid');
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// Trust a reverse proxy (Caddy/nginx) so req.ip is the real client IP, not the
// container IP. Only enabled when BEHIND_PROXY=true — without a proxy, trusting
// X-Forwarded-For lets clients forge their IP to bypass rate limiting.
if (process.env.BEHIND_PROXY === 'true') {
  app.set('trust proxy', 1);
}

/**
 * The real client address when a reverse proxy is in front of us, or null when
 * we cannot trust the headers.
 *
 * Prefer X-Real-IP: Caddy sets it from {remote_host} on both the API and /ws*
 * routes, and with `trusted_proxies` configured that is the true visitor in the
 * Cloudflare and no-Cloudflare topologies alike. The rightmost X-Forwarded-For
 * hop is the fallback — it is the one inserted by the trusted proxy itself,
 * whereas the leftmost entry is attacker-controlled (any client can send
 * `X-Forwarded-For: 1.2.3.4` and Caddy appends the real IP after it, so [0] is
 * the spoofed value). With two proxy layers the rightmost hop can be the CDN
 * edge rather than the visitor, which is exactly what X-Real-IP avoids.
 *
 * Only consulted when BEHIND_PROXY=true — without a proxy, trusting either
 * header lets clients forge their IP to bypass rate limiting.
 */
function getClientIp(req) {
  if (process.env.BEHIND_PROXY !== 'true') return null;
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) {
    const hops = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return null;
}

/** Rate-limit bucket key — same resolution as getClientIp, falling back to req.ip. */
function rateLimitKey(req) {
  return getClientIp(req) ?? req.ip ?? 'unknown';
}

// Trailing/leading whitespace around a comma-separated entry would otherwise
// make the second origin match neither the CORS check nor the WS Origin check,
// producing a 403 the deployer is likely to "fix" by clearing the variable.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (allowedOrigins.length === 0) {
  if (process.env.DEPLOY_MODE === 'remote') {
    throw new Error('[security] ALLOWED_ORIGINS must be set in remote mode');
  }
  console.warn(
    '[security] WARNING: ALLOWED_ORIGINS is not set and DEPLOY_MODE is not "remote". The following checks are DISABLED:\n' +
    '  • CORS origin restriction — any website can call this API from a browser\n' +
    '  • WebSocket Origin check (CSWSH) — any website can open /ws/phone and /ws/admin with a stolen session\n' +
    '  • Required PC public key fingerprint — pinning is optional instead of mandatory\n' +
    '  Set ALLOWED_ORIGINS (and DEPLOY_MODE=remote) on any relay reachable from outside localhost.',
  );
}
app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : undefined));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// 30 MB covers a 20 MB binary encrypted image (≈ 27 MB base64) plus the
// thumbnail blob and JSON overhead written to POST /results. Other endpoints
// post far smaller bodies, so the headroom is harmless. The per-route check
// inside /results still enforces the 20 MB binary cap.
app.use(express.json({ limit: '30mb' }));

// Rate limiting
// Auth endpoints: 30 req/min per IP — generous enough for normal interactive login
// (Google's Sign-In widget can fire multiple XHRs on retry/page-reload) but still
// blocks automated stuffing. /auth/register and /auth/login/email use a stricter
// per-route limiter (emailAuthLimiter) and are excluded from authLimiter so each
// request only consumes one rate-limit bucket.
// keyGenerator: bucket on the same address getClientIp resolves, so two proxy
// layers do not collapse every visitor onto a handful of CDN edge IPs.
const authLimiter      = rateLimit({ windowMs: 60_000, max: 30,  standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey, skip: (req) => /^\/register\/?$/.test(req.path) || /^\/login\/email\/?$/.test(req.path), message: { error: 'Too many requests — try again later' } });
const emailAuthLimiter = rateLimit({ windowMs: 60_000, max: 10,  standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey, message: { error: 'Too many requests — try again later' } });
const apiLimiter       = rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey, skip: (req) => req.path.startsWith('/auth/'), message: { error: 'Too many requests — try again later' } });
app.use('/auth/', authLimiter);
app.use('/auth/register', emailAuthLimiter);
app.use('/auth/login/email', emailAuthLimiter);
app.use(apiLimiter);

/** POST /auth/google — exchange a Google ID token (+ optional invite code) for a JWT */
app.post('/auth/google', async (req, res) => {
  // Without GOOGLE_CLIENT_ID we cannot enforce the `aud` claim, so this route
  // would accept an ID token minted for any other Google application. Refuse
  // before touching the token rather than verifying it unaudited.
  if (!isGoogleLoginEnabled()) {
    return res.status(503).json({ error: 'google_login_disabled' });
  }

  const { idToken, inviteCode } = req.body ?? {};
  if (typeof idToken !== 'string') {
    return res.status(400).json({ error: 'idToken required' });
  }

  let googleUser;
  try {
    googleUser = await verifyGoogleToken(idToken);
  } catch {
    return res.status(401).json({ error: 'Invalid Google token' });
  }

  const existing = findUserByGoogleSub(googleUser.sub);

  // ── Existing user ─────────────────────────────────────────────────────────
  if (existing) {
    if (existing.status === 'suspended') {
      return res.status(403).json({ error: 'suspended' });
    }
    if (existing.status === 'pending') {
      return res.status(200).json({ status: 'pending_approval', isNew: false });
    }
    // active
    const token = signJwt({
      userId: existing.id,
      googleSub: existing.google_sub,
      status: existing.status,
      isAdmin: !!existing.is_admin,
      type: 'google',
    });
    return res.json({
      token,
      tosAccepted: existing.tos_version === TOS_VERSION,
      user: { name: existing.name, email: existing.email, status: existing.status, isAdmin: !!existing.is_admin, usesRemaining: existing.uses_remaining ?? null, tosAccepted: existing.tos_version === TOS_VERSION, type: 'google' },
    });
  }

  // ── New user with invite code ─────────────────────────────────────────────
  if (inviteCode) {
    const code = validateInviteCode(inviteCode.trim().toUpperCase(), 'registration');
    if (!code) {
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }
    // Block if an email-auth account already exists with this Google email
    if (findEmailUserByEmail(googleUser.email?.toLowerCase())) {
      return res.status(409).json({ error: 'An account with this email already exists. Try signing in with email and password.' });
    }
    const codeResult = atomicDecrementCodeUses(code.id);
    if (codeResult.changes === 0) {
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }
    const user = createUser({
      googleSub: googleUser.sub,
      email: googleUser.email?.toLowerCase(),
      name: googleUser.name,
      picture: googleUser.picture,
      status: 'active',
    });
    notifyAdmins('users_changed');
    notifyAdmins('codes_changed');
    const token = signJwt({
      userId: user.id,
      googleSub: user.google_sub,
      status: user.status,
      isAdmin: !!user.is_admin,
      type: 'google',
    });
    return res.json({
      token,
      tosAccepted: false,
      user: { name: user.name, email: user.email, status: user.status, isAdmin: !!user.is_admin, usesRemaining: user.uses_remaining ?? null, tosAccepted: false, type: 'google' },
    });
  }

  // ── New user without invite code ────────────────────────────────────────────
  if (INVITE_REQUIRED) {
    // Invite is mandatory — do NOT create a DB record; tell the client to prompt for a code.
    return res.status(200).json({ status: 'invite_required' });
  }
  // Block if an email-auth account already exists with this Google email
  if (findEmailUserByEmail(googleUser.email?.toLowerCase())) {
    return res.status(409).json({ error: 'An account with this email already exists. Try signing in with email and password.' });
  }
  // Invite not required — create a pending account awaiting admin approval.
  createUser({
    googleSub: googleUser.sub,
    email: googleUser.email?.toLowerCase(),
    name: googleUser.name,
    picture: googleUser.picture,
    status: 'pending',
  });
  notifyAdmins('users_changed');
  return res.status(200).json({ status: 'pending_approval', isNew: true });
});

/** GET /auth/me — return current user info from DB */
app.get('/auth/me', (req, res) => {
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  const user = getUserById(payload.userId);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    name: user.name,
    email: user.email,
    status: user.status,
    isAdmin: !!user.is_admin,
    usesRemaining: user.uses_remaining ?? null,
    tosAccepted: user.tos_version === TOS_VERSION,
  });
});

/** POST /auth/tos — record that the user has accepted the Terms of Service */
app.post('/auth/tos', requireActive, (req, res) => {
  const { accepted } = req.body ?? {};
  if (accepted !== true) {
    return res.status(400).json({ error: 'Must explicitly accept terms (accepted: true)' });
  }
  updateTosAccepted(req.user.userId, TOS_VERSION);
  res.json({ ok: true, tosAccepted: true });
});

/** GET /tos — serve TOS HTML content and current version (no auth required) */
app.get('/tos', (req, res) => {
  res.json({ version: TOS_VERSION, ...tos });
});

/**
 * GET /pc-pubkey — serve the PC's cached public key so the phone can encrypt.
 * Requires an active session.
 */
app.get('/pc-pubkey', requireActiveOrCode, (req, res) => {
  if (!pcPublicKeyB64) {
    return res.status(503).json({ error: 'PC not connected' });
  }
  res.json({ publicKey: pcPublicKeyB64 });
});

/** GET /health — simple liveness check */
app.get('/health', (_req, res) => res.json({ ok: true }));

/** GET /config — public feature flags consumed by the frontend */
app.get('/config', (_req, res) => res.json({ accessCodesEnabled: ACCESS_CODES_ENABLED, inviteRequired: INVITE_REQUIRED }));

// ── Invite code management (admin only) ───────────────────────────────────────

/** POST /codes — generate a new invite code */
app.post('/codes', requireAdmin, (req, res) => {
  const { type = 'registration', usesRemaining: usesRemainingRaw = 1, expiresInHours: expiresInHoursRaw = null } = req.body ?? {};
  if (!['registration', 'job_access'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }
  let usesRemaining = null;
  if (usesRemainingRaw !== null && usesRemainingRaw !== undefined) {
    const n = parseInt(usesRemainingRaw, 10);
    if (isNaN(n) || n < 1 || n > 999_999) {
      return res.status(400).json({ error: 'usesRemaining must be a positive integer ≤ 999999 or null (unlimited)' });
    }
    usesRemaining = n;
  }
  let expiresInHours = null;
  if (expiresInHoursRaw !== null && expiresInHoursRaw !== undefined) {
    const n = parseFloat(expiresInHoursRaw);
    if (isNaN(n) || n <= 0 || n > 87_600) { // max 10 years
      return res.status(400).json({ error: 'expiresInHours must be a positive number and at most 87600' });
    }
    expiresInHours = n;
  }

  // Generate KLEIN-XXXX-XXXX format
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  const bytes = randomBytes(8);
  let code = 'KLEIN-';
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
    if (i === 3) code += '-';
  }

  const expiresAt = expiresInHours !== null ? Date.now() + expiresInHours * 3600_000 : null;

  createInviteCode({
    code,
    type,
    createdBy: req.user.userId,
    usesRemaining,
    expiresAt,
  });

  notifyAdmins('codes_changed');
  res.json({ code, type, usesRemaining, expiresAt });
});

/** GET /codes — list codes created by this admin */
app.get('/codes', requireAdmin, (req, res) => {
  const codes = getCodesByCreator(req.user.userId);
  res.json(codes.map(c => ({
    id: c.id,
    code: c.code,
    type: c.type,
    usesRemaining: c.uses_remaining,
    expiresAt: c.expires_at,
    createdAt: c.created_at,
  })));
});

/** DELETE /codes/:id — revoke a code */
app.delete('/codes/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const result = deleteInviteCode(id, req.user.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  notifyAdmins('codes_changed');
  res.json({ ok: true });
});

/** PATCH /codes/:id — edit uses_remaining and/or expires_at of an existing code.
 *  Fields absent from the body are left unchanged; explicit `null` clears them
 *  (unlimited uses / no expiration). */
app.patch('/codes/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const body = req.body ?? {};
  const usesProvided = Object.prototype.hasOwnProperty.call(body, 'usesRemaining');
  const expiresProvided = Object.prototype.hasOwnProperty.call(body, 'expiresInHours');
  if (!usesProvided && !expiresProvided) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  const existing = findInviteCodeById(id);
  if (!existing || existing.created_by !== req.user.userId) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Defaults preserve existing values; only override what the caller provided.
  let nextUses = existing.uses_remaining;
  let nextExpiresAt = existing.expires_at;

  if (usesProvided) {
    const raw = body.usesRemaining;
    if (raw === null) {
      nextUses = null;
    } else {
      const n = parseInt(raw, 10);
      if (isNaN(n) || n < 0) return res.status(400).json({ error: 'usesRemaining must be a non-negative integer or null' });
      nextUses = n;
    }
  }
  if (expiresProvided) {
    const raw = body.expiresInHours;
    if (raw === null) {
      nextExpiresAt = null;
    } else {
      const n = parseFloat(raw);
      if (isNaN(n) || n <= 0 || n > 87_600) return res.status(400).json({ error: 'expiresInHours must be a positive number and at most 87600' });
      nextExpiresAt = Date.now() + n * 3600_000;
    }
  }

  const result = updateInviteCode(id, req.user.userId, { usesRemaining: nextUses, expiresAt: nextExpiresAt });
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  notifyAdmins('codes_changed');
  // Push the authoritative uses count to any connected code-users for this code.
  notifyCodeUsers(id, nextUses);
  res.json({ ok: true });
});

// ── Request field validation ──────────────────────────────────────────────────

const BASE64_RE = /^[A-Za-z0-9+\/]*={0,2}$/;

/**
 * True when `value` is safe to hand to Buffer.from(value, 'base64').
 * Buffer.from throws a TypeError on a non-string, and an unbounded string is a
 * free allocation for the caller — so every field that reaches it must pass
 * through here first, or the throw escapes the handler (see the terminal error
 * handler at the bottom of the route table).
 */
function isValidBase64(value, maxLen) {
  return typeof value === 'string' && value.length <= maxLen && BASE64_RE.test(value);
}

// Wrapped master keys, salts and the PRF public key are all small fixed-size
// blobs (32–128 bytes); 1024 base64 chars is far above any legitimate value.
const MAX_VAULT_B64_LEN = 1024;

/**
 * Validate the optional base64 blob/salt fields shared by /vault/setup and
 * /vault/rekey. Returns the offending field name, or null when all are fine.
 * Absent fields are legal — both routes treat them as "leave unchanged".
 */
function findInvalidVaultBlob(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (!isValidBase64(value, MAX_VAULT_B64_LEN)) return name;
  }
  return null;
}

// ── Vault key management ──────────────────────────────────────────────────────

/** POST /vault/setup — store wrapped master key blobs + salts + WebAuthn credential */
app.post('/vault/setup', requireActive, (req, res) => {
  const userId = req.user.userId;
  const existing = getVaultByUser(userId);
  if (existing) {
    return res.status(409).json({ error: 'Vault already exists. Use /vault/rekey to change keys.' });
  }

  const {
    encryptedMasterKeyBio, encryptedMasterKeyPw, encryptedMasterKeyRecovery,
    prfSalt, pbkdf2Salt, prfCredentialId, prfPublicKey,
  } = req.body ?? {};

  if (!encryptedMasterKeyRecovery) {
    return res.status(400).json({ error: 'Recovery-wrapped master key is required' });
  }
  // A recovery-only vault is unusable in normal day-to-day flow: the unlock
  // panel only shows bio/password buttons, so the user would be locked into
  // using their recovery key every session. The browser client always sends
  // at least one — enforce it server-side so a buggy or malicious client
  // can't trap the user.
  if (!encryptedMasterKeyBio && !encryptedMasterKeyPw) {
    return res.status(400).json({ error: 'At least one of bio or password unlock must be configured' });
  }

  const badField = findInvalidVaultBlob({
    encryptedMasterKeyBio, encryptedMasterKeyPw, encryptedMasterKeyRecovery,
    prfSalt, pbkdf2Salt, prfPublicKey,
  });
  if (badField) {
    return res.status(400).json({ error: `Invalid base64 in ${badField}` });
  }
  // Not decoded, but it is written straight to SQLite — a non-string would throw
  // out of the driver just the same.
  if (prfCredentialId !== undefined && prfCredentialId !== null &&
      (typeof prfCredentialId !== 'string' || prfCredentialId.length > MAX_VAULT_B64_LEN)) {
    return res.status(400).json({ error: 'Invalid prfCredentialId' });
  }

  createVault(userId, {
    encryptedMasterKeyBio: encryptedMasterKeyBio ? Buffer.from(encryptedMasterKeyBio, 'base64') : null,
    encryptedMasterKeyPw: encryptedMasterKeyPw ? Buffer.from(encryptedMasterKeyPw, 'base64') : null,
    encryptedMasterKeyRecovery: Buffer.from(encryptedMasterKeyRecovery, 'base64'),
    prfSalt: prfSalt ? Buffer.from(prfSalt, 'base64') : null,
    pbkdf2Salt: pbkdf2Salt ? Buffer.from(pbkdf2Salt, 'base64') : null,
    prfCredentialId: prfCredentialId ?? null,
    prfPublicKey: prfPublicKey ? Buffer.from(prfPublicKey, 'base64') : null,
  });

  res.json({ ok: true });
});

/** GET /vault/info — which wrapping methods are configured + salts */
app.get('/vault/info', requireActive, (req, res) => {
  const vault = getVaultByUser(req.user.userId);
  if (!vault) {
    return res.json({ configured: false });
  }
  res.json({
    configured: true,
    hasBio: !!vault.encrypted_master_key_bio,
    hasPw: !!vault.encrypted_master_key_pw,
    hasRecovery: !!vault.encrypted_master_key_recovery,
    prfSalt: vault.prf_salt ? vault.prf_salt.toString('base64') : null,
    pbkdf2Salt: vault.pbkdf2_salt ? vault.pbkdf2_salt.toString('base64') : null,
    prfCredentialId: vault.prf_credential_id ?? null,
  });
});

/** POST /vault/unlock — return the requested encrypted master key blob */
app.post('/vault/unlock', requireActive, (req, res) => {
  const { method } = req.body ?? {};
  if (!['bio', 'pw', 'recovery'].includes(method)) {
    return res.status(400).json({ error: 'method must be bio, pw, or recovery' });
  }

  const vault = getVaultByUser(req.user.userId);
  if (!vault) return res.status(404).json({ error: 'No vault configured' });

  const columnMap = { bio: 'encrypted_master_key_bio', pw: 'encrypted_master_key_pw', recovery: 'encrypted_master_key_recovery' };
  const blob = vault[columnMap[method]];
  if (!blob) return res.status(404).json({ error: `No ${method} wrapping configured` });

  res.json({ encryptedMasterKey: blob.toString('base64') });
});

/** Step-up auth helper for vault mutation endpoints (/vault/rekey, DELETE /vault).
 *  Authenticates Google users via idToken and email users via password confirmation. */
async function requireVaultStepUp(req, res, userId) {
  const user = getUserById(userId);
  if (!user) { res.status(403).json({ error: 'Re-authentication failed' }); return false; }
  if (user.google_sub) {
    // Google user: require a fresh Google ID token. Same audience-confusion
    // reasoning as POST /auth/google — refuse rather than verify unaudited.
    if (!isGoogleLoginEnabled()) { res.status(503).json({ error: 'google_login_disabled' }); return false; }
    const { idToken } = req.body ?? {};
    if (!idToken) { res.status(400).json({ error: 'Re-authentication required (idToken)' }); return false; }
    try {
      const googleUser = await verifyGoogleToken(idToken);
      if (user.google_sub !== googleUser.sub) { res.status(403).json({ error: 'Re-authentication failed' }); return false; }
    } catch { res.status(401).json({ error: 'Invalid Google token' }); return false; }
    return true;
  } else {
    // Email user: require current password confirmation
    const { password } = req.body ?? {};
    if (!password) { res.status(400).json({ error: 'Re-authentication required (password)' }); return false; }
    const emailAuth = findEmailAuthByUserId(userId);
    if (!emailAuth) { res.status(403).json({ error: 'Re-authentication failed' }); return false; }
    let ok = false;
    try { ok = await argon2Verify(emailAuth.password_hash, password); } catch { res.status(500).json({ error: 'Re-authentication error' }); return false; }
    if (!ok) { res.status(403).json({ error: 'Re-authentication failed' }); return false; }
    return true;
  }
}

/** POST /vault/rekey — re-wrap master key with new wrapping keys */
app.post('/vault/rekey', requireActive, async (req, res) => {
  const userId = req.user.userId;
  const existing = getVaultByUser(userId);
  if (!existing) return res.status(404).json({ error: 'No vault configured' });

  if (!await requireVaultStepUp(req, res, userId)) return;

  const {
    encryptedMasterKeyBio, encryptedMasterKeyPw, encryptedMasterKeyRecovery,
    prfSalt, pbkdf2Salt, prfCredentialId, prfPublicKey,
  } = req.body ?? {};

  const badField = findInvalidVaultBlob({
    encryptedMasterKeyBio, encryptedMasterKeyPw, encryptedMasterKeyRecovery,
    prfSalt, pbkdf2Salt, prfPublicKey,
  });
  if (badField) {
    return res.status(400).json({ error: `Invalid base64 in ${badField}` });
  }
  if (prfCredentialId !== undefined && prfCredentialId !== null &&
      (typeof prfCredentialId !== 'string' || prfCredentialId.length > MAX_VAULT_B64_LEN)) {
    return res.status(400).json({ error: 'Invalid prfCredentialId' });
  }

  updateVault(userId, {
    encryptedMasterKeyBio: encryptedMasterKeyBio ? Buffer.from(encryptedMasterKeyBio, 'base64') : existing.encrypted_master_key_bio,
    encryptedMasterKeyPw: encryptedMasterKeyPw ? Buffer.from(encryptedMasterKeyPw, 'base64') : existing.encrypted_master_key_pw,
    encryptedMasterKeyRecovery: encryptedMasterKeyRecovery ? Buffer.from(encryptedMasterKeyRecovery, 'base64') : existing.encrypted_master_key_recovery,
    prfSalt: prfSalt ? Buffer.from(prfSalt, 'base64') : existing.prf_salt,
    pbkdf2Salt: pbkdf2Salt ? Buffer.from(pbkdf2Salt, 'base64') : existing.pbkdf2_salt,
    prfCredentialId: prfCredentialId ?? existing.prf_credential_id,
    prfPublicKey: prfPublicKey ? Buffer.from(prfPublicKey, 'base64') : existing.prf_public_key,
  });

  res.json({ ok: true });
});

/** DELETE /vault — permanently delete vault + all encrypted results */
app.delete('/vault', requireActive, async (req, res) => {
  const vault = getVaultByUser(req.user.userId);
  if (!vault) return res.status(404).json({ error: 'No vault configured' });

  if (!await requireVaultStepUp(req, res, req.user.userId)) return;

  deleteVault(req.user.userId);
  res.json({ ok: true });
});

// ── Stored results ────────────────────────────────────────────────────────────

/** POST /results — store encrypted full blob + optional encrypted thumbnail */
app.post('/results', requireActive, (req, res) => {
  const { encryptedFull, ivFull, fullSizeBytes, jobId, encryptedThumb, ivThumb } = req.body ?? {};

  if (!encryptedFull || !ivFull) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // ── Per-user storage quota ──────────────────────────────────────────────────
  if (countStoredResults(req.user.userId) >= MAX_RESULTS_PER_USER) {
    return res.status(429).json({ error: `Storage limit reached (max ${MAX_RESULTS_PER_USER} results)` });
  }

  // ── Deduplication: reject if this job was already saved ────────────────────
  if (typeof jobId === 'string' && jobId) {
    if (findStoredResultByJobId(req.user.userId, jobId)) {
      return res.status(409).json({ error: 'Result already saved' });
    }
  }

  if (typeof encryptedFull !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encryptedFull)) {
    return res.status(400).json({ error: 'Invalid base64 encoding' });
  }
  // ivFull gets exactly the same treatment as ivThumb below: a 12-byte AES-GCM
  // IV is 16 base64 characters, so reject anything longer *before* decoding, and
  // confirm the decoded length after. Previously this went straight into
  // Buffer.from and a non-string threw a TypeError out of the handler.
  if (!isValidBase64(ivFull, 16)) {
    return res.status(400).json({ error: 'Invalid IV' });
  }
  const ivFullBuf = Buffer.from(ivFull, 'base64');
  if (ivFullBuf.length !== 12) {
    return res.status(400).json({ error: 'Invalid IV length' });
  }
  const fullBuf = Buffer.from(encryptedFull, 'base64');
  if (fullBuf.length > 20 * 1024 * 1024) {
    return res.status(413).json({ error: 'Image too large (max 20MB)' });
  }

  // Clamp fullSizeBytes to actual buffer length — client value is advisory metadata
  // for display only, but must not exceed what we actually stored.
  const sanitizedFullSizeBytes = Math.min(
    Number.isFinite(Number(fullSizeBytes)) && Number(fullSizeBytes) > 0
      ? Math.round(Number(fullSizeBytes))
      : fullBuf.length,
    fullBuf.length,
  );

  // ── Validate and store client-encrypted thumbnail (optional) ────────────────
  // The browser encrypts the thumbnail with the vault master key before upload.
  let encThumbBuf = null;
  let ivThumbBuf = null;
  if (typeof encryptedThumb === 'string' && typeof ivThumb === 'string' &&
      encryptedThumb.length > 0 && ivThumb.length > 0) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encryptedThumb) || !/^[A-Za-z0-9+/]*={0,2}$/.test(ivThumb)) {
      return res.status(400).json({ error: 'Invalid base64 encoding in thumbnail' });
    }
    // A 12-byte AES-GCM IV encodes to exactly 16 base64 characters (no padding).
    // Reject anything longer before decoding to prevent oversized IV injection.
    if (ivThumb.length > 16) {
      return res.status(400).json({ error: 'Invalid IV length' });
    }
    encThumbBuf = Buffer.from(encryptedThumb, 'base64');
    ivThumbBuf  = Buffer.from(ivThumb, 'base64');
    if (ivThumbBuf.length !== 12) {
      return res.status(400).json({ error: 'Invalid IV length' });
    }
    // Encrypted thumb: ciphertext can be at most 256 KB + GCM tag (16 bytes)
    if (encThumbBuf.length > 270 * 1024) {
      return res.status(413).json({ error: 'Thumbnail too large' });
    }
  }

  let result;
  try {
    result = createStoredResult(req.user.userId, {
      encryptedThumb: encThumbBuf,
      ivThumb: ivThumbBuf,
      encryptedFull: fullBuf,
      ivFull: ivFullBuf,
      fullSizeBytes: sanitizedFullSizeBytes,
      jobId: typeof jobId === 'string' && jobId ? jobId : null,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
      return res.status(409).json({ error: 'Result already saved' });
    }
    throw err;
  }

  res.json(result);
});

/** GET /results — paginated list (no full images, no vault blobs) */
app.get('/results', requireActive, (req, res) => {
  const parsedLimit = parseInt(req.query.limit ?? '20', 10);
  const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20, 50);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  if (before !== null && (!Number.isFinite(before) || before < 1)) {
    return res.status(400).json({ error: 'Invalid before cursor' });
  }

  const rows = listStoredResults(req.user.userId, { limit, before });
  res.json(rows.map(r => ({
    id: r.id,
    hasThumb: !!r.has_thumb,
    fullSizeBytes: r.full_size_bytes,
    createdAt: r.created_at,
  })));
});

/** GET /results/:id — get full encrypted image */
app.get('/results/:id', requireActive, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const row = getStoredResultFull(id, req.user.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });

  res.json({
    encryptedFull: row.encrypted_full.toString('base64'),
    ivFull: row.iv_full.toString('base64'),
  });
});

/** GET /results/:id/thumb — return client-encrypted thumbnail for browser decryption */
app.get('/results/:id/thumb', requireActive, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const row = getStoredResultThumb(id, req.user.userId);
  if (!row || !row.encrypted_thumb || !row.iv_thumb) return res.status(404).json({ error: 'Not found' });

  res.set('Cache-Control', 'private, max-age=3600');
  res.json({
    encryptedThumb: row.encrypted_thumb.toString('base64'),
    ivThumb: row.iv_thumb.toString('base64'),
  });
});

/** DELETE /results/:id — delete a stored result */
app.delete('/results/:id', requireActive, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const result = deleteStoredResult(id, req.user.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Access code auth ──────────────────────────────────────────────────────────

/** POST /auth/code — exchange a job_access code for a limited JWT */
app.post('/auth/code', (req, res) => {
  if (!ACCESS_CODES_ENABLED) {
    return res.status(403).json({ error: 'Access codes are disabled' });
  }

  const { code } = req.body ?? {};
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'code required' });
  }

  const ip = rateLimitKey(req);

  // Per-IP hard block: ≥ 20 failures from this IP in the last 60 s.
  const CODE_BF_WINDOW_MS = 60_000;
  const CODE_BF_IP_MAX = 20;
  if (getRecentCodeAuthFailureCountByIp(ip, CODE_BF_WINDOW_MS) >= CODE_BF_IP_MAX) {
    return res.status(429).json({ error: 'Too many failed attempts — try again later' });
  }

  // Global soft circuit breaker: ≥ 500 failures across all IPs in last 60 s.
  // Only fires under extreme coordinated flooding; individual well-behaved IPs
  // are governed solely by the per-IP check above.
  const CODE_BF_GLOBAL_MAX = 500;
  if (getRecentCodeAuthFailureCount(CODE_BF_WINDOW_MS) >= CODE_BF_GLOBAL_MAX) {
    console.warn('[security] Global code-auth failure threshold reached — possible flood attack.');
    return res.status(429).json({ error: 'Too many failed attempts — try again later' });
  }

  const row = validateInviteCode(code.trim().toUpperCase(), 'job_access');
  if (!row) {
    recordCodeAuthFailure(ip);
    return res.status(400).json({ error: 'Invalid or expired access code' });
  }

  const token = signJwt({ codeId: row.id, type: 'code_user' });
  res.json({ token, user: { type: 'code_user', codeId: row.id } });
});

/** POST /auth/logout — revoke the current JWT so it cannot be reused */
app.post('/auth/logout', (req, res) => {
  const header = req.headers['authorization'] ?? '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!raw) return res.status(401).json({ error: 'No token' });
  const payload = verifyJwt(raw);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });
  if (payload.jti && payload.exp) {
    insertRevokedToken(payload.jti, payload.exp * 1000);
  }
  res.json({ ok: true });
});

// ── Email auth ────────────────────────────────────────────────────────────────

// Allowed symbols in passwords (the set that common services accept).
const PASSWORD_SYMBOL_RE = /[!@#$%^&*()_+\-=[\]{}|;':",.<>?/\\`~]/;
const PASSWORD_LETTER_RE = /[a-zA-Z]/;
const PASSWORD_NUMBER_RE = /[0-9]/;

/**
 * Validate the *account login* password (not the vault password).
 * Requirements:
 *   - Minimum 8 characters
 *   - At least 2 of: letters, numbers, symbols (from the allowed set)
 *
 * The vault password (client-side, see VaultSetup.svelte) is intentionally
 * stricter (12 chars, no class requirement) because it protects the encrypted
 * master key against offline brute-force after a server compromise. The
 * account password is bcrypt'd server-side and rate-limited, so 8+classes is
 * sufficient. Do not unify the two without weighing both attack models.
 *
 * Returns null if valid; an error string if invalid.
 */
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (pw.length > 1024) {
    return 'Password must be at most 1024 characters';
  }
  const hasLetters = PASSWORD_LETTER_RE.test(pw);
  const hasNumbers = PASSWORD_NUMBER_RE.test(pw);
  const hasSymbols = PASSWORD_SYMBOL_RE.test(pw);
  const classCount = (hasLetters ? 1 : 0) + (hasNumbers ? 1 : 0) + (hasSymbols ? 1 : 0);
  if (classCount < 2) {
    return 'Password must contain at least two of: letters, numbers, symbols';
  }
  return null;
}

/** Simple RFC 5322-compatible email format check */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

/**
 * A fixed argon2id hash (of a random throwaway secret, same parameters as
 * registration) used to equalise the cost of the login branches that have no
 * password to verify. Without it, an unknown email returns in microseconds and a
 * known one in tens of milliseconds — a trivially measurable account-existence
 * oracle on the endpoint docs/AUTHENTICATION.md advertises as enumeration-safe.
 * It must never match any real password: nobody knows the input.
 */
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$b5HmAN/N/CkMGcDnjH2e1w$O7VsFh2N5xRZMxefdqV3SiHlxO+WUoENi4NP2jC9C0o';

/** Burn the same argon2 work a real verify would, then discard the result. */
async function dummyPasswordVerify(password) {
  try {
    await argon2Verify(DUMMY_PASSWORD_HASH, password);
  } catch {
    // A verify failure here is expected and irrelevant — we only want the cost.
  }
}

/** POST /auth/register — create a new account with email+password */
app.post('/auth/register', async (req, res) => {
  const { email, password, inviteCode, acceptedData, acceptedTos } = req.body ?? {};

  // ── Input validation ──────────────────────────────────────────────────────
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Valid email address required' });
  }
  const normalizedEmail = email.trim().toLowerCase();

  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  if (acceptedData !== true) {
    return res.status(400).json({ error: 'You must accept the data usage notice' });
  }
  if (acceptedTos !== true) {
    return res.status(400).json({ error: 'You must accept the Terms of Service' });
  }

  // ── Invite code check ─────────────────────────────────────────────────────
  let codeRow = null;
  if (INVITE_REQUIRED) {
    if (!inviteCode || typeof inviteCode !== 'string' || !inviteCode.trim()) {
      return res.status(400).json({ error: 'invite_code_required' });
    }
    codeRow = validateInviteCode(inviteCode.trim().toUpperCase(), 'registration');
    if (!codeRow) {
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }
  } else if (inviteCode && typeof inviteCode === 'string' && inviteCode.trim()) {
    // Invite not required, but one was provided — validate + consume it anyway
    codeRow = validateInviteCode(inviteCode.trim().toUpperCase(), 'registration');
    if (!codeRow) {
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }
  }

  // ── Duplicate email check ─────────────────────────────────────────────────
  const existingAny = findUserByEmail(normalizedEmail);
  if (existingAny) {
    // Surface the same generic message regardless of which auth method was used
    // to avoid leaking whether an account exists with a specific sign-in method.
    // The 409 still discloses that *some* account exists, which is inherent to
    // synchronous registration — so charge the attempt against the same per-IP
    // failure budget the login endpoint uses. Walking a list of addresses here
    // therefore locks the IP out of login as well, which is the point.
    recordEmailLoginFailure(rateLimitKey(req));
    return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
  }

  // ── Hash password (async & expensive — must run before the DB transaction) ──
  const status = codeRow ? 'active' : 'pending';

  let passwordHash;
  try {
    passwordHash = await argon2Hash(password, { algorithm: 2 /* argon2id */, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  } catch (err) {
    console.error('[auth/register] argon2 hash failed:', err);
    return res.status(500).json({ error: 'Registration failed — please try again' });
  }

  // ── Atomically consume invite code + create user + attach password hash ───
  // Wrapped in a single transaction so a failure at any step leaves no orphaned
  // user row and no consumed invite code.
  let newUser;
  try {
    newUser = db.transaction(() => {
      if (codeRow) {
        const decrementResult = atomicDecrementCodeUses(codeRow.id);
        if (decrementResult.changes === 0) {
          throw Object.assign(new Error('Invalid or expired invite code'), { isKnown400: true });
        }
      }
      const user = createUser({ googleSub: null, email: normalizedEmail, name: '', picture: '', status, isAdmin: false });
      createEmailAuth(user.id, passwordHash);
      return user;
    })();
  } catch (err) {
    if (err.isKnown400) return res.status(400).json({ error: err.message });
    console.error('[auth/register] DB write failed:', err);
    return res.status(500).json({ error: 'Registration failed — please try again' });
  }

  notifyAdmins('users_changed');
  if (codeRow) notifyAdmins('codes_changed');

  if (status === 'pending') {
    return res.status(200).json({ status: 'pending_approval' });
  }

  const token = signJwt({ userId: newUser.id, status: newUser.status, isAdmin: false, type: 'email' });
  return res.json({
    token,
    tosAccepted: false,
    user: { name: '', email: normalizedEmail, status: newUser.status, isAdmin: false, usesRemaining: newUser.uses_remaining ?? null, tosAccepted: false, type: 'email' },
  });
});

/** POST /auth/login/email — authenticate with email+password */
app.post('/auth/login/email', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'email required' });
  }
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'password required' });
  }

  const ip = rateLimitKey(req);
  const EMAIL_LOGIN_WINDOW_MS = 15 * 60_000;
  const EMAIL_LOGIN_MAX_FAILURES = 15;

  // Per-IP brute-force check
  if (getRecentEmailLoginFailureCount(ip, EMAIL_LOGIN_WINDOW_MS) >= EMAIL_LOGIN_MAX_FAILURES) {
    return res.status(429).json({ error: 'Too many failed attempts — try again in 15 minutes' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Look up email-auth user only (not Google-only accounts) to avoid leaking account existence
  const user = findEmailUserByEmail(normalizedEmail);
  if (!user) {
    // Spend the same argon2 budget a real verify would, so response time does
    // not disclose whether the address is registered.
    await dummyPasswordVerify(password);
    recordEmailLoginFailure(ip);
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const emailAuth = findEmailAuthByUserId(user.id);
  if (!emailAuth) {
    // Google-only account — respond the same as "not found" to avoid leaking info
    await dummyPasswordVerify(password);
    recordEmailLoginFailure(ip);
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  let passwordOk = false;
  try {
    passwordOk = await argon2Verify(emailAuth.password_hash, password);
  } catch (err) {
    console.error('[auth/login/email] argon2 verify failed:', err);
    return res.status(500).json({ error: 'Login failed — please try again' });
  }

  if (!passwordOk) {
    recordEmailLoginFailure(ip);
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  // Credentials valid — check account status
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'suspended' });
  }
  if (user.status === 'pending') {
    return res.status(200).json({ status: 'pending_approval' });
  }

  const token = signJwt({ userId: user.id, status: user.status, isAdmin: !!user.is_admin, type: 'email' });
  return res.json({
    token,
    tosAccepted: user.tos_version === TOS_VERSION,
    user: { name: user.name, email: user.email, status: user.status, isAdmin: !!user.is_admin, usesRemaining: user.uses_remaining ?? null, tosAccepted: user.tos_version === TOS_VERSION, type: 'email' },
  });
});

// ── Admin user management ─────────────────────────────────────────────────────

/** GET /admin/users — list users, optionally filter by status */
app.get('/admin/users', requireAdmin, (req, res) => {
  const VALID_STATUSES = ['pending', 'active', 'suspended'];
  const status = req.query.status ?? null;
  if (status !== null && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }
  const users = getAllUsers(status);
  res.json(users.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    status: u.status,
    isAdmin: !!u.is_admin,
    usesRemaining: u.uses_remaining ?? null,
    tosAccepted: u.tos_version === TOS_VERSION,
    createdAt: u.created_at,
  })));
});

/** PATCH /admin/users/:id — update user status and/or uses remaining */
app.patch('/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const { status, usesRemaining } = req.body ?? {};

  if (status === undefined && usesRemaining === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  // Self-edit: admins can only change their own usesRemaining
  if (id === req.user.userId) {
    if (status !== undefined) {
      return res.status(400).json({ error: 'Cannot modify own status' });
    }
    // Allow usesRemaining self-edit to fall through
  }

  const target = getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Cannot modify other admins
  if (target.is_admin && target.id !== req.user.userId) {
    return res.status(403).json({ error: 'Cannot modify another admin' });
  }

  if (status !== undefined) {
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'status must be active or suspended' });
    }
    updateUserStatus(id, status);
  }

  if (usesRemaining !== undefined) {
    if (usesRemaining !== null) {
      const n = Number(usesRemaining);
      if (!Number.isInteger(n) || n < 0 || n > 999_999) {
        return res.status(400).json({ error: 'usesRemaining must be null or an integer 0–999999' });
      }
      updateUserUses(id, n);
      notifyUserSockets(id, n);
    } else {
      updateUserUses(id, null);
      notifyUserSockets(id, null);
    }
  }

  notifyAdmins('users_changed');
  res.json({ ok: true });
});

/** DELETE /admin/users/:id — erase a user and everything that references them.
 *  This is the GDPR Art. 17 path the Terms of Service promises: the vault keys
 *  and encrypted results go with the account, and since the master key never
 *  reached the server the deletion is irreversible by construction. */
app.delete('/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  // Deleting yourself would revoke the credentials you are acting with, and
  // could remove the last admin. Mirror the PATCH self-edit guard.
  if (id === req.user.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  const target = getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.is_admin) {
    return res.status(403).json({ error: 'Cannot delete another admin' });
  }

  const { deleted } = deleteUserCompletely(id);
  if (!deleted) return res.status(404).json({ error: 'User not found' });

  // Close any live sessions: their JWT still verifies until it expires, and
  // every route behind requireActive would now 403 on a missing user row anyway.
  const sockets = phoneUserSockets.get(id);
  if (sockets) {
    for (const ws of [...sockets]) {
      invalidatePhoneSession(ws, 'account_deleted');
    }
  }

  notifyAdmins('users_changed');
  notifyAdmins('codes_changed'); // codes they created are gone too
  console.log(`[admin] User ${id} deleted by admin ${req.user.userId}.`);
  res.json({ ok: true });
});

// Serve the built Svelte client in production (local dev only — Caddy serves it on VPS).
  const clientDist = process.env.CLIENT_DIST_PATH || join(__dirname, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

// ── Terminal error handler ────────────────────────────────────────────────────
// Must come after every route. Without it Express falls through to finalhandler,
// which renders err.stack into the response body whenever NODE_ENV is not
// 'production' — handing file paths and library versions to anyone who can make
// a handler throw (a malformed JSON body is enough). Log the detail server-side;
// tell the caller only what they need to fix their request.
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  console.error(`[error] ${req.method} ${req.path}: ${err?.message}\n${err?.stack ?? ''}`);
  res.status(500).json({ error: 'Internal error' });
});

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = createServer(app);

// ── WebSocket servers (noServer mode, we route upgrades manually) ─────────────
// maxPayload applies to every socket on this server, authenticated or not, so it
// must stay near the real ceiling (MAX_PAYLOAD_B64) rather than well above it:
// each pre-auth socket can buffer a full frame before its 2–3 s auth timeout
// fires. The pre-auth `once('message')` handlers apply a much smaller cap of
// their own — an auth message is a few hundred bytes.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

/** Upper bound on a pre-auth WebSocket message. An auth frame is ~300 bytes. */
const WS_AUTH_MSG_MAX_BYTES = 8192;

// ── Background timers ─────────────────────────────────────────────────────────
// All long-lived setInterval handles are collected here so server.on('close')
// can clear them; otherwise the Node event loop never quiesces on shutdown.
const backgroundTimers = [];
function schedule(fn, intervalMs) {
  const t = setInterval(fn, intervalMs);
  backgroundTimers.push(t);
  return t;
}
server.on('close', () => {
  for (const t of backgroundTimers) clearInterval(t);
  backgroundTimers.length = 0;
});

// ── Heartbeat — keeps idle connections alive through NAT/firewall/proxy timeouts ─
// 25 s is conservative enough to beat typical 30 s NAT idle timeouts.
const PING_INTERVAL_MS = 25_000;
schedule(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL_MS);

// ── WS upgrade rate limiter ────────────────────────────────────────────────
// Tracks connection attempts per IP to prevent unauthenticated connection
// flooding (especially /ws/pc which holds sockets for 10 s before auth timeout).
const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_MAX = 20; // max upgrade attempts per IP per window
const wsUpgradeTracker = new Map(); // Map<ip, { count, resetAt }>

// Prune stale entries from the WS upgrade tracker every 5 minutes
schedule(() => {
  const now = Date.now();
  for (const [ip, entry] of wsUpgradeTracker) {
    if (now >= entry.resetAt) wsUpgradeTracker.delete(ip);
  }
}, 5 * 60_000);

// Prune the per-user submit rate-limiter map. The Map is keyed by queueUserId
// and was never cleared once seeded, so long-running processes accumulated one
// entry per unique user/code ever seen. Drop expired timestamps every minute
// and remove the entry entirely if no recent submits remain.
schedule(() => {
  const cutoff = Date.now() - WS_SUBMIT_WINDOW_MS;
  for (const [userId, timestamps] of submitRateLimiter) {
    while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
    if (timestamps.length === 0) submitRateLimiter.delete(userId);
  }
}, 60_000);

// Prune code_auth_failures older than 5 minutes every 5 minutes (and at startup)
pruneCodeAuthFailures(5 * 60_000);
schedule(() => pruneCodeAuthFailures(5 * 60_000), 5 * 60_000);

// Prune email_login_failures older than 15 minutes every 5 minutes (and at startup)
pruneEmailLoginFailures(15 * 60_000);
schedule(() => pruneEmailLoginFailures(15 * 60_000), 5 * 60_000);

// Prune job audit log entries older than 6 months once per day — and once at
// startup, because `schedule` is a bare setInterval: a container that is
// recreated on every push to main never reaches the first 24-hour tick, so the
// retention limit docs/PRIVACY.md promises would never actually be enforced.
const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
pruneJobAuditLogsOlderThan(SIX_MONTHS_MS);
schedule(() => pruneJobAuditLogsOlderThan(SIX_MONTHS_MS), 24 * 60 * 60 * 1000);

function getUpgradeIp(req) {
  // Same resolution as the HTTP routes (X-Real-IP, then the right-most
  // X-Forwarded-For hop, only when BEHIND_PROXY=true) — see getClientIp for the
  // reasoning. This address is what lands in job_audit_log.ip_address and keys
  // the per-IP upgrade limiter, so the two must not disagree.
  return getClientIp(req) ?? req.socket.remoteAddress;
}

server.on('upgrade', async (req, socket, head) => {
  // ── Per-IP rate limit for WS upgrades ───────────────────────────────────
  const ip = getUpgradeIp(req);
  const now = Date.now();
  let entry = wsUpgradeTracker.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WS_RATE_WINDOW_MS };
    wsUpgradeTracker.set(ip, entry);
  }
  entry.count++;
  if (entry.count > WS_RATE_MAX) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  // ── CSWSH: Origin header check ───────────────────────────────────────────
  // Only enforced when ALLOWED_ORIGINS is configured (production). In dev mode
  // (no ALLOWED_ORIGINS) the check is skipped to match HTTP CORS behaviour.
  // The /ws/pc endpoint is exempted — it is a native client (no browser Origin).
  const reqOrigin = req.headers.origin;
  if (allowedOrigins.length > 0) {
    const url0 = new URL(req.url, 'http://localhost');
    if (url0.pathname !== '/ws/pc') {
      if (!reqOrigin || !allowedOrigins.includes(reqOrigin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }
  }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/ws/admin') {
    // Token is authenticated via first WebSocket message (type: 'auth'),
    // NOT via a URL query parameter, so JWTs are never written to proxy access logs.
    wss.handleUpgrade(req, socket, head, (ws) => handleAdminSocketPending(ws));
    return;
  }

  if (url.pathname === '/ws/pc') {
    wss.handleUpgrade(req, socket, head, (ws) => handlePcSocket(ws));
    return;
  }

  if (url.pathname === '/ws/phone') {
    // Auth is performed via the first WebSocket message (type: 'auth', token: '...'),
    // NOT via a URL query parameter, so JWTs are never written to proxy access logs.
    wss.handleUpgrade(req, socket, head, (ws) => handlePhoneSocket(ws, ip));
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

// ── PC socket handler ─────────────────────────────────────────────────────────
async function handlePcSocket(ws) {
  console.log('[pc] Connecting — waiting for auth handshake...');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const authTimeout = setTimeout(() => {
    console.warn('[pc] Auth timed out.');
    ws.close(4001, 'Auth timeout');
  }, 3_000);

  ws.once('message', async (raw) => {
    clearTimeout(authTimeout);
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.close(4002, 'Invalid auth message');
      return;
    }

    if (msg.type !== 'auth' || typeof msg.secret !== 'string') {
      ws.close(4002, 'Expected auth message');
      return;
    }

    const ok = verifyPcSecret(msg.secret);
    if (!ok) {
      console.warn('[pc] Wrong secret.');
      ws.close(4003, 'Invalid secret');
      return;
    }

    console.log('[pc] Authenticated.');
    sendJson(ws, { type: 'auth_ok' });

    if (pcSocket && pcSocket.readyState === 1) {
      console.log('[pc] Replacing previous PC socket.');
      pcSocket.close(1000, 'Replaced by new connection');
    }
    pcSocket = ws;
    // Clear the cached key at replacement time, not in the old socket's close
    // handler (which no longer owns pcSocket and so leaves it alone). Otherwise
    // a newly connected PC inherits the previous PC's key until it sends its
    // own `pubkey`, and phones fetching /pc-pubkey in that window encrypt to a
    // key this PC cannot use.
    pcPublicKeyB64 = null;

    // Bind per socket so a replaced-but-not-yet-closed socket cannot act as the
    // PC: its listener stays attached until the close handshake completes.
    ws.on('message', (raw) => handlePcMessage(ws, raw));
    ws.on('close', (code, reason) => {
      console.log(`[pc] Disconnected (code=${code} reason=${String(reason ?? '').slice(0, 64)}).`);
      // Only act if THIS socket is still the active PC. A late close event from
      // a replaced socket must not blow away the new PC's state.
      if (pcSocket === ws) {
        pcSocket = null;
        pcPublicKeyB64 = null;
        // The job the PC was working on would otherwise stay 'processing'
        // forever: dispatchNextJob() short-circuits on getActiveJob(), and
        // non-terminal jobs are only collected by the 6-hour orphan prune, so
        // the whole queue would stall. Put it back in the queue instead — the
        // payload is still held, so it redispatches as soon as the PC returns.
        // No quota refund here: the job has not failed, it is waiting again.
        const active = getActiveJob();
        if (active) {
          updateJobStatus(active.id, 'pending');
          console.warn(`[pc] Job ${active.id} was processing — reset to pending for redispatch.`);
        }
        broadcastQueueUpdate();
      }
    });

    // Dispatch any pending jobs now that PC is connected
    dispatchNextJob();
  });
}

function handlePcMessage(ws, raw) {
  // A socket that has been replaced stays readable until its close handshake
  // completes, and its listener is still attached. Anything it says now is
  // stale: results from it would be treated as authoritative, and a bad pubkey
  // from it used to close the new, legitimate connection.
  if (ws !== pcSocket) return;

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.warn('[pc] Invalid JSON, ignoring.');
    return;
  }

  if (msg.type === 'pubkey') {
    if (PC_KEY_FINGERPRINT) {
      let keyBytes;
      try {
        keyBytes = Buffer.from(msg.publicKey ?? '', 'base64');
      } catch {
        console.warn('[pc] pubkey message has invalid base64 — rejecting.');
        // Close and let the close handler clear pcSocket / pcPublicKeyB64 and
        // requeue anything already dispatched. Clearing pcSocket here instead
        // would make that handler's `pcSocket === ws` guard fail and strand the
        // job. Nothing can be dispatched meanwhile: close() moves the socket out
        // of readyState OPEN, which every send path already checks.
        ws.close(4003, 'Invalid public key');
        return;
      }
      const incoming = createHash('sha256').update(keyBytes).digest();
      // Length check first: timingSafeEqual throws on a mismatch, and a throw
      // inside a ws listener takes the whole process down.
      if (incoming.length !== PC_KEY_FINGERPRINT.length || !timingSafeEqual(incoming, PC_KEY_FINGERPRINT)) {
        console.warn('[pc] Public key fingerprint mismatch — rejecting connection.');
        ws.close(4003, 'Public key fingerprint mismatch');
        return;
      }
    }
    pcPublicKeyB64 = msg.publicKey;
    console.log('[pc] Public key cached.');
    return;
  }

  if (msg.type === 'progress') {
    // Validate numeric fields before forwarding — a compromised PC could push
    // NaN, Infinity, or strings that would corrupt client state. max must be
    // strictly positive (clients divide by it) and value must not exceed it.
    const value = Number(msg.value);
    const max   = Number(msg.max);
    if (!Number.isFinite(value) || !Number.isFinite(max)) return;
    if (max <= 0 || value < 0 || value > max) return;
    if (typeof msg.jobId !== 'string' || !msg.jobId) return;
    const job = getJob(msg.jobId);
    if (!job || job.status !== 'processing') return;
    updateJobProgress(msg.jobId, value, max, msg.node ?? null);
    // Owner socket gets full detail (jobId + node) to drive its specific progress bar.
    // All other sockets receive only value/max — enough to show a generic activity
    // indicator without exposing the foreign job identifier.
    const ownerPayload  = { type: 'progress', jobId: msg.jobId, value, max, node: msg.node ?? null };
    const publicPayload = { type: 'progress', value, max };
    for (const [ws] of allPhoneSockets) {
      if (ws.readyState !== 1) continue;
      sendJson(ws, ws === job?.phoneWs ? ownerPayload : publicPayload);
    }
    return;
  }

  if (msg.type === 'result') {
    const job = getJob(msg.jobId);
    if (!job) {
      // PC-controlled strings are truncated everywhere they are logged: the
      // frame cap is tens of megabytes and log volume is disk pressure on the
      // VPS. The phone handler already defends against exactly this.
      console.warn(`[pc] Result for unknown job ${String(msg.jobId).slice(0, 64)}`);
      return;
    }
    if (job.status === 'cancelled') {
      console.log(`[pc] Ignoring result for cancelled job ${String(msg.jobId).slice(0, 64)}`);
      deleteJob(msg.jobId);
      dispatchNextJob();
      broadcastQueueUpdate();
      return;
    }

    // ── Relay the encrypted thumbnail to the browser ─────────────────────────
    // The thumbnail is ciphertext under the per-job result key — encrypted
    // end-to-end on the PC and decrypted only in the browser, which re-wraps it
    // with the vault master key before uploading it in POST /results. The relay
    // never sees it in plaintext, so there is no format to check and nothing to
    // learn from decoding it: enforce the base64 charset and the size cap, then
    // pass the string through untouched.
    let relayedThumbnail = undefined;
    if (
      typeof msg.thumbnail === 'string' &&
      msg.thumbnail.length > 0 &&
      msg.thumbnail.length <= THUMB_MAX_B64_LEN &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(msg.thumbnail)
    ) {
      relayedThumbnail = msg.thumbnail; // relay as-is (already valid base64)
      console.log(`[pc] Encrypted thumbnail accepted for job ${String(msg.jobId).slice(0, 64)} (${msg.thumbnail.length} b64 chars) — relaying to browser.`);
    }

    // The dispatched payload is no longer needed — this job will not be
    // redispatched. Release it before the job object lingers for replay.
    job.payload = null;
    completeJob(msg.jobId, msg.payload, relayedThumbnail);
    const relayMsg = { type: 'result', jobId: msg.jobId, payload: msg.payload };
    if (relayedThumbnail !== undefined) relayMsg.thumbnail = relayedThumbnail;
    // Wait for the socket to actually accept the bytes before deleting the
    // job. If the connection drops before the buffered send flushes, leave
    // the job in 'done' state so the replay-on-reconnect path can resend.
    const jobIdForDelete = msg.jobId;
    sendJsonAck(job.phoneWs, relayMsg, (delivered) => {
      if (delivered) deleteJob(jobIdForDelete);
    });
    console.log(`[pc] Job ${String(msg.jobId).slice(0, 64)} completed.`);
    // Dispatch next
    dispatchNextJob();
    broadcastQueueUpdate();
    return;
  }

  if (msg.type === 'error') {
    const job = getJob(msg.jobId);
    if (job) {
      updateJobStatus(msg.jobId, 'error');
      // Terminal: release the dispatched payload and give back the quota use
      // charged at submit, since this job produced nothing.
      job.payload = null;
      refundJobQuota(job);
      if (job.phoneWs?.readyState === 1) {
        // Never forward raw PC error messages to clients — they may contain
        // Python tracebacks, file paths, or library version info.
        sendJson(job.phoneWs, { type: 'error', jobId: msg.jobId, message: 'Processing failed' });
      }
      deleteJob(msg.jobId);
    }
    // Full error detail is logged server-side only, truncated — both fields are
    // PC-controlled and unbounded on the wire.
    console.warn(`[pc] Error for job ${String(msg.jobId).slice(0, 64)}: ${String(msg.message).slice(0, 64)}`);
    // Dispatch next job after error
    dispatchNextJob();
    broadcastQueueUpdate();
    return;
  }

  console.warn(`[pc] Unhandled message type: ${String(msg.type).slice(0, 64)}`);
}

// ── Phone socket handler ──────────────────────────────────────────────────────
function handlePhoneSocket(ws, clientIp) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Require { type: 'auth', token } as the first message within 2 s.
  // This keeps JWTs out of URL query strings (and therefore out of proxy logs).
  const PHONE_AUTH_TIMEOUT_MS = 2_000;
  const authTimeout = setTimeout(() => {
    ws.close(4001, 'Auth timeout');
  }, PHONE_AUTH_TIMEOUT_MS);

  ws.once('message', (raw) => {
    clearTimeout(authTimeout);
    // Bound the pre-auth frame before parsing it: maxPayload lets an
    // unauthenticated socket buffer tens of megabytes, and the upgrade limiter
    // allows 20 of those per IP per minute.
    if (raw.length > WS_AUTH_MSG_MAX_BYTES) {
      ws.close(4000, 'Auth message too large');
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      ws.close(4002, 'Invalid auth message');
      return;
    }
    if (msg.type !== 'auth' || typeof msg.token !== 'string') {
      ws.close(4002, 'Expected auth message');
      return;
    }

    const payload = verifyJwt(msg.token);
    if (!payload) {
      sendJson(ws, { type: 'auth_failed', reason: 'invalid_token' });
      ws.close(4003, 'Invalid token');
      return;
    }

    if (payload.type === 'code_user') {
      // Re-check DB state (mirrors requireActiveOrCode behaviour)
      if (!ACCESS_CODES_ENABLED) {
        sendJson(ws, { type: 'auth_failed', reason: 'codes_disabled' });
        ws.close(4003, 'Access codes disabled');
        return;
      }
      const code = findInviteCodeById(payload.codeId);
      if (!code) {
        sendJson(ws, { type: 'auth_failed', reason: 'code_not_found' });
        ws.close(4003, 'Access code not found');
        return;
      }
      if (code.expires_at !== null && Date.now() > code.expires_at) {
        sendJson(ws, { type: 'auth_failed', reason: 'code_expired' });
        ws.close(4003, 'Access code expired');
        return;
      }
      if (code.uses_remaining !== null && code.uses_remaining <= 0) {
        sendJson(ws, { type: 'auth_failed', reason: 'code_exhausted' });
        ws.close(4003, 'Access code exhausted');
        return;
      }
    } else {
      const user = getUserById(payload.userId);
      if (!user || user.status !== 'active') {
        sendJson(ws, { type: 'auth_failed', reason: 'account_not_active' });
        ws.close(4003, 'Account not active');
        return;
      }
    }

    sendJson(ws, { type: 'auth_ok' });
    handlePhoneSocketAuthenticated(ws, payload, msg.token, clientIp);
  });
}

function handlePhoneSocketAuthenticated(ws, jwtPayload, rawToken, clientIp) {
  console.log(`[phone] Connected (${jwtPayload.type === 'code_user' ? 'code' : 'google'}).`);

  // Stable userId for quota accounting (shared per code)
  const queueUserId = jwtPayload.type === 'code_user'
    ? `code:${jwtPayload.codeId}`
    : `user:${jwtPayload.userId}`;

  // Per-connection session ID: used to scope cancel authorization so one
  // code-user cannot cancel another code-user's job sharing the same codeId.
  const wsSessionId = uuidv4();

  // Register in all tracking maps
  registerPhoneSocket(ws, queueUserId, wsSessionId);

  if (jwtPayload.type === 'code_user') {
    registerCodeSocket(jwtPayload.codeId, ws);
    // Send initial code status so the client can show a warning immediately
    const codeRow = findInviteCodeById(jwtPayload.codeId);
    if (codeRow) sendJson(ws, { type: 'code_status', usesRemaining: codeRow.uses_remaining });
  } else if (jwtPayload.userId) {
    registerUserSocket(jwtPayload.userId, ws);
    // Send initial uses status so the client reflects current quota immediately
    const userRow = getUserById(jwtPayload.userId);
    if (userRow) sendJson(ws, { type: 'uses_updated', usesRemaining: userRow.uses_remaining ?? null });
  }

  // Send initial queue state
  const recovered = [];
  // Job recovery and result replay are intentionally skipped for code users.
  // Multiple sessions can share the same code (and therefore the same queueUserId),
  // so re-binding pending/completed jobs on reconnect would allow one session to
  // cancel or consume another session's work.  Google/email users each have a
  // unique userId so cross-session interference cannot occur for them.
  if (jwtPayload.type !== 'code_user') {
    const recoverableJobs = getRecoverableJobsByUserId(queueUserId);
    for (const job of recoverableJobs) {
      if (job.ownerSessionId && job.ownerSessionId !== wsSessionId && isSessionOnline(job.ownerSessionId)) {
        continue;
      }
      if (reclaimJob(job.id, ws, wsSessionId)) {
        const snap = getJobSnapshot(job.id);
        if (snap) recovered.push(snap);
      }
    }
  }

  const pub = getPublicQueueState();
  const own = getOwnerQueueState(wsSessionId);
  sendJson(ws, { type: 'queue_update', ...pub, ...own, maxQueuePerUser: MAX_QUEUE_PER_USER });
  if (recovered.length > 0) {
    sendJson(ws, { type: 'job_recovery', jobs: recovered });
  }

  // Replay completed results that finished while the owner was offline.
  if (jwtPayload.type !== 'code_user') {
    const completed = getCompletedJobsByUserId(queueUserId);
    for (const job of completed) {
      // Same guard the recovery loop above uses: without it a user's second tab
      // drains and deletes results the first tab is still waiting for, and the
      // result looks lost. Leave the job for the session that owns it while that
      // session is still online.
      if (job.ownerSessionId && job.ownerSessionId !== wsSessionId && isSessionOnline(job.ownerSessionId)) {
        continue;
      }
      const payload = Buffer.isBuffer(job.encryptedResult)
        ? job.encryptedResult.toString('base64')
        : String(job.encryptedResult ?? '');
      if (!payload) {
        deleteJob(job.id);
        continue;
      }
      const replayMsg = { type: 'result', jobId: job.id, payload };
      if (job.thumbnail) replayMsg.thumbnail = job.thumbnail;
      const delivered = sendJson(ws, replayMsg);
      if (!delivered) break;
      deleteJob(job.id);
    }
  }

  // ── Periodic re-validation: close socket if user is no longer active ────────
  const WS_REVALIDATE_MS = 60_000; // 1 minute
  const revalidateTimer = setInterval(() => {
    const reason = getSessionInvalidReason(jwtPayload, rawToken);
    if (reason) {
      invalidatePhoneSession(ws, reason);
    }
  }, WS_REVALIDATE_MS);

  // ── Submit rate limiting is handled per-user via module-level submitRateLimiter ──

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (typeof msg.type !== 'string') {
      sendJson(ws, { type: 'error', message: 'Missing message type' });
      return;
    }

    if (msg.type === 'ping') {
      sendJson(ws, { type: 'pong' });
    } else if (msg.type === 'submit') {
      const reason = getSessionInvalidReason(jwtPayload, rawToken);
      if (reason) {
        invalidatePhoneSession(ws, reason);
        return;
      }
      // Rate limit submits (per-user, persists across reconnects)
      const now = Date.now();
      let timestamps = submitRateLimiter.get(queueUserId);
      if (!timestamps) { timestamps = []; submitRateLimiter.set(queueUserId, timestamps); }
      while (timestamps.length && timestamps[0] <= now - WS_SUBMIT_WINDOW_MS) timestamps.shift();
      if (timestamps.length >= WS_SUBMIT_MAX) {
        sendJson(ws, { type: 'error', message: 'Rate limit exceeded — try again later' });
        return;
      }
      timestamps.push(now);
      handleJobSubmit(ws, msg, jwtPayload, queueUserId, wsSessionId, clientIp);
    } else if (msg.type === 'cancel') {
      const reason = getSessionInvalidReason(jwtPayload, rawToken);
      if (reason) {
        invalidatePhoneSession(ws, reason);
        return;
      }
      // Validate jobId length to prevent oversized strings probing internal state
      if (typeof msg.jobId === 'string' && msg.jobId && msg.jobId.length <= 64) {
        const job = getJob(msg.jobId);
        // Authorize by per-WS session ID, not by shared queueUserId, to prevent
        // one code-user from cancelling another user's job on the same code.
        if (job && job.ownerSessionId === wsSessionId) {
          const wasProcessing = job.status === 'processing';
          const wasPending = job.status === 'pending';
          if (wasProcessing || wasPending) {
            // Terminal for this job either way: release the payload and give
            // back the quota use charged at submit. refundJobQuota is idempotent,
            // so a late `error` from the PC for a cancelled job cannot pay twice.
            job.payload = null;
            refundJobQuota(job);
          }
          if (wasProcessing) {
            updateJobStatus(msg.jobId, 'cancelled');
            if (pcSocket && pcSocket.readyState === 1) {
              sendJson(pcSocket, { type: 'cancel', jobId: msg.jobId });
            }
            // If cancelled a processing job, dispatch next
            dispatchNextJob();
          } else {
            // Pending job: remove immediately to free memory
            deleteJob(msg.jobId);
          }
          broadcastQueueUpdate();
        }
      }
    } else {
      // Do NOT echo msg.type back — an attacker could send a large string to
      // inflate log output or probe error serialisation.
      sendJson(ws, { type: 'error', message: 'Unknown message type' });
    }
  });

  ws.on('close', () => {
    clearInterval(revalidateTimer);
    unregisterPhoneSocket(ws);
    if (jwtPayload.type === 'code_user') {
      unregisterCodeSocket(jwtPayload.codeId, ws);
    } else if (jwtPayload.userId) {
      unregisterUserSocket(jwtPayload.userId, ws);
    }
    console.log('[phone] Disconnected.');
  });
}

function handleJobSubmit(phoneWs, msg, jwtPayload, queueUserId, wsSessionId, clientIp) {
  if (!jwtPayload || !queueUserId) {
    console.error('[BUG] handleJobSubmit called without required params');
    sendJson(phoneWs, { type: 'error', message: 'Internal error' });
    return;
  }

  if (!pcSocket || pcSocket.readyState !== 1) {
    sendJson(phoneWs, { type: 'no_pc' });
    return;
  }

  if (typeof msg.payload !== 'string') {
    sendJson(phoneWs, { type: 'error', message: 'Missing payload' });
    return;
  }

  // ── Payload size guard — reject blobs that exceed the documented max ─────────
  if (msg.payload.length > MAX_PAYLOAD_B64) {
    sendJson(phoneWs, { type: 'error', message: 'Payload too large' });
    return;
  }

  // ── Per-user queue limit ─────────────────────────────────────────────────────
  if (queueUserId && getUserJobCount(queueUserId) >= MAX_QUEUE_PER_USER) {
    sendJson(phoneWs, { type: 'error', message: 'queue_full' });
    return;
  }

  // ── Global queue depth cap — prevents identity-farming floods ─────────────────
  if (getTotalActiveJobCount() >= MAX_TOTAL_QUEUE_DEPTH) {
    sendJson(phoneWs, { type: 'error', message: 'Server queue is full — try again later' });
    return;
  }

  // ── Deduplication: reject identical payloads submitted within 10 s on the same socket ──
  const payloadHash = createHash('sha256').update(msg.payload).digest('hex');
  const now = Date.now();
  if (!phoneWs._lastSubmit) phoneWs._lastSubmit = { hash: null, at: 0 };
  if (phoneWs._lastSubmit.hash === payloadHash && now - phoneWs._lastSubmit.at < 10_000) {
    console.warn('[relay] Duplicate submit detected — ignoring.');
    return;
  }
  phoneWs._lastSubmit = { hash: payloadHash, at: now };

  // ── Google user quota check ────────────────────────────────────────────────────
  // Capture identity fields here so the audit log can reference them after createJob.
  let _auditGoogleSub = null;
  let _auditEmail = null;
  let _auditUserId = null;
  if (jwtPayload?.type !== 'code_user' && jwtPayload?.userId) {
    const userRow = getUserById(jwtPayload.userId);
    if (!userRow) {
      sendJson(phoneWs, { type: 'error', message: 'User not found' });
      return;
    }
    // ── Suspended check — catches users suspended while their WS was open ─────
    if (userRow.status !== 'active') {
      sendJson(phoneWs, { type: 'error', message: 'account_suspended' });
      return;
    }
    // ── Terms of Service gate ──────────────────────────────────────────────────
    if (userRow.tos_version !== TOS_VERSION) {
      sendJson(phoneWs, { type: 'error', message: 'tos_not_accepted' });
      return;
    }
    if (userRow.uses_remaining !== null) {
      // Finite quota — atomic decrement (prevents TOCTOU race across tabs/sockets)
      const result = atomicDecrementUserUses(jwtPayload.userId);
      if (result.changes === 0) {
        // Already at 0 — reject
        sendJson(phoneWs, { type: 'error', message: 'no_uses_remaining' });
        return;
      }
      // Refetch to get the new value for notifications
      const updated = getUserById(jwtPayload.userId);
      const newRemaining = updated?.uses_remaining ?? 0;
      notifyAdmins('users_changed');
      notifyUserSockets(jwtPayload.userId, newRemaining);
    }
    // null = unlimited — proceed without decrement
    _auditUserId = userRow.id;
    _auditGoogleSub = userRow.google_sub;
    _auditEmail = userRow.email;
  }

  if (jwtPayload?.type === 'code_user') {
    const codeRow = findInviteCodeById(jwtPayload.codeId);
    if (!codeRow) {
      sendJson(phoneWs, { type: 'error', message: 'Access code not found' });
      return;
    }
    if (codeRow.expires_at !== null && Date.now() > codeRow.expires_at) {
      sendJson(phoneWs, { type: 'error', message: 'Access code expired' });
      return;
    }
    if (codeRow.uses_remaining !== null) {
      const result = atomicDecrementCodeUses(codeRow.id);
      if (result.changes === 0) {
        sendJson(phoneWs, { type: 'error', message: 'Access code has no remaining uses' });
        return;
      }
      notifyAdmins('codes_changed');
      // Re-read after atomic decrement so we send the authoritative value,
      // not a stale pre-decrement calculation (same pattern used for Google users above).
      const updatedCode = findInviteCodeById(jwtPayload.codeId);
      notifyCodeUsers(jwtPayload.codeId, updatedCode?.uses_remaining ?? 0);
    }
  }

  const jobId = uuidv4();
  createJob(jobId, phoneWs, queueUserId, wsSessionId, msg.payload);

  // ── Compliance audit log — records identity + IP + timestamp for every job ──
  // NO image blobs or encrypted payload are stored; only identity metadata.
  try {
    createJobAuditLog({
      jobId,
      userType: jwtPayload?.type === 'code_user' ? 'code'
              : jwtPayload?.type === 'email'     ? 'email'
              : 'google',
      userId: _auditUserId,
      googleSub: _auditGoogleSub,
      email: _auditEmail,
      codeId: jwtPayload?.type === 'code_user' ? (jwtPayload.codeId ?? null) : null,
      ipAddress: clientIp ?? 'unknown',
    });
  } catch (err) {
    // Audit log failure must never block job creation
    console.error('[audit] Failed to write job audit log:', err.message);
  }

  // Echo back the client-supplied clientToken (if any) so multiple in-flight
  // submits on the same socket can be matched to their own `queued` ack.
  // Without this, a one-shot 'queued' listener registered for submit B would
  // fire on the 'queued' for submit A and bind B's AES key to A's jobId.
  const ack = { type: 'queued', jobId };
  if (typeof msg.clientToken === 'string' && msg.clientToken.length > 0 && msg.clientToken.length <= 64) {
    ack.clientToken = msg.clientToken;
  }
  sendJson(phoneWs, ack);
  console.log(`[queue] Job ${jobId} added to queue.`);

  // Try to dispatch immediately if nothing is processing
  dispatchNextJob();
  broadcastQueueUpdate();
}

// ── Admin socket handler ────────────────────────────────────────────────────────────
function handleAdminSocketPending(ws) {
  const authTimeout = setTimeout(() => ws.close(4001, 'Auth timeout'), 3_000);
  const cancelTimeout = () => clearTimeout(authTimeout);
  ws.once('close', cancelTimeout);
  ws.once('error', cancelTimeout);
  ws.once('message', (raw) => {
    cancelTimeout();
    ws.removeListener('close', cancelTimeout);
    // Bound the pre-auth frame before parsing it — see handlePhoneSocket.
    if (raw.length > WS_AUTH_MSG_MAX_BYTES) { ws.close(4000, 'Auth message too large'); return; }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { ws.close(4002, 'Invalid auth'); return; }
    if (msg.type !== 'auth' || typeof msg.token !== 'string') { ws.close(4002, 'Expected auth'); return; }
    const payload = verifyJwt(msg.token);
    if (!payload) { sendJson(ws, { type: 'auth_failed' }); ws.close(4003, 'Invalid token'); return; }
    // Status is checked alongside is_admin to match requireAdmin on the HTTP
    // side — without it a suspended admin stayed connected until the 5-minute
    // revalidation timer noticed.
    const adminUser = getUserById(payload.userId);
    if (!adminUser || !adminUser.is_admin || adminUser.status !== 'active') { sendJson(ws, { type: 'auth_failed' }); ws.close(4003, 'Not admin'); return; }
    sendJson(ws, { type: 'auth_ok' });
    handleAdminSocket(ws, adminUser.id);
  });
}

function handleAdminSocket(ws, userId) {
  console.log(`[admin-ws] Connected (user ${userId}).`);
  adminSockets.set(ws, userId);

  // No initial refresh push — the client loads data on mount via HTTP.
  // WS is used only for real-time change notifications after initial load.

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Periodic re-validation: close if admin is suspended or demoted ────────
  const revalidateTimer = setInterval(() => {
    const user = getUserById(userId);
    if (!user || user.status !== 'active' || !user.is_admin) {
      ws.close(4003, 'No longer admin');
    }
  }, 5 * 60_000);

  ws.on('close', () => {
    clearInterval(revalidateTimer);
    adminSockets.delete(ws);
    console.log(`[admin-ws] Disconnected (user ${userId}).`);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
initAuth();

// Prune stale jobs every 10 minutes
schedule(() => pruneOldJobs(30 * 60 * 1000), 10 * 60 * 1000);

// Prune expired revoked-token entries every 60 minutes (and once at startup)
pruneRevokedTokens();
schedule(() => pruneRevokedTokens(), 60 * 60 * 1000);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
