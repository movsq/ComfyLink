"""
comfyui_mock.py — Mock ComfyUI job processor.

This module stands in for the real ComfyUI integration until you set up
ComfyUI on your PC and are ready to wire it in.

The mock:
  - Accepts image bytes and a prompt string
  - Waits a random delay to simulate GPU processing time (2–5 seconds)
  - Returns a slightly modified version of the input image (tinted purple)
    so you can verify the full encrypted round-trip is working

When you're ready to implement the real ComfyUI integration, replace the
body of `process_job()` with your actual ComfyUI HTTP/WebSocket calls.
The function signature should stay the same:
    async def process_job(image_bytes: bytes, prompt: str) -> bytes

Real implementation will roughly:
  1. POST the workflow JSON to http://127.0.0.1:8188/prompt
  2. Open a WebSocket to ws://127.0.0.1:8188/ws?clientId=<id>
  3. Wait for execution_complete message
  4. GET the output image from http://127.0.0.1:8188/view?filename=...
  5. Return the image bytes
"""

import asyncio
import io
import random
import struct


async def process_job(image_bytes: bytes, prompt: str) -> bytes:
    """
    Mock job processor. Returns a placeholder image after a fake delay.

    Args:
        image_bytes: Raw input image bytes (PNG/JPEG/etc.)
        prompt:      Text prompt (currently unused in the mock)

    Returns:
        Raw image bytes of the "result" (mock: input image tinted purple)
    """
    delay = random.uniform(2.0, 5.0)
    print(f"[mock] Processing job (prompt: {prompt[:60]!r}, delay: {delay:.1f}s)…")
    await asyncio.sleep(delay)

    result_bytes = _tint_image(image_bytes)
    print(f"[mock] Job done. Returning {len(result_bytes)} bytes.")
    return result_bytes


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
