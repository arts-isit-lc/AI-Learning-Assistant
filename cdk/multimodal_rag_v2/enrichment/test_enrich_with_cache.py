"""Tests for _enrich_with_cache — TEXT cache bypass (H4) and uncached-subset
enrichment (L2).

The handler's module-level `enrichment_cache` and `element_router` singletons
are monkeypatched with recording fakes. No DB/Bedrock/network involved.
"""

from __future__ import annotations

import pytest

from ..models.data_models import (
    DocumentIR,
    ElementType,
    EnrichedElement,
    FileMetadata,
    IRElement,
    Provenance,
)
from . import handler as handler_module


# ---------------------------------------------------------------------------
# Fakes + factories
# ---------------------------------------------------------------------------


class _FakeCache:
    def __init__(self, cached: dict | None = None) -> None:
        # cached: {(content_hash, element_type): EnrichedElement}
        self._cached = cached or {}
        self.get_calls: list[tuple] = []
        self.put_calls: list[tuple] = []

    def get(self, content_hash, element_type, enrichment_version, context_hash=""):
        self.get_calls.append((content_hash, element_type))
        return self._cached.get((content_hash, element_type))

    def put(self, content_hash, enriched_element, element_type, enrichment_version, context_hash=""):
        self.put_calls.append((content_hash, element_type))


class _FakeRouter:
    def __init__(self, enriched_by_element_id: dict) -> None:
        self._map = enriched_by_element_id
        self.received_element_ids: list[str] | None = None

    def enrich_document(self, document_ir: DocumentIR):
        self.received_element_ids = [e.element_id for e in document_ir.elements]
        out: list[EnrichedElement] = []
        for el in document_ir.elements:
            out.extend(self._map.get(el.element_id, []))
        return out


def _fm() -> FileMetadata:
    return FileMetadata(
        course_id="course-1", module_id="module-1", file_id="file-1",
        file_key="k", file_size=1, extension="pdf",
    )


def _ir(element_id: str, element_type: ElementType, content_hash: str) -> IRElement:
    return IRElement(
        element_id=element_id,
        content="content",
        element_type=element_type,
        provenance=Provenance(page_num=1, position_index=0),
        content_hash=content_hash,
    )


def _text(element_id: str, text: str) -> EnrichedElement:
    return EnrichedElement(
        element_id=element_id,
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=1, position_index=0),
        embedding_text=text,
    )


def _image(element_id: str, text: str = "an image") -> EnrichedElement:
    return EnrichedElement(
        element_id=element_id,
        element_type=ElementType.IMAGE,
        provenance=Provenance(page_num=1, position_index=0),
        embedding_text=text,
        image_s3_key="s3://b/i.png",
    )


@pytest.fixture
def wired(monkeypatch):
    def _wire(cache: _FakeCache, router: _FakeRouter):
        monkeypatch.setattr(handler_module, "enrichment_cache", cache)
        monkeypatch.setattr(handler_module, "element_router", router)
    return _wire


# ---------------------------------------------------------------------------
# H4: TEXT is never cached, and multi-chunk TEXT never collapses
# ---------------------------------------------------------------------------


def test_text_never_touches_cache_and_all_chunks_survive(wired):
    # A TEXT element that the chunker splits into 2 chunks (same element_id).
    doc = DocumentIR(file_metadata=_fm(), elements=[_ir("t1", ElementType.TEXT, "th")])
    cache = _FakeCache()
    router = _FakeRouter({"t1": [_text("t1", "chunk A"), _text("t1", "chunk B")]})
    wired(cache, router)

    out = handler_module._enrich_with_cache(doc, "course-1", "module-1")

    # Both chunks survive — no version-only-key collapse (H4).
    assert sorted(e.embedding_text for e in out) == ["chunk A", "chunk B"]
    # TEXT bypasses the cache entirely: no get, no put.
    assert cache.get_calls == []
    assert cache.put_calls == []


# ---------------------------------------------------------------------------
# L2: only the uncached subset is sent to the router
# ---------------------------------------------------------------------------


def test_cached_image_is_not_re_enriched(wired):
    # IMAGE is a cache hit; TEXT is always uncached. The router must receive
    # ONLY the TEXT element — the cached image is not re-run through vision.
    doc = DocumentIR(
        file_metadata=_fm(),
        elements=[_ir("t1", ElementType.TEXT, "th"), _ir("i1", ElementType.IMAGE, "ih")],
    )
    cached_img = _image("i1", "cached description")
    cache = _FakeCache(cached={("ih", ElementType.IMAGE): cached_img})
    router = _FakeRouter({"t1": [_text("t1", "chunk A")]})
    wired(cache, router)

    out = handler_module._enrich_with_cache(doc, "course-1", "module-1")

    assert router.received_element_ids == ["t1"]           # image excluded (cached)
    assert cached_img in out                                # cached image reused
    assert any(e.embedding_text == "chunk A" for e in out)  # text still enriched
    # Image was looked up; TEXT never was; nothing new was written.
    assert ("ih", ElementType.IMAGE) in cache.get_calls
    assert ("th", ElementType.TEXT) not in cache.get_calls
    assert cache.put_calls == []


def test_uncached_image_is_enriched_and_written_to_cache(wired):
    doc = DocumentIR(file_metadata=_fm(), elements=[_ir("i1", ElementType.IMAGE, "ih")])
    cache = _FakeCache()  # miss
    enriched_img = _image("i1")
    router = _FakeRouter({"i1": [enriched_img]})
    wired(cache, router)

    out = handler_module._enrich_with_cache(doc, "course-1", "module-1")

    assert router.received_element_ids == ["i1"]
    assert enriched_img in out
    assert cache.put_calls == [("ih", ElementType.IMAGE)]  # image IS cached


def test_all_cached_skips_router_entirely(wired):
    doc = DocumentIR(file_metadata=_fm(), elements=[_ir("i1", ElementType.IMAGE, "ih")])
    cached_img = _image("i1", "cached")
    cache = _FakeCache(cached={("ih", ElementType.IMAGE): cached_img})
    router = _FakeRouter({})
    wired(cache, router)

    out = handler_module._enrich_with_cache(doc, "course-1", "module-1")

    assert out == [cached_img]
    assert router.received_element_ids is None  # router never invoked


# ---------------------------------------------------------------------------
# L6: fallback / degraded enrichments are never cached
# ---------------------------------------------------------------------------


def test_fallback_enrichment_is_returned_but_not_cached(wired):
    doc = DocumentIR(file_metadata=_fm(), elements=[_ir("i1", ElementType.IMAGE, "ih")])
    cache = _FakeCache()  # miss
    fallback_img = _image("i1", "degraded (vision failed)")
    fallback_img.is_fallback = True
    router = _FakeRouter({"i1": [fallback_img]})
    wired(cache, router)

    out = handler_module._enrich_with_cache(doc, "course-1", "module-1")

    assert fallback_img in out       # used this run
    assert cache.put_calls == []     # L6: NOT cached (would be sticky across re-ingests)


def test_non_fallback_alongside_fallback_only_caches_the_good_one(wired):
    doc = DocumentIR(
        file_metadata=_fm(),
        elements=[_ir("i1", ElementType.IMAGE, "ih1"), _ir("i2", ElementType.IMAGE, "ih2")],
    )
    good = _image("i1", "real description")
    bad = _image("i2", "degraded")
    bad.is_fallback = True
    cache = _FakeCache()
    router = _FakeRouter({"i1": [good], "i2": [bad]})
    wired(cache, router)

    out = handler_module._enrich_with_cache(doc, "course-1", "module-1")

    assert good in out and bad in out
    assert cache.put_calls == [("ih1", ElementType.IMAGE)]  # only the good one cached


def test_create_fallback_sets_is_fallback_marker():
    from .element_router import _create_fallback
    fb = _create_fallback(_ir("x", ElementType.TEXT, "xh"))
    assert fb.is_fallback is True
