import logging
import os
from pathlib import Path

_log = logging.getLogger(__name__)

# Load the shared root .env (projectroot/.env) so a single file configures
# server, pc-client, and the Vite frontend all at once.
# python-dotenv is a soft dependency: if not installed, env vars from the
# shell / CI environment are still used normally.
try:
    from dotenv import load_dotenv
    _root_env = Path(__file__).resolve().parent.parent / ".env"
    if not load_dotenv(_root_env, override=False):
        _log.warning("Could not load .env at %s — using shell env / defaults", _root_env)
except ImportError:
    _log.warning("python-dotenv not installed — using shell env / defaults")

# ── Deployment mode ────────────────────────────────────────────────────────────
# "local"  → connect to ws://localhost:PORT  (for local dev)
# "remote" → connect to wss://FLUX_KLEIN_HOST  (for VPS / Tailscale)
_MODE: str = os.environ.get("DEPLOY_MODE", "local")
_PORT: str = os.environ.get("PORT", "3000")
_HOST: str = os.environ.get("FLUX_KLEIN_HOST", "")

# VPS_URL can also be set directly to override the DEPLOY_MODE logic entirely.
_VPS_URL_OVERRIDE: str = os.environ.get("VPS_URL", "")

if _VPS_URL_OVERRIDE:
    VPS_URL: str = _VPS_URL_OVERRIDE
elif _MODE == "remote":
    if not _HOST:
        raise RuntimeError(
            "FLUX_KLEIN_HOST must be set in .env when DEPLOY_MODE=remote"
        )
    VPS_URL = f"wss://{_HOST}"
else:  # local
    VPS_URL = f"ws://localhost:{_PORT}"

_log.info("VPS_URL resolved to %s (DEPLOY_MODE=%s)", VPS_URL, _MODE)

# The secret that matches PC_SECRET on the server.
PC_SECRET: str = os.environ.get("PC_SECRET", "")
if not PC_SECRET:
    raise RuntimeError("PC_SECRET must be set in .env")

# ── TLS verification ───────────────────────────────────────────────────────────
# Set SKIP_TLS_VERIFY=true in .env for Tailscale self-signed certs.
# Leave false for public domains with proper Let's Encrypt certs.
# Only safe inside an already-authenticated tunnel (Tailscale/WireGuard), never
# on the public internet: with verification off, an active MITM on the wss://
# path reads PC_SECRET in the clear and can impersonate this PC to the relay.
SKIP_TLS_VERIFY: bool = os.environ.get("SKIP_TLS_VERIFY", "false").lower() == "true"

# ── Keypair paths ──────────────────────────────────────────────────────────────
# Generated once by: python keygen.py  — back up private_key.pem!
PRIVATE_KEY_PATH: str = os.environ.get("PRIVATE_KEY_PATH", "private_key.pem")
PUBLIC_KEY_PATH: str = os.environ.get("PUBLIC_KEY_PATH", "public_key.pem")

# Passphrase for the private key, if it was generated with one via keygen.py.
# Leave unset when the key is stored unencrypted. Loaded as bytes because that
# is what cryptography.serialization.load_pem_private_key expects.
_PRIVATE_KEY_PASSWORD_RAW: str = os.environ.get("PC_PRIVATE_KEY_PASSWORD", "")
PRIVATE_KEY_PASSWORD: bytes | None = (
    _PRIVATE_KEY_PASSWORD_RAW.encode() if _PRIVATE_KEY_PASSWORD_RAW else None
)

# ── Reconnect ──────────────────────────────────────────────────────────────────
RECONNECT_DELAY: float = float(os.environ.get("RECONNECT_DELAY", "5"))

# ── ComfyUI ────────────────────────────────────────────────────────────────────
COMFYUI_URL: str = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")

# ── GGUF model selection ───────────────────────────────────────────────────────
GGUF_MODEL: str = os.environ.get("GGUF_MODEL", "flux-2-klein-9b-Q4_K_M.gguf")

# ── ComfyUI input directory ────────────────────────────────────────────────────
# Reference images are decrypted on this machine and uploaded to ComfyUI's
# input/ directory. The pc-client deletes each job's own uploads when the job
# finishes so plaintext source images don't pile up on the GPU machine.
# ComfyUI has no delete-input API, so the deletion is a direct filesystem
# unlink and needs to know where that directory is.
#   COMFYUI_INPUT_DIR — explicit path (wins if set)
#   COMFYUI_PATH      — ComfyUI checkout; its sibling input/ is used if present
# If neither resolves, cleanup is skipped and we warn once at startup.
_COMFYUI_PATH: str = os.environ.get("COMFYUI_PATH", "")
_INPUT_DIR_RAW: str = os.environ.get("COMFYUI_INPUT_DIR", "")
if not _INPUT_DIR_RAW and _COMFYUI_PATH:
    _candidate = Path(_COMFYUI_PATH) / "input"
    if _candidate.is_dir():
        _INPUT_DIR_RAW = str(_candidate)

COMFYUI_INPUT_DIR: str | None = _INPUT_DIR_RAW or None
if COMFYUI_INPUT_DIR and not Path(COMFYUI_INPUT_DIR).is_dir():
    _log.warning(
        "COMFYUI_INPUT_DIR=%s is not a directory — uploaded reference images "
        "will NOT be deleted after each job.",
        COMFYUI_INPUT_DIR,
    )
    COMFYUI_INPUT_DIR = None
elif not COMFYUI_INPUT_DIR:
    _log.warning(
        "COMFYUI_INPUT_DIR is not set — decrypted reference images will be left "
        "in ComfyUI's input/ directory in plaintext. Set COMFYUI_INPUT_DIR (or "
        "COMFYUI_PATH) so the pc-client can delete them after each job."
    )

# ── Model allow-lists ──────────────────────────────────────────────────────────
# Job payloads are end-to-end encrypted, so the relay structurally cannot
# validate the model filenames a client asks for — the pc-client is the only
# enforcement point. Defaults cover everything the client UI offers plus the
# workflow template's own defaults; operators extend them with a
# comma-separated list in the matching env var.
def _env_allow_list(var: str, defaults: tuple[str, ...]) -> set[str]:
    raw = os.environ.get(var, "")
    if not raw:
        return set(defaults)
    return {item.strip() for item in raw.split(",") if item.strip()}


ALLOWED_GGUF: set[str] = _env_allow_list("ALLOWED_GGUF", (
    "flux-2-klein-9b-Q4_K_M.gguf",
    "flux-2-klein-9b-Q5_K_M.gguf",
    "flux-2-klein-9b-Q6_K.gguf",
    "flux-2-klein-9b-Q8_0.gguf",
    "Flux-2-Klein-9B-KV-Q4_K_M.gguf",
    "Flux-2-Klein-9B-KV-Q5_K_M.gguf",
    "Flux-2-Klein-9B-KV-Q6_K.gguf",
))
ALLOWED_CLIP: set[str] = _env_allow_list("ALLOWED_CLIP", (
    "Qwen_Qwen3-8B-Q4_K_M.gguf",
    "Qwen3-8B-Q4_K_M.gguf",
    "Qwen3-8B-Q4_K_M_v2.gguf",
))
ALLOWED_LORA: set[str] = _env_allow_list("ALLOWED_LORA", (
    "lora1.safetensors",
    "lora2.safetensors",
))
