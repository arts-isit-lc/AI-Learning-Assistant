"""Fit extracted images to what the vision models can actually use.

Two limits apply to every image the pipeline keeps:

- **Bytes:** Bedrock rejects an image whose base64 encoding is over 5 MB
  ("image exceeds 5 MB maximum", seen in prod enrichment logs), so the raw image
  must be at most 3,932,160 bytes.
- **Pixels:** Claude Haiku 4.5 and Sonnet 4.5, the vision models used by
  enrichment and chat image escalation, read at most 1568 px on the long edge and
  downscale anything larger. Extra pixels add nothing but memory.

Keeping full-resolution images ran the ingestion Lambda out of memory: a 140 MB
PDF with 7 photos extracted to ~125 MB of PNG (CLAUDE_HISTORY.md, 2026-11-24).

Re-encoded images are always PNG. Images are stored at ``{element_id}.png`` and
image escalation derives the media type from that extension.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from aws_lambda_powertools import Logger

try:
    from PIL import Image
except ImportError:  # local test environments without the image dependencies
    Image = None  # type: ignore[assignment]

logger = Logger(service="multimodal-rag-ingestion")

# Long-edge resolution of the vision models in use (Haiku 4.5 / Sonnet 4.5).
# Newer high-resolution models read up to 2576 px; raise this together with a
# model change if the extra detail is wanted (stored images are re-derived only
# when a file is re-ingested).
MAX_LONG_EDGE_PX = 1568

# Bedrock's limit applies to the base64 string; base64 is 4 bytes per 3.
_BEDROCK_MAX_BASE64_BYTES = 5 * 1024 * 1024
MAX_IMAGE_BYTES = _BEDROCK_MAX_BASE64_BYTES // 4 * 3

# Downscale passes allowed when the PNG is still over MAX_IMAGE_BYTES (noisy
# photos compress poorly). Each pass shrinks by at least 10%.
_MAX_SHRINK_PASSES = 8


@dataclass(frozen=True)
class FittedImage:
    """An image that fits the limits (or the original, if it already did)."""

    content: bytes
    width: int
    height: int
    resized: bool  # True when the pixels were scaled down


def fit_image(image_bytes: bytes, *, force_png: bool = False) -> FittedImage | None:
    """Downscale and re-encode an image so it fits the vision limits.

    An image already within the limits is returned unchanged without being
    decoded, unless ``force_png`` asks for PNG and it isn't one. Never raises.

    Args:
        image_bytes: Encoded image in any format Pillow can read.
        force_png: Always return PNG bytes (the PDF adapter's convention).

    Returns:
        The fitted image, or None when Pillow can't decode the bytes (the
        caller keeps its own fallback).
    """
    if Image is None:
        return None
    try:
        img = Image.open(io.BytesIO(image_bytes))
        src_w, src_h = img.size
        already_png = img.format == "PNG"
        if (
            max(src_w, src_h) <= MAX_LONG_EDGE_PX
            and len(image_bytes) <= MAX_IMAGE_BYTES
            and (already_png or not force_png)
        ):
            return FittedImage(image_bytes, src_w, src_h, resized=False)

        # Resampling a palette or bilevel image falls back to nearest-neighbour,
        # so expand it first.
        if img.mode == "P":
            img = img.convert("RGBA" if "transparency" in img.info else "RGB")
        elif img.mode == "1":
            img = img.convert("L")

        # thumbnail() keeps the aspect ratio, only ever shrinks, and lets the
        # JPEG decoder skip detail it will throw away (draft mode), so a large
        # photo is never fully decoded at its source resolution.
        img.thumbnail((MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX), Image.Resampling.LANCZOS)
        if img.mode not in ("RGB", "RGBA", "L", "LA"):
            img = img.convert("RGB")  # CMYK, YCbCr, 16-bit, etc.

        png = _encode_png(img)
        passes = 0
        while len(png) > MAX_IMAGE_BYTES and passes < _MAX_SHRINK_PASSES:
            # PNG size scales roughly with pixel count.
            scale = min(0.9, max(0.5, (MAX_IMAGE_BYTES / len(png)) ** 0.5 * 0.95))
            img = img.resize(
                (max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                Image.Resampling.LANCZOS,
            )
            png = _encode_png(img)
            passes += 1

        if len(png) > MAX_IMAGE_BYTES:
            logger.warning(
                "Image still over the vision size limit after downscaling",
                extra={"png_bytes": len(png), "width": img.width, "height": img.height},
            )

        resized = img.size != (src_w, src_h)
        if resized:
            logger.info(
                "Image downscaled for vision limits",
                extra={
                    "source_width": src_w,
                    "source_height": src_h,
                    "source_bytes": len(image_bytes),
                    "width": img.width,
                    "height": img.height,
                    "png_bytes": len(png),
                },
            )
        return FittedImage(png, img.width, img.height, resized=resized)
    except Exception as exc:  # undecodable, truncated, decompression bomb, ...
        logger.warning(
            "Could not decode image to fit it, keeping it as extracted",
            extra={"error_type": type(exc).__name__, "source_bytes": len(image_bytes)},
        )
        return None


def _encode_png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
