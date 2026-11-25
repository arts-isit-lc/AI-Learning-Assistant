"""Tests for image_fit: images are downscaled to what the vision models can use.

Context: a 140 MB PDF whose 7 photos extracted to ~125 MB of PNG ran the
ingestion Lambda out of memory, and Bedrock rejects images over 5 MB of base64.
"""

from __future__ import annotations

import io
import sys
from unittest.mock import MagicMock

import pytest

Image = pytest.importorskip("PIL.Image")
np = pytest.importorskip("numpy")

from ..models.data_models import FileMetadata  # noqa: E402
from .image_fit import MAX_IMAGE_BYTES, MAX_LONG_EDGE_PX, fit_image  # noqa: E402


def _encode(img, fmt: str, **kw) -> bytes:
    buf = io.BytesIO()
    img.save(buf, fmt, **kw)
    return buf.getvalue()


def _noise(width: int, height: int, mode: str = "RGB") -> "Image.Image":
    """Random pixels: the worst case for PNG compression."""
    channels = {"RGB": 3, "RGBA": 4}[mode]
    arr = np.random.default_rng(0).integers(0, 255, (height, width, channels), dtype=np.uint8)
    return Image.fromarray(arr, mode)


def _decode(data: bytes) -> "Image.Image":
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


class TestWithinLimits:
    def test_small_png_is_returned_unchanged_without_decoding(self) -> None:
        data = _encode(Image.new("RGB", (800, 600), "red"), "PNG")
        fitted = fit_image(data, force_png=True)
        assert fitted is not None
        assert fitted.content is data
        assert (fitted.width, fitted.height, fitted.resized) == (800, 600, False)

    def test_small_jpeg_kept_as_jpeg_by_default(self) -> None:
        data = _encode(Image.new("RGB", (800, 600), "blue"), "JPEG")
        fitted = fit_image(data)
        assert fitted is not None and fitted.content is data

    def test_small_jpeg_converted_to_png_when_forced(self) -> None:
        data = _encode(Image.new("RGB", (800, 600), "blue"), "JPEG")
        fitted = fit_image(data, force_png=True)
        assert fitted is not None
        assert _decode(fitted.content).format == "PNG"
        assert (fitted.width, fitted.height, fitted.resized) == (800, 600, False)


class TestDownscaling:
    def test_large_photo_fits_long_edge_and_keeps_aspect_ratio(self) -> None:
        data = _encode(Image.new("RGB", (4800, 3600), (40, 90, 160)), "JPEG", quality=95)
        fitted = fit_image(data)
        assert fitted is not None and fitted.resized
        img = _decode(fitted.content)
        assert img.format == "PNG"
        assert img.size == (fitted.width, fitted.height) == (MAX_LONG_EDGE_PX, 1176)
        assert len(fitted.content) <= MAX_IMAGE_BYTES

    def test_portrait_image_limits_the_height(self) -> None:
        data = _encode(Image.new("L", (2000, 6000), 128), "PNG")
        fitted = fit_image(data)
        assert fitted is not None
        assert (fitted.width, fitted.height) == (523, MAX_LONG_EDGE_PX)

    def test_noisy_image_shrinks_until_under_byte_limit(self) -> None:
        # Random RGB at 1568x1176 is ~5.5 MB of PNG, over the 3.93 MB limit,
        # so the dimension cap alone isn't enough.
        data = _encode(_noise(3000, 2250), "PNG")
        fitted = fit_image(data)
        assert fitted is not None and fitted.resized
        assert len(fitted.content) <= MAX_IMAGE_BYTES
        assert max(fitted.width, fitted.height) < MAX_LONG_EDGE_PX
        # Base64 of the result is within Bedrock's 5 MB limit.
        assert (len(fitted.content) + 2) // 3 * 4 <= 5 * 1024 * 1024

    def test_over_byte_limit_within_dimensions_is_reencoded(self) -> None:
        data = _encode(_noise(1500, 1100), "BMP")  # ~5 MB, small dimensions
        assert len(data) > MAX_IMAGE_BYTES
        fitted = fit_image(data)
        assert fitted is not None
        assert len(fitted.content) <= MAX_IMAGE_BYTES
        assert _decode(fitted.content).format == "PNG"

    def test_transparency_is_kept(self) -> None:
        data = _encode(_noise(3000, 2000, "RGBA"), "PNG")
        fitted = fit_image(data)
        assert fitted is not None
        assert _decode(fitted.content).mode == "RGBA"

    def test_palette_image_with_transparency_becomes_rgba(self) -> None:
        img = Image.new("P", (3000, 2000), 0)
        img.info["transparency"] = 0
        fitted = fit_image(_encode(img, "PNG", transparency=0))
        assert fitted is not None
        assert _decode(fitted.content).mode == "RGBA"

    def test_cmyk_jpeg_becomes_rgb_png(self) -> None:
        data = _encode(Image.new("CMYK", (3000, 2000), (0, 50, 100, 0)), "JPEG")
        fitted = fit_image(data, force_png=True)
        assert fitted is not None
        img = _decode(fitted.content)
        assert (img.format, img.mode) == ("PNG", "RGB")


class TestUndecodable:
    def test_garbage_bytes_return_none(self) -> None:
        assert fit_image(b"definitely not an image") is None

    def test_truncated_image_returns_none(self) -> None:
        data = _encode(Image.new("RGB", (4000, 3000), "green"), "JPEG")
        assert fit_image(data[:200]) is None


# ---------------------------------------------------------------------------
# PdfAdapter: images are fitted as they are extracted
# ---------------------------------------------------------------------------


@pytest.fixture
def real_fitz(monkeypatch: pytest.MonkeyPatch):
    """The real PyMuPDF, even when another test module installed a mock."""
    if isinstance(sys.modules.get("fitz"), MagicMock):
        monkeypatch.delitem(sys.modules, "fitz")
    fitz = pytest.importorskip("fitz")
    monkeypatch.setitem(sys.modules, "fitz", fitz)
    from .adapters import pdf_adapter

    monkeypatch.setattr(pdf_adapter, "fitz", fitz)
    return fitz


def _pdf_with_image(fitz, image_bytes: bytes) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((50, 60), "Lecture notes", fontsize=11)
    page.insert_image(fitz.Rect(50, 100, 550, 475), stream=image_bytes)
    return doc.tobytes()


def _metadata() -> FileMetadata:
    return FileMetadata(
        course_id="c", module_id="m", file_id="f",
        file_key="courses/c/m/f.pdf", file_size=0, extension="pdf",
    )


class TestPdfAdapterImages:
    def test_large_embedded_photo_is_downscaled_png(self, real_fitz) -> None:
        from ..models.data_models import ElementType
        from .adapters.pdf_adapter import PdfAdapter

        photo = _encode(Image.new("RGB", (4800, 3600), (200, 120, 40)), "JPEG", quality=95)
        elements = PdfAdapter().extract(_pdf_with_image(real_fitz, photo), _metadata())

        images = [e for e in elements if e.element_type == ElementType.IMAGE]
        assert len(images) == 1
        img = _decode(images[0].content)
        assert img.format == "PNG"
        assert img.size == (MAX_LONG_EDGE_PX, 1176)
        assert len(images[0].content) <= MAX_IMAGE_BYTES
        meta = images[0].raw_metadata
        # width/height stay the source size (the small-image filter uses them).
        assert (meta["width"], meta["height"]) == (4800, 3600)
        assert (meta["stored_width"], meta["stored_height"]) == (MAX_LONG_EDGE_PX, 1176)
        assert meta["original_format"] == "jpeg"

    def test_small_embedded_image_is_png_at_source_size(self, real_fitz) -> None:
        from ..models.data_models import ElementType
        from .adapters.pdf_adapter import PdfAdapter

        photo = _encode(Image.new("RGB", (640, 480), (10, 200, 90)), "JPEG")
        elements = PdfAdapter().extract(_pdf_with_image(real_fitz, photo), _metadata())

        (image,) = [e for e in elements if e.element_type == ElementType.IMAGE]
        assert _decode(image.content).size == (640, 480)
        assert _decode(image.content).format == "PNG"
        assert "stored_width" not in image.raw_metadata

    def test_pixmap_fallback_downscales_when_pillow_cannot_decode(
        self, real_fitz, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from .adapters import pdf_adapter

        # Simulate a format only PyMuPDF reads: Pillow fails on the source
        # bytes but still handles the PNG the fallback produces.
        real_fit = pdf_adapter.fit_image
        source = _encode(Image.new("RGB", (6400, 4800), (90, 90, 200)), "JPEG")
        monkeypatch.setattr(
            pdf_adapter, "fit_image",
            lambda data, **kw: None if data is source else real_fit(data, **kw),
        )
        fitted = pdf_adapter.PdfAdapter._fit_via_pixmap(source)
        assert fitted.resized
        assert (fitted.width, fitted.height) == (MAX_LONG_EDGE_PX, 1176)
        assert _decode(fitted.content).format == "PNG"
