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
  decrementCodeUses,
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
  getAllUsers,
  updateUserStatus,
} from './db.js';
import {
  createJob,
  completeJob,
  getJob,
  updateJobStatus,
  pruneOldJobs,
} from './jobs.js';

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

function sendJson(ws, obj) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(obj));
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : undefined; // undefined = allow all in dev
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : undefined));
app.use(express.json({ limit: '20mb' }));

// Rate limiting
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests — try again later' } });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests — try again later' } });
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
      user: { name: existing.name, email: existing.email, status: existing.status, isAdmin: !!existing.is_admin },
    });
  }

  // ── New user with invite code ─────────────────────────────────────────────
  if (inviteCode) {
    const code = validateInviteCode(inviteCode, 'registration');
    if (!code) {
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }
    const user = createUser({
      googleSub: googleUser.sub,
      email: googleUser.email,
      name: googleUser.name,
      picture: googleUser.picture,
      status: 'active',
    });
    decrementCodeUses(code.id);
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
      user: { name: user.name, email: user.email, status: user.status, isAdmin: !!user.is_admin },
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
  });
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
  const { type = 'registration', usesRemaining = 1, expiresInHours = null } = req.body ?? {};
  if (!['registration', 'job_access'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }

  // Generate KLEIN-XXXX-XXXX format
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  const bytes = randomBytes(8);
  let code = 'KLEIN-';
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
    if (i === 3) code += '-';
  }

  const expiresAt = expiresInHours ? Date.now() + expiresInHours * 3600_000 : null;

  createInviteCode({
    code,
    type,
    createdBy: req.user.userId,
    usesRemaining: usesRemaining ?? null,
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

  if (usesRemaining !== undefined && usesRemaining !== null) {
    const n = parseInt(usesRemaining, 10);
    if (isNaN(n) || n < 0) return res.status(400).json({ error: 'usesRemaining must be a non-negative integer or null' });
  }
  if (expiresInHours !== undefined && expiresInHours !== null) {
    const n = parseFloat(expiresInHours);
    if (isNaN(n) || n <= 0) return res.status(400).json({ error: 'expiresInHours must be a positive number or null' });
  }

  const expiresAt = expiresInHours != null ? Date.now() + parseFloat(expiresInHours) * 3600_000 : null;
  const uses = usesRemaining != null ? parseInt(usesRemaining, 10) : null;

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
app.post('/vault/rekey', requireActive, (req, res) => {
  const userId = req.user.userId;
  const existing = getVaultByUser(userId);
  if (!existing) return res.status(404).json({ error: 'No vault configured' });

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
app.delete('/vault', requireActive, (req, res) => {
  const vault = getVaultByUser(req.user.userId);
  if (!vault) return res.status(404).json({ error: 'No vault configured' });

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

  if (typeof encryptedFull !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encryptedFull)) {
    return res.status(400).json({ error: 'Invalid base64 encoding' });
  }
  const fullBuf = Buffer.from(encryptedFull, 'base64');
  if (fullBuf.length > 20 * 1024 * 1024) {
    return res.status(413).json({ error: 'Image too large (max 20MB)' });
  }

  const result = createStoredResult(req.user.userId, {
    encryptedThumb: Buffer.from(encryptedThumb, 'base64'),
    encryptedFull: fullBuf,
    ivThumb: Buffer.from(ivThumb, 'base64'),
    ivFull: Buffer.from(ivFull, 'base64'),
    fullSizeBytes: fullSizeBytes ?? fullBuf.length,
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

  const row = validateInviteCode(code.trim().toUpperCase(), 'job_access');
  if (!row) {
    return res.status(400).json({ error: 'Invalid or expired access code' });
  }

  const token = signJwt({ codeId: row.id, type: 'code_user' });
  res.json({ token, user: { type: 'code_user', codeId: row.id } });
});

// ── Admin user management ─────────────────────────────────────────────────────

/** GET /admin/users — list users, optionally filter by status */
app.get('/admin/users', requireAdmin, (req, res) => {
  const status = req.query.status ?? null;
  const users = getAllUsers(status);
  res.json(users.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    status: u.status,
    isAdmin: !!u.is_admin,
    createdAt: u.created_at,
  })));
});

/** PATCH /admin/users/:id — update user status */
app.patch('/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const { status } = req.body ?? {};
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or suspended' });
  }

  // Cannot modify own account
  if (id === req.user.userId) {
    return res.status(400).json({ error: 'Cannot modify own account' });
  }

  const target = getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Cannot modify other admins
  if (target.is_admin && target.id !== req.user.userId) {
    return res.status(403).json({ error: 'Cannot modify another admin' });
  }

  updateUserStatus(id, status);
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
const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });

server.on('upgrade', async (req, socket, head) => {
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
    const token = url.searchParams.get('token');
    const payload = verifyJwt(token);
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // Code users can connect too
    if (payload.type === 'code_user') {
      wss.handleUpgrade(req, socket, head, (ws) => handlePhoneSocket(ws, payload));
      return;
    }
    const user = getUserById(payload.userId);
    if (!user || user.status !== 'active') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handlePhoneSocket(ws, payload));
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

// ── PC socket handler ─────────────────────────────────────────────────────────
async function handlePcSocket(ws) {
  console.log('[pc] Connecting — waiting for auth handshake...');

  const authTimeout = setTimeout(() => {
    console.warn('[pc] Auth timed out.');
    ws.close(4001, 'Auth timeout');
  }, 10_000);

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
    const job = getJob(msg.jobId);
    if (job?.phoneWs?.readyState === 1) {
      sendJson(job.phoneWs, {
        type: 'progress',
        jobId: msg.jobId,
        value: msg.value,
        max: msg.max,
        node: msg.node ?? null,
      });
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
      return;
    }
    completeJob(msg.jobId, msg.payload);
    if (job.phoneWs?.readyState === 1) {
      sendJson(job.phoneWs, { type: 'result', jobId: msg.jobId, payload: msg.payload });
    }
    console.log(`[pc] Job ${msg.jobId} completed.`);
    return;
  }

  if (msg.type === 'error') {
    const job = getJob(msg.jobId);
    if (job?.phoneWs?.readyState === 1) {
      sendJson(job.phoneWs, { type: 'error', jobId: msg.jobId, message: msg.message });
    }
    console.warn(`[pc] Error for job ${msg.jobId}: ${msg.message}`);
    return;
  }

  console.warn(`[pc] Unhandled message type: ${msg.type}`);
}

// ── Phone socket handler ──────────────────────────────────────────────────────
function handlePhoneSocket(ws, jwtPayload) {
  console.log(`[phone] Connected (${jwtPayload.type === 'code_user' ? 'code' : 'google'}).`);

  if (jwtPayload.type === 'code_user') {
    registerCodeSocket(jwtPayload.codeId, ws);
    // Send initial code status so the client can show a warning immediately
    const codeRow = findInviteCodeById(jwtPayload.codeId);
    if (codeRow) sendJson(ws, { type: 'code_status', usesRemaining: codeRow.uses_remaining });
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (msg.type === 'submit') {
      handleJobSubmit(ws, msg, jwtPayload);
    } else if (msg.type === 'cancel') {
      if (msg.jobId) {
        updateJobStatus(msg.jobId, 'cancelled');
      }
      if (pcSocket && pcSocket.readyState === 1) {
        sendJson(pcSocket, { type: 'cancel', jobId: msg.jobId });
      }
    } else {
      sendJson(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    if (jwtPayload.type === 'code_user') {
      unregisterCodeSocket(jwtPayload.codeId, ws);
    }
    console.log('[phone] Disconnected.');
  });
}

function handleJobSubmit(phoneWs, msg, jwtPayload = null) {
  if (!pcSocket || pcSocket.readyState !== 1) {
    sendJson(phoneWs, { type: 'no_pc' });
    return;
  }

  if (typeof msg.payload !== 'string') {
    sendJson(phoneWs, { type: 'error', message: 'Missing payload' });
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

  if (jwtPayload?.type === 'code_user') {
    const codeRow = findInviteCodeById(jwtPayload.codeId);
    if (!codeRow || (codeRow.uses_remaining !== null && codeRow.uses_remaining <= 0)) {
      sendJson(phoneWs, { type: 'error', message: 'Access code has no remaining uses' });
      return;
    }
    if (codeRow.uses_remaining !== null) {
      decrementCodeUses(codeRow.id);
      notifyAdmins('codes_changed');
      // Tell the code-user their remaining count so the UI can update proactively
      notifyCodeUsers(jwtPayload.codeId, codeRow.uses_remaining - 1);
    }
  }

  const jobId = uuidv4();
  createJob(jobId, phoneWs);
  sendJson(phoneWs, { type: 'queued', jobId });
  sendJson(pcSocket, { type: 'job', jobId, payload: msg.payload });
  updateJobStatus(jobId, 'processing');
  console.log(`[relay] Job ${jobId} dispatched.`);
}

// ── Admin socket handler ────────────────────────────────────────────────────────────
function handleAdminSocket(ws, userId) {
  console.log(`[admin-ws] Connected (user ${userId}).`);
  adminSockets.set(ws, userId);

  // Push an initial refresh signal so the panel catches up if it missed anything
  // before the WS was established (small race window on first open).
  sendJson(ws, { type: 'codes_changed' });
  sendJson(ws, { type: 'users_changed' });

  ws.on('close', () => {
    adminSockets.delete(ws);
    console.log(`[admin-ws] Disconnected (user ${userId}).`);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
initAuth();

// Prune stale jobs every 10 minutes
setInterval(() => pruneOldJobs(30 * 60 * 1000), 10 * 60 * 1000);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
