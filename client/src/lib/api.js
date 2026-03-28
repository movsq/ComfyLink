/**
 * api.js — HTTP helpers for auth and public key retrieval.
 */

/** Exchange a PIN for a session token. Throws on bad PIN or network error. */
export async function login(pin) {
  const res = await fetch('/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (res.status === 401) throw new Error('Invalid PIN');
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const { token } = await res.json();
  return token;
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
