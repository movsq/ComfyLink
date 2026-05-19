/**
 * crypto.js — Browser-side E2E encryption using the WebCrypto API.
 *
 * Algorithm:
 *   Key exchange:  ECDH with P-256 (WebCrypto's supported curve; X25519 support
 *                  is still inconsistent across mobile browsers as of 2026).
 *   Symmetric:     AES-256-GCM
 *   Key derivation: HKDF-SHA-256 from the ECDH shared secret
 *
 * Per-job flow:
 *   1. generateEphemeralKeyPair()              — fresh keypair per job
 *   2. importPcPublicKey(b64)                  — parse the PC's static public key
 *   3. deriveSessionKeys(ephPriv, pcPub)       — ECDH + HKDF → { jobKey, resultKey }
 *   4. encryptPayload(jobKey, data)            — encrypt Uint8Array → {iv, ciphertext}
 *   5. encodeJobPayload(ephPub, iv, ct)        — pack into base64 string for relay
 *   6. decodeResultPayload(b64)                — unpack server relay response
 *   7. decryptPayload(resultKey, iv, ct)       — decrypt → Uint8Array
 */

function getSubtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error(
      'WebCrypto is unavailable. This app requires a secure context.\n' +
      'Open it via https:// or http://localhost — not an http:// LAN IP address.'
    );
  }
  return s;
}

// ── Key generation ────────────────────────────────────────────────────────────

/** Generate an ephemeral ECDH keypair (P-256). Used once per submitted job. */
export async function generateEphemeralKeyPair() {
  return getSubtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
}

/**
 * Import the PC's static public key from a base64-encoded SPKI blob.
 * The PC exports its public key in SPKI format; we import for ECDH derivation.
 */
export async function importPcPublicKey(b64) {
  const raw = b64ToBuffer(b64);
  return getSubtle().importKey(
    'spki',
    raw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

// ── Key derivation ────────────────────────────────────────────────────────────

const HKDF_SALT = new Uint8Array(32); // fixed zero salt — fine for per-job ephemeral keys
const HKDF_INFO_JOB    = new TextEncoder().encode('flux2-klein-v1:job');
const HKDF_INFO_RESULT = new TextEncoder().encode('flux2-klein-v1:result');

/**
 * Derive two AES-256-GCM keys from one ECDH exchange via HKDF, one per
 * direction. The phone uses `jobKey` to encrypt the job payload it sends to
 * the PC and `resultKey` to decrypt the image the PC sends back. Using one
 * key for both roles is cryptographically sound under random IVs, but textbook
 * practice (and easier to extend later, e.g. with associated data per
 * direction) is to keep the keys separate. The PC mirrors this derivation
 * with the same info strings.
 *
 * @param {CryptoKey} ephPrivateKey  — our ephemeral private key
 * @param {CryptoKey} pcPublicKey    — the PC's static public key
 * @returns {{ jobKey: CryptoKey, resultKey: CryptoKey }}
 */
export async function deriveSessionKeys(ephPrivateKey, pcPublicKey) {
  // Step 1: ECDH → raw shared-secret bits (P-256 → 256 bits)
  const ecdhRaw = await getSubtle().deriveBits(
    { name: 'ECDH', public: pcPublicKey },
    ephPrivateKey,
    256,
  );

  // Step 2: import as HKDF material, then derive once per direction.
  const hkdfKey = await getSubtle().importKey('raw', ecdhRaw, 'HKDF', false, ['deriveKey']);

  const jobKey = await getSubtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO_JOB },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const resultKey = await getSubtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO_RESULT },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  return { jobKey, resultKey };
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

/**
 * Encrypt data with AES-256-GCM.
 * @param {CryptoKey} aesKey
 * @param {Uint8Array} data
 * @returns {{ iv: Uint8Array, ciphertext: Uint8Array }}
 */
export async function encryptPayload(aesKey, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await getSubtle().encrypt({ name: 'AES-GCM', iv }, aesKey, data),
  );
  return { iv, ciphertext };
}

/**
 * Decrypt AES-256-GCM ciphertext (which includes the GCM auth tag appended by WebCrypto).
 * @param {CryptoKey} aesKey
 * @param {Uint8Array} iv
 * @param {Uint8Array} ciphertext
 * @returns {Uint8Array}
 */
export async function decryptPayload(aesKey, iv, ciphertext) {
  const plaintext = await getSubtle().decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  return new Uint8Array(plaintext);
}

// ── Payload packing ───────────────────────────────────────────────────────────

/**
 * Export the ephemeral public key as SPKI bytes (for sending to the PC so it can
 * do ECDH from its end and derive the same AES key).
 */
export async function exportEphemeralPublicKey(ephPublicKey) {
  const spki = await getSubtle().exportKey('spki', ephPublicKey);
  return new Uint8Array(spki);
}

/**
 * Pack the full job payload into a single base64 string for relay.
 *
 * Wire format (all big-endian):
 *   [2 bytes] ephPubKeyLen
 *   [N bytes] ephPubKey (SPKI)
 *   [12 bytes] iv
 *   [remaining] ciphertext (includes GCM tag)
 */
export function encodeJobPayload(ephPubKeyBytes, iv, ciphertext) {
  const keyLen = ephPubKeyBytes.length;
  const buf = new Uint8Array(2 + keyLen + 12 + ciphertext.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, keyLen, false); // big-endian
  buf.set(ephPubKeyBytes, 2);
  buf.set(iv, 2 + keyLen);
  buf.set(ciphertext, 2 + keyLen + 12);
  return bufToB64(buf);
}

/**
 * Unpack a result payload base64 string from the relay.
 *
 * Wire format (results use the same structure minus the ephPubKey — just iv + ciphertext):
 *   [12 bytes] iv
 *   [remaining] ciphertext
 */
export function decodeResultPayload(b64) {
  const buf = b64ToBuffer(b64);
  const iv = buf.slice(0, 12);
  const ciphertext = buf.slice(12);
  return { iv, ciphertext };
}

/**
 * Decode a job payload (for the crypto roundtrip test only — normally only the PC does this).
 */
export function decodeJobPayload(b64) {
  const buf = b64ToBuffer(b64);
  const view = new DataView(buf.buffer);
  const keyLen = view.getUint16(0, false);
  const ephPubKeyBytes = buf.slice(2, 2 + keyLen);
  const iv = buf.slice(2 + keyLen, 2 + keyLen + 12);
  const ciphertext = buf.slice(2 + keyLen + 12);
  return { ephPubKeyBytes, iv, ciphertext };
}

// ── Key pinning ──────────────────────────────────────────────────────────

/**
 * Verify the PC public key fingerprint against the build-time pinned value.
 * @param {string} b64 — base64-encoded SPKI DER bytes (as returned by /pc-pubkey)
 * @throws {Error} if the fingerprint doesn't match or isn't configured
 */
export async function verifyPcKeyFingerprint(b64) {
  const pinned = (import.meta.env.VITE_PC_KEY_FINGERPRINT ?? '').replace(/:/g, '').toLowerCase();
  if (!pinned || pinned.length !== 64) {
    throw new Error(
      'PC key fingerprint is not configured. Set VITE_PC_KEY_FINGERPRINT in .env and rebuild.'
    );
  }
  const keyBytes = b64ToBuffer(b64);
  const digest = await crypto.subtle.digest('SHA-256', keyBytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== pinned) {
    throw new Error(
      'PC public key fingerprint mismatch — possible key substitution attack.\n' +
      `Expected: ${pinned}\nReceived: ${hex}`
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function bufToB64(buf) {
  const CHUNK = 32768;
  const parts = [];
  for (let i = 0; i < buf.length; i += CHUNK) {
    parts.push(String.fromCharCode(...buf.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

export function b64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
