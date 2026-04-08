import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import {
  initAuth,
  verifyGoogleToken,
  signJwt,
  verifyJwt,
  verifyPcSecret,
  requireActive,
  requireAdmin,
  requireActiveOrCode,
} from './auth.js'; // authentication & authorization middleware
import {
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
  deleteStoredResult,
  countStoredResults,
  getAllUsers,
  updateUserStatus,
  updateUserUses,
  atomicDecrementUserUses,
  updateTosAccepted,
  recordCodeAuthFailure,
  getRecentCodeAuthFailureCount,
  pruneCodeAuthFailures,
  insertRevokedToken,
  pruneRevokedTokens,
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
// Maximum encrypted payload size (base64 chars). Two 15 MB images ≈ 40 MB base64;
// 100 MB gives ample headroom while blocking obviously over-sized blobs.
const MAX_PAYLOAD_B64 = 100 * 1024 * 1024;
const MAX_RESULTS_PER_USER = parseInt(process.env.MAX_RESULTS_PER_USER ?? '500', 10);

// ── Per-user submit rate limiter (persists across reconnects) ─────────────────
const WS_SUBMIT_WINDOW_MS = 60_000;
const WS_SUBMIT_MAX = 10;
const submitRateLimiter = new Map(); // Map<queueUserId, number[]>

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── PC relay state ────────────────────────────────────────────────────────────
let pcSocket = null;
let pcPublicKeyB64 = null;

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
  phoneCodeSockets.get(codeId)?.delete(ws);
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
  phoneUserSockets.get(userId)?.delete(ws);
}

function notifyUserSockets(userId, usesRemaining) {
  const sockets = phoneUserSockets.get(userId);
  if (!sockets) return;
  for (const ws of sockets) {
    sendJson(ws, { type: 'uses_updated', usesRemaining });
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

function getSessionInvalidReason(jwtPayload, rawToken) {
  const verified = verifyJwt(rawToken);
  if (!verified) return 'token_expired';

  if (jwtPayload.type === 'code_user') {
    const code = findInviteCodeById(jwtPayload.codeId);
    if (!code) return 'code_not_found';
    if (code.expires_at !== null && Date.now() > code.expires_at) return 'code_expired';
    if (code.uses_remaining !== null && code.uses_remaining <= 0) return 'code_exhausted';
    return null;
  }

  const user = getUserById(jwtPayload.userId);
  if (!user || user.status !== 'active') return 'account_suspended';
  if (user.uses_remaining !== null && user.uses_remaining <= 0) return 'no_uses_remaining';
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

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : undefined; // undefined = allow all in dev
if (!allowedOrigins && process.env.DEPLOY_MODE === 'remote') {
  console.warn('[security] WARNING: ALLOWED_ORIGINS is not set in remote mode — CORS allows all origins.');
}
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : undefined));
app.use(express.json({ limit: '20mb' }));

// Rate limiting
// Auth endpoints: 30 req/min per IP — generous enough for normal interactive login
// (Google's Sign-In widget can fire multiple XHRs on retry/page-reload) but still
// blocks automated stuffing. Auth routes are SKIPPED in apiLimiter to avoid
// double-counting the same request against two buckets.
const authLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests — try again later' } });
const apiLimiter  = rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false, skip: (req) => req.path.startsWith('/auth/'), message: { error: 'Too many requests — try again later' } });
app.use('/auth/', authLimiter);
app.use(apiLimiter);

/** POST /auth/google — exchange a Google ID token (+ optional invite code) for a JWT */
app.post('/auth/google', async (req, res) => {
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
    });
    return res.json({
      token,
      tosAccepted: (existing.tos_version ?? 0) >= TOS_VERSION,
      user: { name: existing.name, email: existing.email, status: existing.status, isAdmin: !!existing.is_admin, usesRemaining: existing.uses_remaining ?? null, tosAccepted: (existing.tos_version ?? 0) >= TOS_VERSION },
    });
  }

  // ── New user with invite code ─────────────────────────────────────────────
  if (inviteCode) {
    const code = validateInviteCode(inviteCode, 'registration');
    if (!code) {
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }
    const codeResult = atomicDecrementCodeUses(code.id);
    if (codeResult.changes === 0) {
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }
    const user = createUser({
      googleSub: googleUser.sub,
      email: googleUser.email,
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
    });
    return res.json({
      token,
      tosAccepted: false,
      user: { name: user.name, email: user.email, status: user.status, isAdmin: !!user.is_admin, usesRemaining: user.uses_remaining ?? null, tosAccepted: false },
    });
  }

  // ── New user without invite code → pending ────────────────────────────────
  createUser({
    googleSub: googleUser.sub,
    email: googleUser.email,
    name: googleUser.name,
    picture: googleUser.picture,
    status: 'pending',
  });  notifyAdmins('users_changed');  return res.status(200).json({ status: 'pending_approval', isNew: true });
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
    tosAccepted: (user.tos_version ?? 0) >= TOS_VERSION,
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

/** PATCH /codes/:id — edit uses_remaining and/or expires_at of an existing code */
app.patch('/codes/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const { usesRemaining, expiresInHours } = req.body ?? {};

  let usesNormalized = null;
  let expiresInHoursNormalized = null;

  if (usesRemaining !== undefined && usesRemaining !== null) {
    const n = parseInt(usesRemaining, 10);
    if (isNaN(n) || n < 0) return res.status(400).json({ error: 'usesRemaining must be a non-negative integer or null' });
    usesNormalized = n;
  }
  if (expiresInHours !== undefined && expiresInHours !== null) {
    const n = parseFloat(expiresInHours);
    if (isNaN(n) || n <= 0 || n > 87_600) return res.status(400).json({ error: 'expiresInHours must be a positive number and at most 87600' });
    expiresInHoursNormalized = n;
  }

  const expiresAt = expiresInHoursNormalized !== null ? Date.now() + expiresInHoursNormalized * 3600_000 : null;
  const uses = usesNormalized !== null ? usesNormalized : null;

  const result = updateInviteCode(id, req.user.userId, { usesRemaining: uses, expiresAt });
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  notifyAdmins('codes_changed');
  // Push updated status to any connected code-users for this code
  notifyCodeUsers(id, uses);
  res.json({ ok: true });
});

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

/** POST /vault/rekey — re-wrap master key with new wrapping keys */
app.post('/vault/rekey', requireActive, async (req, res) => {
  const userId = req.user.userId;
  const existing = getVaultByUser(userId);
  if (!existing) return res.status(404).json({ error: 'No vault configured' });

  // ── Step-up auth: require a fresh Google ID token to prove identity ────────
  const { idToken } = req.body ?? {};
  if (!idToken) return res.status(400).json({ error: 'Re-authentication required (idToken)' });
  try {
    const googleUser = await verifyGoogleToken(idToken);
    const user = getUserById(userId);
    if (!user || user.google_sub !== googleUser.sub) {
      return res.status(403).json({ error: 'Re-authentication failed' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid Google token' });
  }

  const {
    encryptedMasterKeyBio, encryptedMasterKeyPw, encryptedMasterKeyRecovery,
    prfSalt, pbkdf2Salt, prfCredentialId, prfPublicKey,
  } = req.body ?? {};

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

  // ── Step-up auth: require a fresh Google ID token to prove identity ────────
  const { idToken } = req.body ?? {};
  if (!idToken) return res.status(400).json({ error: 'Re-authentication required (idToken)' });
  try {
    const googleUser = await verifyGoogleToken(idToken);
    const user = getUserById(req.user.userId);
    if (!user || user.google_sub !== googleUser.sub) {
      return res.status(403).json({ error: 'Re-authentication failed' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid Google token' });
  }

  deleteVault(req.user.userId);
  res.json({ ok: true });
});

// ── Stored results ────────────────────────────────────────────────────────────

/** POST /results — store encrypted thumb + full blobs */
app.post('/results', requireActive, express.json({ limit: '25mb' }), (req, res) => {
  const { encryptedThumb, encryptedFull, ivThumb, ivFull, fullSizeBytes } = req.body ?? {};

  if (!encryptedThumb || !encryptedFull || !ivThumb || !ivFull) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // ── Per-user storage quota ──────────────────────────────────────────────────
  if (countStoredResults(req.user.userId) >= MAX_RESULTS_PER_USER) {
    return res.status(429).json({ error: `Storage limit reached (max ${MAX_RESULTS_PER_USER} results)` });
  }

  if (typeof encryptedFull !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encryptedFull)) {
    return res.status(400).json({ error: 'Invalid base64 encoding' });
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

  const result = createStoredResult(req.user.userId, {
    encryptedThumb: Buffer.from(encryptedThumb, 'base64'),
    encryptedFull: fullBuf,
    ivThumb: Buffer.from(ivThumb, 'base64'),
    ivFull: Buffer.from(ivFull, 'base64'),
    fullSizeBytes: sanitizedFullSizeBytes,
  });

  res.json(result);
});

/** GET /results — paginated list with thumbs (no full images) */
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
    encryptedThumb: r.encrypted_thumb.toString('base64'),
    ivThumb: r.iv_thumb.toString('base64'),
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
  const { code } = req.body ?? {};
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'code required' });
  }

  // Global brute-force guard: if the system has seen ≥100 failures in the last
  // 60 s across all IPs, stop accepting guesses entirely.
  const CODE_BF_WINDOW_MS = 60_000;
  const CODE_BF_MAX = 100;
  if (getRecentCodeAuthFailureCount(CODE_BF_WINDOW_MS) >= CODE_BF_MAX) {
    return res.status(429).json({ error: 'Too many failed attempts — try again later' });
  }

  const row = validateInviteCode(code.trim().toUpperCase(), 'job_access');
  if (!row) {
    recordCodeAuthFailure();
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
    tosAccepted: (u.tos_version ?? 0) >= TOS_VERSION,
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

// Serve the built Svelte client in production (local dev only — Caddy serves it on VPS).
  const clientDist = process.env.CLIENT_DIST_PATH || join(__dirname, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = createServer(app);

// ── WebSocket servers (noServer mode, we route upgrades manually) ─────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 });

// ── Heartbeat — keeps idle connections alive through NAT/firewall/proxy timeouts ─
// 25 s is conservative enough to beat typical 30 s NAT idle timeouts.
const PING_INTERVAL_MS = 25_000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL_MS);
server.on('close', () => clearInterval(heartbeatTimer));

// ── WS upgrade rate limiter ────────────────────────────────────────────────
// Tracks connection attempts per IP to prevent unauthenticated connection
// flooding (especially /ws/pc which holds sockets for 10 s before auth timeout).
const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_MAX = 20; // max upgrade attempts per IP per window
const wsUpgradeTracker = new Map(); // Map<ip, { count, resetAt }>

// Prune stale entries from the WS upgrade tracker every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of wsUpgradeTracker) {
    if (now >= entry.resetAt) wsUpgradeTracker.delete(ip);
  }
}, 5 * 60_000);

// Prune code_auth_failures older than 5 minutes every 5 minutes
setInterval(() => pruneCodeAuthFailures(5 * 60_000), 5 * 60_000);

function getUpgradeIp(req) {
  // When behind a reverse proxy, trust the first X-Forwarded-For hop.
  // Otherwise use the raw socket address (matches trust proxy conditional below).
  if (process.env.BEHIND_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress;
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
  if (allowedOrigins) {
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
    const token = url.searchParams.get('token');
    const payload = verifyJwt(token);
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const adminUser = getUserById(payload.userId);
    if (!adminUser || !adminUser.is_admin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleAdminSocket(ws, adminUser.id));
    return;
  }

  if (url.pathname === '/ws/pc') {
    wss.handleUpgrade(req, socket, head, (ws) => handlePcSocket(ws));
    return;
  }

  if (url.pathname === '/ws/phone') {
    // Auth is performed via the first WebSocket message (type: 'auth', token: '...'),
    // NOT via a URL query parameter, so JWTs are never written to proxy access logs.
    wss.handleUpgrade(req, socket, head, (ws) => handlePhoneSocket(ws));
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

    ws.on('message', handlePcMessage);
    ws.on('close', () => {
      console.log('[pc] Disconnected.');
      if (pcSocket === ws) pcSocket = null;
    });

    // Dispatch any pending jobs now that PC is connected
    dispatchNextJob();
  });
}

function handlePcMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.warn('[pc] Invalid JSON, ignoring.');
    return;
  }

  if (msg.type === 'pubkey') {
    pcPublicKeyB64 = msg.publicKey;
    console.log('[pc] Public key cached.');
    return;
  }

  if (msg.type === 'progress') {
    // Validate numeric fields before forwarding — a compromised PC could push
    // NaN, Infinity, or strings that would corrupt client state.
    const value = Number(msg.value);
    const max   = Number(msg.max);
    if (!Number.isFinite(value) || !Number.isFinite(max) || value < 0 || max < 0) return;
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
      console.warn(`[pc] Result for unknown job ${msg.jobId}`);
      return;
    }
    if (job.status === 'cancelled') {
      console.log(`[pc] Ignoring result for cancelled job ${msg.jobId}`);
      deleteJob(msg.jobId);
      dispatchNextJob();
      broadcastQueueUpdate();
      return;
    }
    completeJob(msg.jobId, msg.payload);
    const deliveredLive = sendJson(job.phoneWs, { type: 'result', jobId: msg.jobId, payload: msg.payload });
    console.log(`[pc] Job ${msg.jobId} completed.`);
    // If nobody is currently connected for this owner, keep the completed job
    // in memory and replay it on next reconnect.
    if (deliveredLive) {
      deleteJob(msg.jobId);
    }
    // Dispatch next
    dispatchNextJob();
    broadcastQueueUpdate();
    return;
  }

  if (msg.type === 'error') {
    const job = getJob(msg.jobId);
    if (job) {
      updateJobStatus(msg.jobId, 'error');
      if (job.phoneWs?.readyState === 1) {
        // Never forward raw PC error messages to clients — they may contain
        // Python tracebacks, file paths, or library version info.
        sendJson(job.phoneWs, { type: 'error', jobId: msg.jobId, message: 'Processing failed' });
      }
      deleteJob(msg.jobId);
    }
    // Full error detail is logged server-side only
    console.warn(`[pc] Error for job ${msg.jobId}: ${msg.message}`);
    // Dispatch next job after error
    dispatchNextJob();
    broadcastQueueUpdate();
    return;
  }

  console.warn(`[pc] Unhandled message type: ${msg.type}`);
}

// ── Phone socket handler ──────────────────────────────────────────────────────
function handlePhoneSocket(ws) {
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
    handlePhoneSocketAuthenticated(ws, payload, msg.token);
  });
}

function handlePhoneSocketAuthenticated(ws, jwtPayload, rawToken) {
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

  const pub = getPublicQueueState();
  const own = getOwnerQueueState(wsSessionId);
  sendJson(ws, { type: 'queue_update', ...pub, ...own, maxQueuePerUser: MAX_QUEUE_PER_USER });
  if (recovered.length > 0) {
    sendJson(ws, { type: 'job_recovery', jobs: recovered });
  }

  // Replay completed results that finished while the owner was offline.
  const completed = getCompletedJobsByUserId(queueUserId);
  for (const job of completed) {
    const payload = Buffer.isBuffer(job.encryptedResult)
      ? job.encryptedResult.toString('base64')
      : String(job.encryptedResult ?? '');
    if (!payload) {
      deleteJob(job.id);
      continue;
    }
    const delivered = sendJson(ws, { type: 'result', jobId: job.id, payload });
    if (!delivered) break;
    deleteJob(job.id);
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
      handleJobSubmit(ws, msg, jwtPayload, queueUserId, wsSessionId);
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

function handleJobSubmit(phoneWs, msg, jwtPayload, queueUserId, wsSessionId) {
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
    if ((userRow.tos_version ?? 0) < TOS_VERSION) {
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
  sendJson(phoneWs, { type: 'queued', jobId });
  console.log(`[queue] Job ${jobId} added to queue.`);

  // Try to dispatch immediately if nothing is processing
  dispatchNextJob();
  broadcastQueueUpdate();
}

// ── Admin socket handler ────────────────────────────────────────────────────────────
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
setInterval(() => pruneOldJobs(30 * 60 * 1000), 10 * 60 * 1000);

// Prune expired revoked-token entries every 60 minutes (and once at startup)
pruneRevokedTokens();
setInterval(() => pruneRevokedTokens(), 60 * 60 * 1000);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
