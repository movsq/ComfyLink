"""
comfyui.py — Real ComfyUI integration for the Flux2 Klein 9B GGUF workflow.

Loads workflow_template.json once at startup, patches it per-job (prompt,
images, seed, steps, sampler), submits it to the local ComfyUI HTTP API,
waits for completion via WebSocket, then downloads and returns the output
image bytes.

Images are uploaded to ComfyUI's input directory via POST /upload/image
before the prompt is queued. Each upload uses a UUID-prefixed filename to
avoid collisions between concurrent jobs. The native LoadImage nodes (177/178)
then reference those filenames instead of embedding base64 data.

Workflow image-count modes
--------------------------
  2 images  — both uploaded; nodes 177 + 178 reference their filenames
  1 image   — image1 uploaded; image2 chain (nodes 178/133/159/161/118)
              and the node 156 image2 ref are removed
  0 images  — all image nodes removed; latent size hardcoded to 1024×1024
"""

import asyncio
import copy
import json
import logging
import uuid
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
import websockets

from config import COMFYUI_URL

log = logging.getLogger(__name__)

_TEMPLATE_PATH = Path(__file__).parent / "workflow_template.json"
_WORKFLOW_TEMPLATE: dict = json.loads(_TEMPLATE_PATH.read_text())


# ── Workflow construction ──────────────────────────────────────────────────────

def _build_workflow(
    prompt: str,
    image1_name: str | None,
    image2_name: str | None,
    seed: int,
    steps: int,
    sampler: str,
) -> dict:
    """
    Deep-copy the template and inject job-specific parameters.
    image1_name / image2_name are filenames already uploaded to ComfyUI's
    input directory. Nodes not needed for the given image count are pruned.
    """
    wf = copy.deepcopy(_WORKFLOW_TEMPLATE)
    num_images = (1 if image1_name else 0) + (1 if image2_name else 0)

    # ── Scalar params (always) ─────────────────────────────────────────────────
    wf["99"]["inputs"]["sampler_name"] = sampler
    wf["102"]["inputs"]["noise_seed"] = seed
    wf["109"]["inputs"]["steps"] = steps
    wf["156"]["inputs"]["prompt"] = prompt
    wf["156"]["inputs"]["max_images_allowed"] = str(num_images)

    # ── Image filename injection + node pruning ────────────────────────────────
    if num_images == 2:
        wf["177"]["inputs"]["image"] = image1_name
        wf["178"]["inputs"]["image"] = image2_name

    elif num_images == 1:
        wf["177"]["inputs"]["image"] = image1_name or image2_name
        # Remove the image2 input chain and the comparison/concat nodes that depend on it
        for nid in ("178", "133", "159", "161", "118"):
            wf.pop(nid, None)
        wf["156"]["inputs"].pop("image2", None)
        # Node 119 (Image Comparer: image_a=["115",0], image_b=["101",0]) stays valid

    else:  # 0 images — pure text generation
        for nid in ("177", "178", "133", "115", "159", "161", "118", "119"):
            wf.pop(nid, None)
        # Hardcode latent size since the image-derived size nodes are gone
        wf["106"]["inputs"]["width"] = 1024
        wf["106"]["inputs"]["height"] = 1024
        wf["109"]["inputs"]["width"] = 1024
        wf["109"]["inputs"]["height"] = 1024
        wf["156"]["inputs"].pop("image1", None)
        wf["156"]["inputs"].pop("image2", None)

    return wf


async def _upload_image(
    session: aiohttp.ClientSession,
    image_bytes: bytes,
    filename: str,
) -> str:
    """
    Upload image bytes to ComfyUI's input directory.
    Returns the server-confirmed filename to use in the workflow.
    """
    form = aiohttp.FormData()
    form.add_field(
        "image",
        image_bytes,
        filename=filename,
        content_type="image/png",
    )
    form.add_field("overwrite", "true")
    async with session.post(f"{COMFYUI_URL}/upload/image", data=form) as resp:
        if resp.status != 200:
            body = await resp.text()
            raise RuntimeError(
                f"ComfyUI /upload/image failed (HTTP {resp.status}): {body}"
            )
        result = await resp.json()
    confirmed = result.get("name")
    if not confirmed:
        raise RuntimeError(
            f"ComfyUI /upload/image returned unexpected response: {result}"
        )
    log.info(f"[comfyui] Uploaded {filename!r} → confirmed as {confirmed!r}")
    return confirmed


# ── ComfyUI API communication ──────────────────────────────────────────────────

async def process_job(
    prompt: str,
    image1: bytes | None,
    image2: bytes | None,
    seed: int,
    steps: int,
    sampler: str,
    progress_callback=None,
) -> bytes:
    """
    Submit a job to the local ComfyUI instance and return the output image bytes.

    Flow:
      1. POST /prompt  →  prompt_id
      2. WebSocket /ws  →  wait for executing{node: null} (done) or execution_error
      3. GET /history/{prompt_id}  →  output filename from node "117"
      4. GET /view?filename=...  →  raw image bytes
    """
    client_id = str(uuid.uuid4())

    parsed = urlparse(COMFYUI_URL)
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    ws_url = f"{ws_scheme}://{parsed.netloc}/ws?clientId={client_id}"

    num_images = (1 if image1 else 0) + (1 if image2 else 0)
    log.info(
        f"[comfyui] Submitting: images={num_images}, seed={seed}, "
        f"steps={steps}, sampler={sampler!r}"
    )

    async with aiohttp.ClientSession() as session:
        # ── Step 0: Upload images to ComfyUI input directory ──────────────────
        image1_name: str | None = None
        image2_name: str | None = None
        if image1:
            image1_name = await _upload_image(
                session, image1, f"{client_id}_1.png"
            )
        if image2:
            image2_name = await _upload_image(
                session, image2, f"{client_id}_2.png"
            )

        workflow = _build_workflow(
            prompt, image1_name, image2_name, seed, steps, sampler
        )

        # ── Step 1: POST /prompt ───────────────────────────────────────────────
        async with session.post(
            f"{COMFYUI_URL}/prompt",
            json={"prompt": workflow, "client_id": client_id},
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise RuntimeError(
                    f"ComfyUI /prompt rejected (HTTP {resp.status}): {body}"
                )
            data = await resp.json()
            if "error" in data or "prompt_id" not in data:
                node_errors = data.get("node_errors", {})
                error_detail = data.get("error", {})
                node_msgs = []
                for nid, nerr in node_errors.items():
                    cls = nerr.get("class_type", nid)
                    for e in nerr.get("errors", []):
                        node_msgs.append(f"  node {nid} ({cls}): {e.get('message','?')} — {e.get('details','')}")
                detail = "\n".join(node_msgs) if node_msgs else str(error_detail)
                raise RuntimeError(
                    f"ComfyUI /prompt validation error:\n{detail}\n\nFull response: {json.dumps(data)}"
                )
            prompt_id: str = data["prompt_id"]

        log.info(f"[comfyui] Queued as prompt_id={prompt_id}")

        # ── Step 2: WebSocket — wait for execution to finish ───────────────────
        async with websockets.connect(ws_url) as ws_conn:
            while True:
                raw = await ws_conn.recv()
                if isinstance(raw, bytes):
                    continue  # binary preview frames — ignore
                msg = json.loads(raw)
                mtype = msg.get("type")
                if mtype == "progress":
                    d = msg.get("data", {})
                    if progress_callback:
                        try:
                            await progress_callback(
                                d.get("value", 0),
                                d.get("max", 1),
                                d.get("node"),
                            )
                        except Exception:
                            pass  # never let progress reporting crash the job
                elif mtype == "executing":
                    d = msg.get("data", {})
                    if d.get("prompt_id") == prompt_id and d.get("node") is None:
                        log.info("[comfyui] Execution complete.")
                        break
                elif mtype == "execution_error":
                    d = msg.get("data", {})
                    if d.get("prompt_id") == prompt_id:
                        raise RuntimeError(
                            f"ComfyUI execution error: "
                            f"{d.get('exception_message', 'unknown error')}"
                        )

        # ── Step 3: GET /history → find output image filename ──────────────────
        async with session.get(f"{COMFYUI_URL}/history/{prompt_id}") as resp:
            history = await resp.json()

        outputs = history.get(prompt_id, {}).get("outputs", {})
        node_out = outputs.get("117")
        if not node_out or not node_out.get("images"):
            raise RuntimeError(
                "ComfyUI returned no images in history for output node 117"
            )

        img_info = node_out["images"][0]
        filename = img_info["filename"]
        subfolder = img_info.get("subfolder", "")
        img_type = img_info.get("type", "temp")

        log.info(f"[comfyui] Output: {filename} (type={img_type})")

        # ── Step 4: GET /view → download image bytes ───────────────────────────
        params = {"filename": filename, "subfolder": subfolder, "type": img_type}
        async with session.get(f"{COMFYUI_URL}/view", params=params) as resp:
            if resp.status != 200:
                raise RuntimeError(
                    f"ComfyUI /view returned HTTP {resp.status} for {filename}"
                )
            image_bytes = await resp.read()

    log.info(f"[comfyui] Downloaded {len(image_bytes):,} bytes.")
    return image_bytes
