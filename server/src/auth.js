import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';
import { getUserById, findInviteCodeById } from './db.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET;
const PC_SECRET = process.env.PC_SECRET;
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS ?? '86400000', 10);

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── Init ──────────────────────────────────────────────────────────────────────

export function initAuth() {
  if (!GOOGLE_CLIENT_ID) {
    console.warn('[auth] WARNING: GOOGLE_CLIENT_ID is not set. Google OAuth will fail.');
  }
  if (!JWT_SECRET) {
    throw new Error('[auth] JWT_SECRET must be set in .env');
  }
  if (!PC_SECRET || PC_SECRET === 'changeme') {
    throw new Error('[auth] PC_SECRET must be set in .env to a secure value (not "changeme").');
  }
  console.log('[auth] Initialized.');
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

export async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name ?? '',
    picture: payload.picture ?? '',
  };
}

// ── JWT ───────────────────────────────────────────────────────────────────────

export function signJwt({ userId, googleSub, status, isAdmin, codeId, type }) {
  const payload = {};
  if (userId != null) payload.userId = userId;
  if (googleSub) payload.googleSub = googleSub;
  if (status) payload.status = status;
  if (isAdmin != null) payload.isAdmin = isAdmin;
  if (codeId != null) payload.codeId = codeId;
  if (type) payload.type = type;
  return jwt.sign(
    payload,
    JWT_SECRET,
    { expiresIn: Math.floor(SESSION_TTL_MS / 1000) },
  );
}

export function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ── PC secret ─────────────────────────────────────────────────────────────────

export function verifyPcSecret(candidate) {
  if (!PC_SECRET || typeof candidate !== 'string') return false;
  const a = Buffer.from(PC_SECRET);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Express middleware ────────────────────────────────────────────────────────

function extractToken(req) {
  const header = req.headers['authorization'] ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Requires a valid JWT. Attaches req.user with { userId, googleSub, status, isAdmin }.
 */
export function requireAuth(req, res, next) {
  const token = extractToken(req);
  const payload = verifyJwt(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = payload;
  next();
}

/**
 * Requires a valid JWT AND status === 'active'.
 * Re-checks the DB so status changes take effect immediately.
 */
export function requireActive(req, res, next) {
  const token = extractToken(req);
  const payload = verifyJwt(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = getUserById(payload.userId);
  if (!user || user.status !== 'active') {
    return res.status(403).json({ error: 'Account not active' });
  }
  req.user = { ...payload, status: user.status, isAdmin: !!user.is_admin };
  next();
}

/**
 * Requires a valid JWT, active status, AND admin flag.
 */
export function requireAdmin(req, res, next) {
  const token = extractToken(req);
  const payload = verifyJwt(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = getUserById(payload.userId);
  if (!user || user.status !== 'active') {
    return res.status(403).json({ error: 'Account not active' });
  }
  if (!user.is_admin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.user = { ...payload, status: user.status, isAdmin: true };
  next();
}

/**
 * Accepts either an active Google user JWT or a code-user JWT.
 * Attaches req.user with at minimum { type }.
 * For Google users: { userId, googleSub, status, isAdmin, type: 'google' }
 * For code users: { codeId, type: 'code_user' }
 */
export function requireActiveOrCode(req, res, next) {
  const token = extractToken(req);
  const payload = verifyJwt(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (payload.type === 'code_user') {
    // Re-check the DB so revoked/expired/exhausted codes are rejected immediately.
    const code = findInviteCodeById(payload.codeId);
    if (!code) return res.status(403).json({ error: 'Access code not found' });
    if (code.expires_at !== null && Date.now() > code.expires_at) {
      return res.status(403).json({ error: 'Access code expired' });
    }
    if (code.uses_remaining !== null && code.uses_remaining <= 0) {
      return res.status(403).json({ error: 'Access code has no remaining uses' });
    }
    req.user = payload;
    return next();
  }
  // Google user path
  const user = getUserById(payload.userId);
  if (!user || user.status !== 'active') {
    return res.status(403).json({ error: 'Account not active' });
  }
  req.user = { ...payload, status: user.status, isAdmin: !!user.is_admin, type: 'google' };
  next();
}
