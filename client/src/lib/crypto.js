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
 *   1. generateEphemeralKeyPair()          — fresh keypair per job
 *   2. importPcPublicKey(b64)              — parse the PC's static public key
 *   3. deriveAESKey(ephPriv, pcPub)        — ECDH + HKDF → AES-256-GCM CryptoKey
 *   4. encryptPayload(aesKey, data)        — encrypt Uint8Array → {iv, ciphertext}
 *   5. encodeJobPayload(ephPub, iv, ct)    — pack into base64 string for relay
 *   6. decodeResultPayload(b64)            — unpack server relay response
 *   7. decryptPayload(aesKey, iv, ct)      — decrypt → Uint8Array
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

/**
 * Derive a shared AES-256-GCM key via ECDH + HKDF.
 * @param {CryptoKey} ephPrivateKey  — our ephemeral private key
 * @param {CryptoKey} pcPublicKey    — the PC's static public key
 * @returns {CryptoKey}              — AES-256-GCM key usable for encrypt/decrypt
 */
export async function deriveAESKey(ephPrivateKey, pcPublicKey) {
  // Step 1: ECDH → extract raw shared secret bits (P-256 → 256 bits)
  const ecdhRaw = await getSubtle().deriveBits(
    { name: 'ECDH', public: pcPublicKey },
    ephPrivateKey,
    256,
  );

  // Step 2: Import as HKDF key material, then derive AES-256-GCM key
  const hkdfKey = await getSubtle().importKey('raw', ecdhRaw, 'HKDF', false, ['deriveKey']);

  return getSubtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // fixed zero salt — fine for per-job ephemeral keys
      info: new TextEncoder().encode('flux2-klein-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
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
