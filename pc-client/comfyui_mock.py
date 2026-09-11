"""
comfyui_mock.py — Mock ComfyUI job processor (no GPU required).

Drop-in stand-in for `comfyui.py` for UI testing without ComfyUI installed.
In `main.py`, change

    from comfyui import process_job, interrupt_comfyui, generate_thumbnail
to
    from comfyui_mock import process_job, interrupt_comfyui, generate_thumbnail

This module therefore mirrors `comfyui.py`'s public surface exactly —
`process_job` takes the same keyword arguments, and `interrupt_comfyui` /
`generate_thumbnail` exist so the import above resolves.

The mock:
  - Waits a random delay to simulate GPU processing time (2–5 seconds)
  - Returns a slightly modified version of image1 (tinted purple), or image1
    unchanged if it isn't a simple PNG, so you can verify the full encrypted
    round-trip is working
  - Ignores seed / sampler / LoRA / model selection entirely; `steps` is used
    only to pace the fake progress callbacks
  - Never logs prompt text: this is the one module that could, and it must not
    become the default path.
"""

import asyncio
import io
import random
import struct


async def process_job(
    prompt: str,
    image1: bytes | None,
    image2: bytes | None,
    seed: int,
    steps: int,
    sampler: str,
    progress_callback=None,
    lora: str | None = None,
    lora_strength: float = 1.0,
    gguf_name: str | None = None,
    clip_model: str | None = None,
) -> bytes:
    """
    Mock job processor. Returns a placeholder image after a fake delay.

    Signature mirrors comfyui.process_job so the two are interchangeable.
    Only image1 is used; the generation parameters are accepted and ignored.

    Returns:
        Raw image bytes of the "result" (mock: image1 tinted purple)
    """
    delay = random.uniform(2.0, 5.0)
    print(f"[mock] Processing job (prompt: ***, steps: {steps}, delay: {delay:.1f}s)…")

    # Fake a progress bar so the phone's UI path is exercised too
    if progress_callback:
        for step in range(1, steps + 1):
            await asyncio.sleep(delay / max(steps, 1))
            try:
                await progress_callback(step, steps, "mock")
            except Exception:
                pass  # never let progress reporting crash the job
    else:
        await asyncio.sleep(delay)

    result_bytes = _tint_image(image1) if image1 else _placeholder_png()
    print(f"[mock] Job done. Returning {len(result_bytes)} bytes.")
    return result_bytes


def _placeholder_png() -> bytes:
    """Solid purple PNG for text-only jobs, where there is no input to tint."""
    from PIL import Image  # local import — see generate_thumbnail

    buf = io.BytesIO()
    Image.new("RGB", (768, 768), (128, 0, 255)).save(buf, format="PNG")
    return buf.getvalue()


async def interrupt_comfyui() -> None:
    """No-op stand-in for comfyui.interrupt_comfyui — nothing to interrupt."""
    print("[mock] Interrupt requested (no-op).")


def generate_thumbnail(image_bytes: bytes, max_width: int = 200) -> bytes:
    """
    Mirror of comfyui.generate_thumbnail: 200px-wide WebP from raw image bytes.

    Pillow is imported lazily so the rest of this module stays dependency-free;
    if it is unavailable the caller treats the failure as non-fatal and simply
    sends no thumbnail.
    """
    from PIL import Image  # local import — keeps the module importable without Pillow

    img = Image.open(io.BytesIO(image_bytes))
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    img.thumbnail((max_width, max_width), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=75)
    return buf.getvalue()


def _tint_image(image_bytes: bytes) -> bytes:
    """
    Apply a purple tint to a PNG image without external libraries.
    Falls back to returning the original bytes unchanged if the image
    isn't a simple RGB/RGBA PNG (e.g. it's a JPEG).

    This is intentionally kept dependency-free. When you add Pillow or
    similar for the real ComfyUI integration, you can improve this.
    """
    try:
        return _tint_png(image_bytes)
    except Exception:
        # Not a PNG or too complex — just echo the image back unchanged
        return image_bytes


def _tint_png(data: bytes) -> bytes:
    """
    Minimal PNG parser that applies a 50% purple tint to RGB/RGBA pixels.
    Only handles non-interlaced PNGs with bit depth 8.
    Raises ValueError for unsupported formats (caller catches and falls back).
    """
    import zlib

    PNG_SIG = b"\x89PNG\r\n\x1a\n"
    if data[:8] != PNG_SIG:
        raise ValueError("Not a PNG")

    pos = 8
    chunks = []
    ihdr = None

    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        chunk_type = data[pos + 4 : pos + 8]
        chunk_data = data[pos + 8 : pos + 8 + length]
        chunks.append((chunk_type, chunk_data))
        if chunk_type == b"IHDR":
            ihdr = chunk_data
        pos += 12 + length

    if ihdr is None:
        raise ValueError("No IHDR chunk")

    width = struct.unpack(">I", ihdr[0:4])[0]
    height = struct.unpack(">I", ihdr[4:8])[0]
    bit_depth = ihdr[8]
    color_type = ihdr[9]
    interlace = ihdr[12]

    if bit_depth != 8 or interlace != 0:
        raise ValueError("Unsupported PNG variant")

    if color_type == 2:
        channels = 3  # RGB
    elif color_type == 6:
        channels = 4  # RGBA
    else:
        raise ValueError(f"Unsupported color type: {color_type}")

    # Decompress IDAT data
    raw = zlib.decompress(
        b"".join(d for t, d in chunks if t == b"IDAT")
    )

    stride = width * channels
    scanlines = []
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        row = bytearray(raw[offset + 1 : offset + 1 + stride])
        offset += 1 + stride

        # Only handle filter type 0 (None) for simplicity
        if filter_type != 0:
            raise ValueError(f"Unsupported PNG filter type: {filter_type}")

        # Apply purple tint: blend each pixel 50% toward (128, 0, 255)
        for x in range(width):
            px = x * channels
            row[px]     = (row[px]     + 128) // 2   # R → purple-ish
            row[px + 1] = (row[px + 1] + 0)   // 2   # G
            row[px + 2] = (row[px + 2] + 255) // 2   # B
            # Alpha channel (if present) is left untouched

        scanlines.append(bytes([0]) + bytes(row))

    new_raw = zlib.compress(b"".join(scanlines))

    # Rebuild PNG
    def make_chunk(chunk_type: bytes, chunk_data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
        return (
            struct.pack(">I", len(chunk_data))
            + chunk_type
            + chunk_data
            + struct.pack(">I", crc)
        )

    out = bytearray(PNG_SIG)
    for t, d in chunks:
        if t == b"IDAT":
            continue  # skip original IDATs
        if t == b"IEND":
            out += make_chunk(b"IDAT", new_raw)
        out += make_chunk(t, d)

    return bytes(out)
