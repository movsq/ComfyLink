# Vault & Encrypted Results

[← Back to README](../README.md)

Each generation result can be saved into an **encrypted vault** stored server-side. The server only ever holds ciphertext — it has no access to the master key.

---

## Master key wrapping

A random 256-bit master key is generated in the browser and wrapped (AES-KW) up to three ways:

| Wrapping method | Key derivation | Details |
|-----------------|---------------|---------|
| **Biometric / WebAuthn PRF** | HKDF-SHA-256 from PRF output | Requires a registered WebAuthn credential with PRF extension (passkey) |
| **Password** | PBKDF2-SHA-256, 600 000 iterations | User-chosen password; salt stored server-side |
| **Recovery key** | Raw 256-bit key encoded as 24 BIP-39 words | Generated at vault setup; must be stored offline by the user |

At least the recovery method is always configured. Bio and password are optional.

---

## Vault operations

| Operation | Endpoint | Description |
|-----------|----------|-------------|
| Setup | `POST /vault/setup` | Store all wrapped key blobs and WebAuthn credential metadata |
| Unlock | `POST /vault/unlock` | Retrieve the wrapped master key for the chosen method |
| Rekey | `POST /vault/rekey` | Replace wrapped key blobs (e.g. change password or register new passkey) |
| Delete | `DELETE /vault` | Permanently delete vault and all stored results |

---

## Result storage

Results are AES-256-GCM encrypted client-side before upload. The server stores:

- The encrypted thumbnail (200 px WebP, encrypted with the vault master key before upload)
- The full image (encrypted, max 20 MB per result)

IVs are stored alongside each ciphertext. The server never sees the vault master key or the plaintext full image. Thumbnails are not stored server-side in plaintext — the browser encrypts them before upload — though the relay may see a thumbnail transiently during live WebSocket delivery.

See [API.md](API.md) for the full `/results` endpoint reference.
