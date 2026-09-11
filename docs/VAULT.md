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
| **Recovery key** | HKDF-SHA-256 (`info = "vault-recovery-v1"`) from a random 256-bit recovery key | Encoded as 24 BIP-39 words (256 bits + 8-bit checksum). Generated at vault setup; must be stored offline by the user. Unlocking with it prompts you to set a new password. |

At least the recovery method is always configured. Bio and password are optional.

---

## Vault operations

| Operation | Endpoint | Description |
|-----------|----------|-------------|
| Setup | `POST /vault/setup` | Store all wrapped key blobs and WebAuthn credential metadata |
| Unlock | `POST /vault/unlock` | Retrieve the wrapped master key for the chosen method |
| Rekey | `POST /vault/rekey` | Replace wrapped key blobs (e.g. change password or register new passkey). Requires **step-up auth** (Google ID token or email password). |
| Delete | `DELETE /vault` | Permanently delete vault and all stored results. Requires **step-up auth**. |

---

## Result storage

Results are AES-256-GCM encrypted client-side before upload. The server stores:

- The encrypted thumbnail (200 px WebP, encrypted with the vault master key before upload)
  - The PC encrypts the thumbnail with the per-job result key before it leaves the PC, so the relay only ever forwards ciphertext. The browser decrypts it, then re-encrypts it with the vault master key for storage.
- The full image (encrypted, max 20 MB per result)

IVs are stored alongside each ciphertext. The server never sees the vault master key, the plaintext full image, or the plaintext thumbnail — neither in the database nor in transit.

**Threat-model note.** `POST /vault/unlock` returns the wrapped master-key blob to any holder of a valid session token, without step-up. A stolen session token therefore reduces vault security to the strength of the vault password (PBKDF2-SHA-256, 600 000 iterations) or of the recovery phrase. Passkey-wrapped blobs cannot be brute-forced because the PRF secret never leaves the authenticator.

See [API.md](API.md) for the full `/results` endpoint reference.
