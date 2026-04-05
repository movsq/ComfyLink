/**
 * api.js — HTTP helpers for auth and public key retrieval.
 */

/**
 * Exchange a Google ID token (+ optional invite code) for a JWT session.
 * Returns { token, user } on success, or { status: 'pending_approval' } for pending accounts.
 * Throws on error.
 */
export async function loginWithGoogle(idToken, inviteCode = null) {
  const body = { idToken };
  if (inviteCode) body.inviteCode = inviteCode;

  const res = await fetch('/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 429) throw new Error('Too many attempts — please wait a moment and try again');
  if (res.status === 401) throw new Error('Invalid Google token');
  if (res.status === 403) throw new Error(data.error || 'Forbidden');
  if (res.status === 400) throw new Error(data.error || 'Bad request');
  if (!res.ok) throw new Error(data.error || `Sign-in failed (${res.status}) — please try again`);

  return data;
}

/**
 * Get the current user's info from the server.
 */
export async function getMe(token) {
  const res = await fetch('/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Fetch the PC's cached public key from the server.
 * Returns the base64-encoded SPKI string.
 */
export async function getPCPublicKey(token) {
  const res = await fetch('/pc-pubkey', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 503) throw new Error('PC is not connected');
  if (!res.ok) throw new Error(`Failed to get public key: ${res.status}`);
  const { publicKey } = await res.json();
  return publicKey;
}

// ── Invite code management (admin) ──────────────────────────────────────────

export async function generateCode(token, { type = 'registration', usesRemaining = 1, expiresInHours = null } = {}) {
  const res = await fetch('/codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type, usesRemaining, expiresInHours }),
  });
  if (!res.ok) throw new Error(`Failed to generate code: ${res.status}`);
  return res.json();
}

export async function listCodes(token) {
  const res = await fetch('/codes', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to list codes: ${res.status}`);
  return res.json();
}

export async function deleteCode(token, id) {
  const res = await fetch(`/codes/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to delete code: ${res.status}`);
  return res.json();
}

export async function updateCode(token, id, { usesRemaining, expiresInHours }) {
  const res = await fetch(`/codes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ usesRemaining, expiresInHours }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update code: ${res.status}`);
  }
  return res.json();
}

// ── Vault ───────────────────────────────────────────────────────────────────

export async function setupVault(token, data) {
  const res = await fetch('/vault/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Vault setup failed: ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

export async function getVaultInfo(token) {
  const res = await fetch('/vault/info', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function unlockVault(token, method) {
  const res = await fetch('/vault/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Vault unlock failed: ${res.status}`);
  }
  return res.json();
}

export async function rekeyVault(token, data) {
  const res = await fetch('/vault/rekey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Vault rekey failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteVault(token, idToken) {
  const res = await fetch('/vault', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Vault reset failed: ${res.status}`);
  }
  return res.json();
}

// ── Stored results ──────────────────────────────────────────────────────────

export async function saveResult(token, data) {
  const res = await fetch('/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Save failed: ${res.status}`);
  }
  return res.json();
}

export async function listResults(token, { limit = 20, before = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', String(before));
  const res = await fetch(`/results?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to list results: ${res.status}`);
  return res.json();
}

export async function getResultFull(token, id) {
  const res = await fetch(`/results/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to get result: ${res.status}`);
  return res.json();
}

export async function deleteResult(token, id) {
  const res = await fetch(`/results/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to delete result: ${res.status}`);
  return res.json();
}

// ── Access code auth ────────────────────────────────────────────────────────

/** POST /auth/tos — record acceptance of Terms of Service */
export async function acceptTos(token) {
  const res = await fetch('/auth/tos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ accepted: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `ToS acceptance failed: ${res.status}`);
  }
  return res.json();
}

export async function loginWithCode(code) {
  const res = await fetch('/auth/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Code login failed: ${res.status}`);
  return data;
}

// ── Admin user management ───────────────────────────────────────────────────

export async function listUsers(token, status = null) {
  const params = status ? `?status=${status}` : '';
  const res = await fetch(`/admin/users${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to list users: ${res.status}`);
  return res.json();
}

export async function updateUserStatus(token, id, status) {
  const res = await fetch(`/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update user: ${res.status}`);
  }
  return res.json();
}

export async function updateUserUses(token, id, usesRemaining) {
  const res = await fetch(`/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ usesRemaining }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update user uses: ${res.status}`);
  }
  return res.json();
}
