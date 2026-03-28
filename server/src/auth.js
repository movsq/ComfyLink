import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

// PIN hash is computed once at startup from the env var.
let pinHash = null;

// In-memory session token store: token → { createdAt }
const sessions = new Map();

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS ?? '86400000', 10);

export async function initAuth() {
  const pin = process.env.PIN;
  if (!pin || pin === 'changeme') {
    console.warn(
      '[auth] WARNING: PIN is not set or is still "changeme". Set PIN in your .env file.',
    );
  }
  pinHash = await bcrypt.hash(pin ?? 'changeme', 12);
  console.log('[auth] PIN hash initialized.');
}

export async function verifyPin(candidate) {
  if (!pinHash) throw new Error('Auth not initialized');
  return bcrypt.compare(candidate, pinHash);
}

export function createSession() {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

export function validateSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function deleteSession(token) {
  sessions.delete(token);
}

/**
 * Express middleware — rejects requests without a valid session token.
 * Token is expected in the Authorization header as "Bearer <token>".
 */
export function requireSession(req, res, next) {
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!validateSession(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.sessionToken = token;
  next();
}
