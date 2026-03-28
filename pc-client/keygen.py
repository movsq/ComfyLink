"""
keygen.py — One-time script to generate the PC's static X25519 keypair.

Run once:
    python keygen.py

Outputs:
    private_key.pem  — Keep this safe and local. Never share it.
    public_key.pem   — Share with the server (it serves it to the phone frontend).

The public key is also printed as base64 so you can copy-paste it if needed.
"""

import base64
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ec import (
    generate_private_key,
    SECP256R1,
)
from cryptography.hazmat.primitives import serialization

from config import PRIVATE_KEY_PATH, PUBLIC_KEY_PATH


def main() -> None:
    priv_path = Path(PRIVATE_KEY_PATH)
    pub_path = Path(PUBLIC_KEY_PATH)

    if priv_path.exists() or pub_path.exists():
        print(
            f"[keygen] Key files already exist ({PRIVATE_KEY_PATH}, {PUBLIC_KEY_PATH}).\n"
            "Delete them first if you really want to regenerate."
        )
        return

    # Generate P-256 keypair (matches WebCrypto P-256 / ECDH on the browser side)
    private_key = generate_private_key(SECP256R1())
    public_key = private_key.public_key()

    # Save private key (PEM, no passphrase — add one if you want extra local protection)
    priv_path.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    print(f"[keygen] Private key saved to: {PRIVATE_KEY_PATH}")

    # Save public key (PEM, SPKI format — matches WebCrypto's spki import format)
    pub_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    pub_path.write_bytes(pub_pem)
    print(f"[keygen] Public key saved to:  {PUBLIC_KEY_PATH}")

    # Also print raw SPKI bytes as base64 (this is what gets sent to the server)
    pub_der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    print(f"\n[keygen] Public key (base64 SPKI — sent to server):\n{base64.b64encode(pub_der).decode()}\n")
    print("[keygen] Done. Back up private_key.pem in a safe place.")


if __name__ == "__main__":
    main()
