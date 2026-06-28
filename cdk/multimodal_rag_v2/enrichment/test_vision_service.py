"""Tests for VisionService media-type detection (Issue #1).

Adapters keep the original image format (only PDF emits PNG), so VisionService
must detect the media type from the actual bytes — otherwise non-PNG images are
mislabeled as image/png and Bedrock rejects them.
"""
from __future__ import annotations

import io
import json
from unittest.mock import MagicMock

from ..models.data_models import ElementType, IRElement, Provenance
from .vision_service import VisionService, _detect_media_type

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16
GIF = b"GIF89a" + b"\x00" * 16
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 8


class TestDetectMediaType:
    def test_png(self):
        assert _detect_media_type(PNG) == "image/png"

    def test_jpeg(self):
        assert _detect_media_type(JPEG) == "image/jpeg"

    def test_gif(self):
        assert _detect_media_type(GIF) == "image/gif"

    def test_webp(self):
        assert _detect_media_type(WEBP) == "image/webp"

    def test_unknown_returns_none(self):
        assert _detect_media_type(b"not an image at all!!") is None

    def test_too_short_returns_none(self):
        assert _detect_media_type(b"\xff\xd8") is None

    def test_empty_returns_none(self):
        assert _detect_media_type(b"") is None


def _img_element(content: bytes, metadata=None) -> IRElement:
    return IRElement(
        element_id="img-1",
        content=content,
        element_type=ElementType.IMAGE,
        provenance=Provenance(page_num=1, position_index=0),
        content_hash="h",
        metadata=metadata or {},
    )


def _mock_bedrock_client():
    client = MagicMock()
    payload = json.dumps(
        {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "image_type": "chart",
                            "image_description": "a chart",
                            "topics": ["t"],
                            "labels": ["l"],
                            "keywords": ["k"],
                        }
                    ),
                }
            ]
        }
    ).encode()
    client.invoke_model.return_value = {"body": io.BytesIO(payload)}
    return client


def _sent_media_type(client) -> str:
    body = json.loads(client.invoke_model.call_args.kwargs["body"])
    return body["messages"][0]["content"][0]["source"]["media_type"]


class TestEnrichSendsDetectedMediaType:
    def test_jpeg_sent_as_jpeg(self):
        client = _mock_bedrock_client()
        VisionService(client).enrich(_img_element(JPEG))
        assert _sent_media_type(client) == "image/jpeg"

    def test_gif_sent_as_gif(self):
        client = _mock_bedrock_client()
        VisionService(client).enrich(_img_element(GIF))
        assert _sent_media_type(client) == "image/gif"

    def test_png_sent_as_png(self):
        client = _mock_bedrock_client()
        VisionService(client).enrich(_img_element(PNG))
        assert _sent_media_type(client) == "image/png"
