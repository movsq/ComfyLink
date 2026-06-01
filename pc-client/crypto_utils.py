"""
crypto_utils.py — PC-side E2E encryption/decryption.

Mirrors the browser-side crypto.js logic, using the `cryptography` library.

Algorithm:
    Key exchange:  ECDH with P-256 (matches WebCrypto on the phone)
    Symmetric:     AES-256-GCM (separate keys per direction)
    Key derivation: HKDF-SHA-256 from the ECDH shared secret, two outputs:
        info="flux2-klein-v1:job"    → phone→PC payload key
        info="flux2-klein-v1:result" → PC→phone result key

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

from config import PRIVATE_KEY_PATH, PRIVATE_KEY_PASSWORD, PUBLIC_KEY_PATH
from job_validation import validate_seed, validate_steps

MAX_PROMPT_LEN = 4_000  # characters; enforces the same limit as the client textarea


# ── Keypair loading ────────────────────────────────────────────────────────────

_private_key_cache = None  # loaded once on first use to avoid repeated disk I/O


def load_private_key(password: bytes | None = None):
    """
    Load the PC's static P-256 private key from disk.

    The result is cached after the first successful load so subsequent calls
    (e.g. per-job decryption) skip the disk read + DER parse entirely.

    If ``password`` is not supplied, falls back to PRIVATE_KEY_PASSWORD from
    config (set via the PC_PRIVATE_KEY_PASSWORD env var). This is what keygen.py
    asks for at key creation time — without this wiring the prompt was a no-op
    and any passphrase-protected key would fail to load.
    """
    global _private_key_cache
    if _private_key_cache is None:
        if password is None:
            password = PRIVATE_KEY_PASSWORD
        pem = Path(PRIVATE_KEY_PATH).read_bytes()
        try:
            _private_key_cache = serialization.load_pem_private_key(pem, password=password)
        except TypeError as exc:
            # cryptography raises TypeError when the password is None for an
            # encrypted key, or non-None for an unencrypted one.
            raise RuntimeError(
                "Could not load the PC private key. If it is passphrase-protected, "
                "set PC_PRIVATE_KEY_PASSWORD in .env. If it is not, leave that "
                "variable unset."
            ) from exc
    return _private_key_cache


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

_HKDF_SALT = bytes(32)  # fixed zero salt — matches JS side
_HKDF_INFO_JOB    = b"flux2-klein-v1:job"
_HKDF_INFO_RESULT = b"flux2-klein-v1:result"


def _derive_session_keys(
    private_key,
    peer_public_key: EllipticCurvePublicKey,
) -> tuple[bytes, bytes]:
    """
    ECDH + HKDF-SHA-256 → (job_key, result_key), 32 bytes each.

    Two separate keys instead of one shared key: the phone uses job_key to
    encrypt the payload sent to the PC, and result_key to decrypt the image
    the PC sends back. Keeping the directions on separate keys is textbook
    practice for AES-GCM channels and makes it harder to confuse roles if the
    wire format ever gains associated data per direction. Mirrors
    deriveSessionKeys() on the browser side — both halves must agree on the
    salt and info strings.
    """
    shared_secret = private_key.exchange(ECDH(), peer_public_key)

    job_key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_HKDF_SALT,
        info=_HKDF_INFO_JOB,
    ).derive(shared_secret)
    result_key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_HKDF_SALT,
        info=_HKDF_INFO_RESULT,
    ).derive(shared_secret)
    return job_key, result_key


# ── Payload decoding ───────────────────────────────────────────────────────────

def decode_job_payload(b64_payload: str) -> tuple[bytes, bytes, bytes]:
    """
    Decode the job payload base64 string sent by the phone.

    Returns:
        (eph_pub_key_der, iv, ciphertext)

    Raises ValueError on malformed payloads (header too short, length field
    larger than the remaining buffer, no room for IV + ciphertext).
    """
    raw = base64.b64decode(b64_payload)
    # 2-byte length + at least 1 byte of key + 12 bytes IV + at least 16 bytes
    # for the AES-GCM tag (no plaintext) is the absolute minimum.
    if len(raw) < 2 + 1 + 12 + 16:
        raise ValueError("Job payload too short")
    key_len = struct.unpack(">H", raw[:2])[0]           # big-endian uint16
    # SPKI for a P-256 public key is 91 bytes; cap at 256 to leave slack for
    # any future curve while still rejecting obvious garbage.
    if key_len == 0 or key_len > 256:
        raise ValueError(f"Invalid ephemeral key length: {key_len}")
    if 2 + key_len + 12 + 16 > len(raw):
        raise ValueError("Job payload truncated")
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
        (job_params, result_aes_key)

        job_params keys:
            prompt        (str)
            image1        (bytes | None) — first input image, or None
            image2        (bytes | None) — second input image, or None
            seed          (int)
            steps         (int, 1-8)
            sampler       (str)
            lora          (str | None)
            loraStrength  (float)
            quantization  (str | None) — full GGUF filename, e.g. "flux-2-klein-9b-Q8_0.gguf"

        result_aes_key is the second HKDF output — the *result* direction key,
        which the caller passes to encrypt_result() to encrypt the image
        sent back to the phone.

    Raises:
        Exception if decryption or parsing fails.
    """
    private_key = load_private_key()

    eph_pub_der, iv, ciphertext = decode_job_payload(b64_payload)

    # Load ephemeral public key from SPKI DER
    eph_pub_key = serialization.load_der_public_key(eph_pub_der)

    # Derive both direction keys; the phone encrypted the payload with job_key.
    job_key, result_key = _derive_session_keys(private_key, eph_pub_key)

    # Decrypt — AESGCM.decrypt raises InvalidTag on authentication failure
    aesgcm = AESGCM(job_key)
    plaintext = aesgcm.decrypt(iv, ciphertext, None)

    # Plaintext is JSON: { "prompt", "image1", "image2", "seed", "steps", "sampler" }
    data = json.loads(plaintext.decode())

    def _decode_image(field: str) -> bytes | None:
        val = data.get(field)
        return base64.b64decode(val) if val else None

    seed = validate_seed(data.get("seed", 0))
    steps = validate_steps(data.get("steps", 4))

    job_params = {
        "prompt":       data["prompt"],
        "image1":       _decode_image("image1"),
        "image2":       _decode_image("image2"),
        "seed":         seed,
        "steps":        steps,
        "sampler":      data.get("sampler", "euler"),
        "lora":         data.get("lora"),
        "loraStrength": max(0.0, min(2.0, float(data.get("loraStrength", 1.0)))),
        "quantization": data.get("quantization"),
        "clipModel":    data.get("clipModel"),
    }

    if len(job_params["prompt"]) > MAX_PROMPT_LEN:
        raise ValueError(f"Prompt too long (max {MAX_PROMPT_LEN} characters)")

    return job_params, result_key


def encrypt_result(result_aes_key: bytes, result_image_bytes: bytes) -> str:
    """
    Encrypt the result image bytes with the result-direction AES key returned
    by decrypt_job().

    Returns:
        base64 string in wire format [iv + ciphertext] expected by the phone.
    """
    iv = os.urandom(12)
    aesgcm = AESGCM(result_aes_key)
    ciphertext = aesgcm.encrypt(iv, result_image_bytes, None)
    return encode_result_payload(iv, ciphertext)
