/**
 * vault-crypto.js — Envelope encryption for the result vault.
 *
 * Architecture:
 *   master_key (random 256-bit AES-GCM, extractable)
 *     ├── wrapped_with_bio_key   (AES-KW, from WebAuthn PRF output via HKDF)
 *     ├── wrapped_with_pw_key    (AES-KW, from password via PBKDF2)
 *     └── wrapped_with_recovery  (AES-KW, from recovery key via HKDF)
 *
 *   Blobs (images) are encrypted with the master_key via AES-256-GCM.
 */

const subtle = crypto.subtle;

// ── Master key ────────────────────────────────────────────────────────────────

/** Generate a new random 256-bit master key (extractable, for wrapping). */
export async function generateMasterKey() {
  return subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — needed for AES-KW wrapping
    ['encrypt', 'decrypt'],
  );
}

/** Export master key to raw bytes. */
export async function exportMasterKey(masterKey) {
  return new Uint8Array(await subtle.exportKey('raw', masterKey));
}

/** Import raw bytes as a master key. */
export async function importMasterKey(rawBytes) {
  return subtle.importKey(
    'raw',
    rawBytes,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

// ── Wrapping key derivation ───────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 600_000;

/** Derive an AES-KW wrapping key from a password + salt via PBKDF2. */
export async function deriveKeyFromPassword(password, salt) {
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** Derive an AES-KW wrapping key from WebAuthn PRF output via HKDF. */
export async function deriveKeyFromPRF(prfOutput, salt) {
  const keyMaterial = await subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('vault-prf-v1') },
    keyMaterial,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** Derive an AES-KW wrapping key from a recovery key via HKDF. */
export async function deriveKeyFromRecovery(recoveryBytes, salt) {
  const keyMaterial = await subtle.importKey('raw', recoveryBytes, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('vault-recovery-v1') },
    keyMaterial,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

// ── Key wrapping (AES-KW) ─────────────────────────────────────────────────────

/** Wrap (encrypt) the master key with a wrapping key. Returns Uint8Array. */
export async function wrapMasterKey(masterKey, wrappingKey) {
  const wrapped = await subtle.wrapKey('raw', masterKey, wrappingKey, 'AES-KW');
  return new Uint8Array(wrapped);
}

/** Unwrap (decrypt) the master key from wrapped bytes. Returns CryptoKey. */
export async function unwrapMasterKey(wrappedBytes, wrappingKey) {
  return subtle.unwrapKey(
    'raw',
    wrappedBytes,
    wrappingKey,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    true, // extractable
    ['encrypt', 'decrypt'],
  );
}

// ── Blob encryption (AES-GCM) ────────────────────────────────────────────────

/** Encrypt a blob (image bytes) with the master key. */
export async function encryptBlob(masterKey, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, masterKey, data),
  );
  return { iv, ciphertext };
}

/** Decrypt a blob with the master key. */
export async function decryptBlob(masterKey, iv, ciphertext) {
  return new Uint8Array(
    await subtle.decrypt({ name: 'AES-GCM', iv }, masterKey, ciphertext),
  );
}

// ── Recovery key ──────────────────────────────────────────────────────────────

/** Generate a random 32-byte recovery key. */
export function generateRecoveryKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Convert 32 bytes to a 24-word BIP39 mnemonic.
 * Uses 256 bits + 8-bit checksum = 264 bits = 24 × 11-bit indices.
 */
export async function recoveryKeyToWords(bytes) {
  const words = await import('./bip39-wordlist.js').then(m => m.default);
  // Compute SHA-256 checksum (first 8 bits for 256-bit entropy)
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes));
  const checksumByte = hash[0];

  // Concatenate entropy + checksum into a bit string
  const bits = new Uint8Array(33); // 32 bytes entropy + 1 byte checksum
  bits.set(bytes);
  bits[32] = checksumByte;

  const result = [];
  for (let i = 0; i < 24; i++) {
    // Extract 11 bits starting at bit position i*11
    const bitPos = i * 11;
    const byteIdx = Math.floor(bitPos / 8);
    const bitOffset = bitPos % 8;
    // Read 16 bits starting from byteIdx, then shift to get 11 bits
    let val = (bits[byteIdx] << 8) | (bits[byteIdx + 1] ?? 0);
    if (byteIdx + 2 < bits.length) {
      val = (val << 8) | bits[byteIdx + 2];
      val = (val >> (24 - bitOffset - 11)) & 0x7ff;
    } else {
      val = (val >> (16 - bitOffset - 11)) & 0x7ff;
    }
    result.push(words[val]);
  }
  return result;
}

/**
 * Convert a 24-word mnemonic back to 32 bytes.
 * Validates the checksum.
 */
export async function wordsToRecoveryKey(wordArray) {
  const words = await import('./bip39-wordlist.js').then(m => m.default);
  if (wordArray.length !== 24) throw new Error('Expected 24 words');

  // Convert words to 11-bit indices
  const indices = wordArray.map(w => {
    const idx = words.indexOf(w.toLowerCase().trim());
    if (idx === -1) throw new Error(`Unknown word: ${w}`);
    return idx;
  });

  // Pack 24 × 11-bit indices into 264 bits = 33 bytes
  const bits = new Uint8Array(33);
  for (let i = 0; i < 24; i++) {
    const val = indices[i];
    const bitPos = i * 11;
    for (let b = 0; b < 11; b++) {
      if (val & (1 << (10 - b))) {
        const pos = bitPos + b;
        bits[Math.floor(pos / 8)] |= (1 << (7 - (pos % 8)));
      }
    }
  }

  const entropy = bits.slice(0, 32);
  const checksumByte = bits[32];

  // Verify checksum
  const hash = new Uint8Array(await subtle.digest('SHA-256', entropy));
  if (hash[0] !== checksumByte) {
    throw new Error('Invalid recovery key: checksum mismatch');
  }

  return entropy;
}

/** Create a downloadable JSON recovery file. */
export function recoveryKeyToJSON(bytes, userEmail) {
  return {
    version: 1,
    app: 'ComfyLink',
    userEmail: userEmail ?? null,
    recoveryKey: bufToB64(bytes),
    createdAt: new Date().toISOString(),
  };
}

/** Parse a recovery JSON file back to bytes. */
export function recoveryKeyFromJSON(json) {
  if (json.version !== 1 || !json.recoveryKey) {
    throw new Error('Invalid recovery file format');
  }
  return b64ToBuf(json.recoveryKey);
}

// ── Thumbnail generation ──────────────────────────────────────────────────────

/** Build a RIFF chunk: 4-char FourCC + uint32LE payload size + data (0-padded to even length). */
function _makeWebPChunk(fourcc, data) {
  const payloadLen = data.length;
  const chunk = new Uint8Array(8 + payloadLen + (payloadLen % 2)); // pad to even
  for (let i = 0; i < 4; i++) chunk[i] = fourcc.charCodeAt(i);
  chunk[4] = payloadLen & 0xff;
  chunk[5] = (payloadLen >> 8) & 0xff;
  chunk[6] = (payloadLen >> 16) & 0xff;
  chunk[7] = (payloadLen >> 24) & 0xff;
  chunk.set(data, 8);
  return chunk;
}

/**
 * Inject XMP AI-generation metadata into a WebP Uint8Array.
 *
 * Required by ČTÚ rules for AI-generated content.  Mirrors the PNG tEXt
 * chunks injected by the PC client (AI_Generated=yes, Comment=Generated by AI)
 * using their XMP equivalents:
 *   dc:description          → "Generated by AI"
 *   Iptc4xmpExt:DigitalSourceType → trainedAlgorithmicMedia
 *
 * Converts simple (VP8 / VP8L) WebP to Extended format (VP8X + XMP  chunk).
 * Already-extended (VP8X) files and non-WebP buffers are returned unchanged.
 */
function _injectWebPAiMetadata(webpBytes, canvasWidth, canvasHeight) {
  if (webpBytes.length < 20) return webpBytes;
  const cc = (off) =>
    String.fromCharCode(webpBytes[off], webpBytes[off + 1], webpBytes[off + 2], webpBytes[off + 3]);
  if (cc(0) !== 'RIFF' || cc(8) !== 'WEBP') return webpBytes;
  if (cc(12) === 'VP8X') return webpBytes; // already extended — skip

  // XMP payload mirrors the PNG Comment and AI_Generated tEXt chunks
  const xmpPayload = new TextEncoder().encode(
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about=""' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    ' xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">' +
    '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Generated by AI</rdf:li></rdf:Alt></dc:description>' +
    '<Iptc4xmpExt:DigitalSourceType>' +
    'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia' +
    '</Iptc4xmpExt:DigitalSourceType>' +
    '</rdf:Description>' +
    '</rdf:RDF>' +
    '</x:xmpmeta>' +
    '<?xpacket end="w"?>',
  );

  // VP8X chunk data (10 bytes): uint32LE flags + 24-bit LE (width-1) + 24-bit LE (height-1)
  const w = canvasWidth - 1;
  const h = canvasHeight - 1;
  const vp8xData = new Uint8Array([
    0x04, 0x00, 0x00, 0x00,                          // flags: XMP bit (0x04)
    w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff,
    h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  ]);

  const vp8xChunk  = _makeWebPChunk('VP8X', vp8xData);
  const xmpChunk   = _makeWebPChunk('XMP ', xmpPayload);
  const origChunks = webpBytes.slice(12); // skip "RIFF[size]WEBP"

  const newBody = new Uint8Array(vp8xChunk.length + origChunks.length + xmpChunk.length);
  let off = 0;
  newBody.set(vp8xChunk,  off); off += vp8xChunk.length;
  newBody.set(origChunks, off); off += origChunks.length;
  newBody.set(xmpChunk,   off);

  // Rebuild: "RIFF" + uint32LE(4 + body) + "WEBP" + body
  const newRiffSize = 4 + newBody.length;
  const result = new Uint8Array(12 + newBody.length);
  result[0] = 0x52; result[1] = 0x49; result[2] = 0x46; result[3] = 0x46; // RIFF
  result[4] = newRiffSize & 0xff;
  result[5] = (newRiffSize >> 8) & 0xff;
  result[6] = (newRiffSize >> 16) & 0xff;
  result[7] = (newRiffSize >> 24) & 0xff;
  result[8] = 0x57; result[9] = 0x45; result[10] = 0x42; result[11] = 0x50; // WEBP
  result.set(newBody, 12);
  return result;
}

/**
 * Generate a low-quality WebP thumbnail from an image blob URL.
 * AI-generation XMP metadata is injected before returning (ČTÚ compliance).
 * Returns Uint8Array of the WebP thumbnail.
 */
export async function generateThumbnail(imageUrl, maxWidth = 200) {
  const img = new Image();
  img.src = imageUrl;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });

  const scale = Math.min(maxWidth / img.naturalWidth, 1);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.6 });
  const thumbBytes = new Uint8Array(await blob.arrayBuffer());
  return _injectWebPAiMetadata(thumbBytes, w, h);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function bufToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const CHUNK = 32768;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

export function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
