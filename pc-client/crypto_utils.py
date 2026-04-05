"""
crypto_utils.py — PC-side E2E encryption/decryption.

Mirrors the browser-side crypto.js logic, using the `cryptography` library.

Algorithm:
    Key exchange:  ECDH with P-256 (matches WebCrypto on the phone)
    Symmetric:     AES-256-GCM
    Key derivation: HKDF-SHA-256 from the ECDH shared secret

Wire format (set by the phone in crypto.js encodeJobPayload):
    [2 bytes big-endian]  ephPubKeyLen
    [N bytes]             ephemeral public key (SPKI DER)
    [12 bytes]            AES-GCM IV
    [remaining]           ciphertext (includes 16-byte GCM auth tag at end)

Result wire format (pc → server → phone, set by encode_result_payload):
    [12 bytes]   IV
    [remaining]  ciphertext
"""

import base64
import json
import os
import struct
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ec import (
    ECDH,
    EllipticCurvePublicKey,
    SECP256R1,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from config import PRIVATE_KEY_PATH, PUBLIC_KEY_PATH

MAX_PROMPT_LEN = 4_000  # characters; enforces the same limit as the client textarea


# ── Keypair loading ────────────────────────────────────────────────────────────

def load_private_key():
    """Load the PC's static P-256 private key from disk."""
    pem = Path(PRIVATE_KEY_PATH).read_bytes()
    return serialization.load_pem_private_key(pem, password=None)


def load_public_key_b64() -> str:
    """
    Load the PC's static P-256 public key and return it as a base64-encoded
    SPKI DER blob — ready to be sent to the server for caching.
    """
    pem = Path(PUBLIC_KEY_PATH).read_bytes()
    pub_key = serialization.load_pem_public_key(pem)
    der = pub_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return base64.b64encode(der).decode()


# ── Key derivation ─────────────────────────────────────────────────────────────

def _derive_aes_key(private_key, peer_public_key: EllipticCurvePublicKey) -> bytes:
    """
    ECDH + HKDF-SHA-256 → 32-byte AES-256-GCM key.
    Mirrors deriveAESKey() in crypto.js exactly (same salt, same info string).
    """
    shared_secret = private_key.exchange(ECDH(), peer_public_key)

    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=bytes(32),                          # fixed zero salt — matches JS side
        info=b"flux2-klein-v1",                    # matches JS side
    )
    return hkdf.derive(shared_secret)


# ── Payload decoding ───────────────────────────────────────────────────────────

def decode_job_payload(b64_payload: str) -> tuple[bytes, bytes, bytes]:
    """
    Decode the job payload base64 string sent by the phone.

    Returns:
        (eph_pub_key_der, iv, ciphertext)
    """
    raw = base64.b64decode(b64_payload)
    key_len = struct.unpack(">H", raw[:2])[0]           # big-endian uint16
    eph_pub_der = raw[2 : 2 + key_len]
    iv = raw[2 + key_len : 2 + key_len + 12]
    ciphertext = raw[2 + key_len + 12 :]
    return eph_pub_der, iv, ciphertext


def encode_result_payload(iv: bytes, ciphertext: bytes) -> str:
    """
    Pack the result into the wire format the browser expects:
        [12 bytes IV] + [ciphertext]
    Returns base64 string.
    """
    return base64.b64encode(iv + ciphertext).decode()


# ── High-level helpers ─────────────────────────────────────────────────────────

def decrypt_job(b64_payload: str) -> tuple[dict, bytes]:
    """
    Decrypt a job payload from the phone.

    Returns:
        (job_params, aes_key_bytes)

        job_params keys:
            prompt        (str)
            image1        (bytes | None) — first input image, or None
            image2        (bytes | None) — second input image, or None
            seed          (int)
            steps         (int, clamped 1-8)
            sampler       (str)
            lora          (str | None)
            loraStrength  (float)
            quantization  (str | None) — full GGUF filename, e.g. "flux-2-klein-9b-Q8_0.gguf"

        aes_key_bytes is kept so the result can be encrypted with the same key.

    Raises:
        Exception if decryption or parsing fails.
    """
    private_key = load_private_key()

    eph_pub_der, iv, ciphertext = decode_job_payload(b64_payload)

    # Load ephemeral public key from SPKI DER
    eph_pub_key = serialization.load_der_public_key(eph_pub_der)

    # Derive the same AES key the phone used
    aes_key_bytes = _derive_aes_key(private_key, eph_pub_key)

    # Decrypt — AESGCM.decrypt raises InvalidTag on authentication failure
    aesgcm = AESGCM(aes_key_bytes)
    plaintext = aesgcm.decrypt(iv, ciphertext, None)

    # Plaintext is JSON: { "prompt", "image1", "image2", "seed", "steps", "sampler" }
    data = json.loads(plaintext.decode())

    def _decode_image(field: str) -> bytes | None:
        val = data.get(field)
        return base64.b64decode(val) if val else None

    job_params = {
        "prompt":       data["prompt"],
        "image1":       _decode_image("image1"),
        "image2":       _decode_image("image2"),
        "seed":         max(0, min(2**53 - 1, int(data.get("seed", 0)))),
        "steps":        max(1, min(8, int(data.get("steps", 4)))),
        "sampler":      data.get("sampler", "euler"),
        "lora":         data.get("lora"),
        "loraStrength": max(0.0, min(2.0, float(data.get("loraStrength", 1.0)))),
        "quantization": data.get("quantization"),
        "clipModel":    data.get("clipModel"),
    }

    if len(job_params["prompt"]) > MAX_PROMPT_LEN:
        raise ValueError(f"Prompt too long (max {MAX_PROMPT_LEN} characters)")

    return job_params, aes_key_bytes


def encrypt_result(aes_key_bytes: bytes, result_image_bytes: bytes) -> str:
    """
    Encrypt the result image bytes with the same AES key used for the job.

    Returns:
        base64 string in wire format [iv + ciphertext] expected by the phone.
    """
    iv = os.urandom(12)
    aesgcm = AESGCM(aes_key_bytes)
    ciphertext = aesgcm.encrypt(iv, result_image_bytes, None)
    return encode_result_payload(iv, ciphertext)
