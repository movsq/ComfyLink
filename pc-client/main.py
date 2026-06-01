"""
main.py — PC-side WebSocket client.

Connects outbound to the VPS relay, authenticates with PC_SECRET,
sends the PC's public key, then processes encrypted jobs in a loop.

Run with:
    python main.py

Environment variables (or edit config.py):
    VPS_URL             — e.g. wss://yourdomain.com  (default: ws://localhost:3000)
    PC_SECRET           — must match the PC_SECRET in server/.env
    PRIVATE_KEY_PATH / PUBLIC_KEY_PATH — paths to your keypair PEM files
"""

import asyncio
import base64
import json
import logging
import ssl
import sys

import websockets
from websockets.exceptions import ConnectionClosed

from config import VPS_URL, PC_SECRET, RECONNECT_DELAY, SKIP_TLS_VERIFY
from crypto_utils import load_public_key_b64, decrypt_job, encrypt_result
from comfyui import process_job, interrupt_comfyui, generate_thumbnail

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger(__name__)

WS_URL = f"{VPS_URL}/ws/pc"


class _ReplacedByNewer(Exception):
    """Raised when the server sends close(1000, 'Replaced by new connection').
    Signals that another PC instance has taken over — this process should stop
    reconnecting rather than cascade-kicking the new instance.
    """

# Tracks the currently running job so cancel can target it
_current_job_id: str | None = None
_current_job_cancelled = asyncio.Event()
_job_task: asyncio.Task | None = None


async def run_client() -> None:
    """Connect, authenticate, and process jobs until disconnected."""
    log.info(f"Connecting to {WS_URL} …")

    ssl_ctx = None
    if WS_URL.startswith("wss://"):
        ssl_ctx = ssl.create_default_context()
        if SKIP_TLS_VERIFY:
            # Only for private networks (Tailscale) where WireGuard already
            # encrypts the tunnel and the cert is self-signed.
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

    async with websockets.connect(WS_URL, ssl=ssl_ctx, ping_interval=20, ping_timeout=30, max_size=50 * 1024 * 1024) as ws:
        # ── Step 1: Authenticate ──────────────────────────────────────────────
        await ws.send(json.dumps({"type": "auth", "secret": PC_SECRET}))
        auth_resp = json.loads(await ws.recv())
        
        if auth_resp.get("type") != "auth_ok":
            log.error(f"Auth failed: {auth_resp}")
            return

        log.info("Authenticated.")

        # ── Step 2: Send public key so server can serve it to the phone ───────
        pub_key_b64 = load_public_key_b64()
        await ws.send(json.dumps({"type": "pubkey", "publicKey": pub_key_b64}))
        log.info("Public key sent to server.")

        # ── Step 3: Cancel any orphaned task from a previous connection ─────
        global _job_task
        if _job_task and not _job_task.done():
            _job_task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(_job_task), timeout=2)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            _job_task = None

        # ── Step 4: Job loop ──────────────────────────────────────────────────
        log.info("Waiting for jobs…")
        async for raw in ws:
            await handle_message(ws, raw)

        # Loop exited — log close code/reason so reconnect issues are diagnosable
        close_code   = getattr(ws, 'close_code',   None)
        close_reason = getattr(ws, 'close_reason', '') or ''
        log.info(f"Connection closed cleanly — code={close_code} reason={close_reason!r}")
        if close_code == 1000 and 'replaced' in close_reason.lower():
            raise _ReplacedByNewer()


async def handle_message(ws, raw: str) -> None:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Received non-JSON message, ignoring.")
        return

    msg_type = msg.get("type")

    if msg_type == "job":
        global _job_task
        # Cancel any previous job task before starting a new one
        if _job_task and not _job_task.done():
            _job_task.cancel()
        _job_task = asyncio.create_task(handle_job(ws, msg))
    elif msg_type == "cancel":
        await handle_cancel(msg)
    else:
        log.warning(f"Unhandled message type: {msg_type}")


async def handle_cancel(msg: dict) -> None:
    global _current_job_id
    cancel_id = msg.get("jobId", "")
    if cancel_id and cancel_id == _current_job_id:
        log.info(f"[job {cancel_id}] Cancel requested — interrupting ComfyUI.")
        _current_job_cancelled.set()
        await interrupt_comfyui()
        if _job_task and not _job_task.done():
            _job_task.cancel()
    else:
        log.warning(f"[cancel] No matching running job for {cancel_id}")


async def handle_job(ws, msg: dict) -> None:
    global _current_job_id
    job_id: str = msg.get("jobId", "")
    payload: str = msg.get("payload", "")

    _current_job_id = job_id
    _current_job_cancelled.clear()

    log.info(f"[job {job_id}] Received.")

    try:
        # ── Decrypt ───────────────────────────────────────────────────────────
        # result_aes_key is the result-direction HKDF output; we need it later
        # to encrypt the image we send back to the phone.
        job_params, result_aes_key = decrypt_job(payload)
        log.info(f"[job {job_id}] Decrypted. Prompt: ***")

        async def send_progress(value: int, max_val: int, node: str | None) -> None:
            await ws.send(json.dumps({
                "type": "progress",
                "jobId": job_id,
                "value": value,
                "max": max_val,
                "node": node,
            }))

        # ── Process via ComfyUI ───────────────────────────────────────────────
        result_bytes = await process_job(
            prompt=job_params["prompt"],
            image1=job_params["image1"],
            image2=job_params["image2"],
            seed=job_params["seed"],
            steps=job_params["steps"],
            sampler=job_params["sampler"],
            progress_callback=send_progress,
            lora=job_params.get("lora"),
            lora_strength=job_params.get("loraStrength", 1.0),
            gguf_name=job_params.get("quantization"),
            clip_model=job_params.get("clipModel"),
        )

        if _current_job_cancelled.is_set():
            log.info(f"[job {job_id}] Cancelled — skipping result.")
            return

        # ── Generate thumbnail ────────────────────────────────────────────────
        thumbnail_b64: str | None = None
        try:
            loop = asyncio.get_event_loop()
            thumb_bytes = await loop.run_in_executor(None, generate_thumbnail, result_bytes)
            thumbnail_b64 = base64.b64encode(thumb_bytes).decode()
            log.info(f"[job {job_id}] Thumbnail generated ({len(thumb_bytes):,} bytes).")
        except Exception as exc:
            log.warning(f"[job {job_id}] Thumbnail generation failed (non-fatal): {exc}")

        # ── Encrypt result ────────────────────────────────────────────────────
        encrypted_result = encrypt_result(result_aes_key, result_bytes)

        # ── Send back ─────────────────────────────────────────────────────────
        result_msg: dict = {"type": "result", "jobId": job_id, "payload": encrypted_result}
        if thumbnail_b64:
            result_msg["thumbnail"] = thumbnail_b64
        await ws.send(json.dumps(result_msg))
        log.info(f"[job {job_id}] Result sent.")

    except asyncio.CancelledError:
        log.info(f"[job {job_id}] Task cancelled.")
    except Exception as exc:
        log.exception(f"[job {job_id}] Error processing job: {exc}")
        try:
            # Keep full detail in local logs only; never forward internal error
            # strings (which may contain filesystem paths) over the relay.
            safe_msg = "Job processing failed. Check PC client logs for details."
            await ws.send(json.dumps({"type": "error", "jobId": job_id, "message": safe_msg}))
        except Exception:
            pass  # don't let error reporting crash the client


async def main() -> None:
    while True:
        try:
            await run_client()
        except _ReplacedByNewer:
            log.warning(
                "This PC instance was closed because another PC client connected to the server. "
                "If you didn't intentionally start a second instance, check for duplicate processes "
                "(e.g. two terminals running main.py, or a service manager that didn't stop the old one). "
                "This process will NOT reconnect so the active instance is not disrupted."
            )
            return  # Exit cleanly — the other instance is already running.
        except ConnectionClosed as exc:
            # Also catch the 'replaced' reason when it arrives as an exception
            # rather than a clean for-loop exit (depends on websockets version).
            rcvd = getattr(exc, 'rcvd', None)
            code   = getattr(rcvd, 'code',   None) if rcvd else None
            reason = (getattr(rcvd, 'reason', '') if rcvd else '') or ''
            if code == 1000 and 'replaced' in reason.lower():
                log.warning(
                    "This PC instance was replaced by another PC client. "
                    "If unintentional, check for duplicate processes. Not reconnecting."
                )
                return
            log.warning(f"Connection closed: code={code} reason={reason!r}. Reconnecting in {RECONNECT_DELAY}s…")
        except OSError as exc:
            log.warning(f"Connection error: {exc}. Reconnecting in {RECONNECT_DELAY}s…")
        except Exception as exc:
            log.exception(f"Unexpected error: {exc}. Reconnecting in {RECONNECT_DELAY}s…")

        await asyncio.sleep(RECONNECT_DELAY)


if __name__ == "__main__":
    asyncio.run(main())
