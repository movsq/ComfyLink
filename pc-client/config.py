import os
from pathlib import Path

# Load the shared root .env (projectroot/.env) so a single file configures
# server, pc-client, and the Vite frontend all at once.
# python-dotenv is a soft dependency: if not installed, env vars from the
# shell / CI environment are still used normally.
try:
    from dotenv import load_dotenv
    _root_env = Path(__file__).parent.parent / ".env"
    load_dotenv(_root_env, override=False)  # shell env takes precedence
except ImportError:
    pass  # dotenv not installed — rely on env vars set in the shell

# ── Deployment mode ────────────────────────────────────────────────────────────
# "local"  → connect to ws://localhost:PORT  (for local dev)
# "remote" → connect to wss://COMFYLINK_HOST  (for VPS / Tailscale)
_MODE: str = os.environ.get("DEPLOY_MODE", "local")
_PORT: str = os.environ.get("PORT", "3000")
_HOST: str = os.environ.get("COMFYLINK_HOST", "")

# VPS_URL can also be set directly to override the DEPLOY_MODE logic entirely.
_VPS_URL_OVERRIDE: str = os.environ.get("VPS_URL", "")

if _VPS_URL_OVERRIDE:
    VPS_URL: str = _VPS_URL_OVERRIDE
elif _MODE == "remote":
    if not _HOST:
        raise RuntimeError(
            "COMFYLINK_HOST must be set in .env when DEPLOY_MODE=remote"
        )
    VPS_URL = f"wss://{_HOST}"
else:  # local
    VPS_URL = f"ws://localhost:{_PORT}"

# The PIN that matches the PIN set on the server.
PIN: str = os.environ.get("PIN", "changeme")

# ── TLS verification ───────────────────────────────────────────────────────────
# Set SKIP_TLS_VERIFY=true in .env for Tailscale self-signed certs.
# Leave false for public domains with proper Let's Encrypt certs.
SKIP_TLS_VERIFY: bool = os.environ.get("SKIP_TLS_VERIFY", "false").lower() == "true"

# ── Keypair paths ──────────────────────────────────────────────────────────────
# Generated once by: python keygen.py  — back up private_key.pem!
PRIVATE_KEY_PATH: str = os.environ.get("PRIVATE_KEY_PATH", "private_key.pem")
PUBLIC_KEY_PATH: str = os.environ.get("PUBLIC_KEY_PATH", "public_key.pem")

# ── Reconnect ──────────────────────────────────────────────────────────────────
RECONNECT_DELAY: float = float(os.environ.get("RECONNECT_DELAY", "5"))

# ── ComfyUI ────────────────────────────────────────────────────────────────────
COMFYUI_URL: str = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
