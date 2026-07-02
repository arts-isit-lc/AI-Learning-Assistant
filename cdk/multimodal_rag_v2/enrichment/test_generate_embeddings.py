"""Tests for _generate_embeddings — backoff + success-rate gate (H5).

Embedding failures used to be swallowed per-unit with no backoff; a throttling
burst then let _store_in_pgvector DELETE+commit an almost-empty index and mark
the file "complete". _generate_embeddings now retries with backoff and RAISES
when too few embeddings succeed, so the SQS record is retried and the existing
index is preserved.

The module-level `embedding_generator` singleton and `time.sleep` are patched.
"""

from __future__ import annotations

import pytest

from ..models.data_models import ElementType, Provenance, RetrievalUnit
from . import handler as handler_module


class _Embedder:
    """Fake embedding generator with controllable failures."""

    def __init__(self, *, always_fail=False, fail_texts=None, fail_first=0) -> None:
        self.always_fail = always_fail
        self.fail_texts = set(fail_texts or [])
        self.fail_first = fail_first
        self.calls = 0

    def generate(self, text, content_hash):
        self.calls += 1
        if self.always_fail:
            raise RuntimeError("throttled")
        if self.calls <= self.fail_first:
            raise RuntimeError("throttled")
        if text in self.fail_texts:
            raise RuntimeError("permanently bad text")
        return [0.1, 0.2, 0.3]


def _unit(text: str) -> RetrievalUnit:
    return RetrievalUnit(
        retrieval_id=f"ret-{text}",
        parent_element_id="el",
        embedding_text=text,
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=1, position_index=0),
    )


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    # Backoff must never sleep for real in tests.
    monkeypatch.setattr(handler_module.time, "sleep", lambda *_: None)


@pytest.fixture
def use_embedder(monkeypatch):
    def _use(embedder):
        monkeypatch.setattr(handler_module, "embedding_generator", embedder)
        return embedder
    return _use


def test_all_succeed_attaches_embeddings_no_raise(use_embedder):
    use_embedder(_Embedder())
    units = [_unit("u1"), _unit("u2")]

    handler_module._generate_embeddings(units)

    assert all("embedding" in u.metadata for u in units)
    assert all(u.metadata["embedding_version"] for u in units)


def test_total_failure_raises(use_embedder):
    use_embedder(_Embedder(always_fail=True))
    units = [_unit("u1"), _unit("u2")]

    with pytest.raises(RuntimeError):
        handler_module._generate_embeddings(units)

    # No embeddings attached — protects the store step from a wipe.
    assert all("embedding" not in u.metadata for u in units)


def test_partial_below_threshold_raises(use_embedder):
    # 1/4 succeed => 0.25 < 0.5 default threshold => raise.
    use_embedder(_Embedder(fail_texts={"u2", "u3", "u4"}))
    units = [_unit("u1"), _unit("u2"), _unit("u3"), _unit("u4")]

    with pytest.raises(RuntimeError):
        handler_module._generate_embeddings(units)


def test_partial_above_threshold_does_not_raise(use_embedder):
    # 3/4 succeed => 0.75 >= 0.5 => no raise; the 3 good ones are attached.
    use_embedder(_Embedder(fail_texts={"u4"}))
    units = [_unit("u1"), _unit("u2"), _unit("u3"), _unit("u4")]

    handler_module._generate_embeddings(units)

    attached = [u for u in units if "embedding" in u.metadata]
    assert len(attached) == 3
    assert "embedding" not in units[3].metadata  # u4 failed


def test_transient_failure_retried_then_succeeds(use_embedder):
    # First two calls throttle, third succeeds -> single unit embeds via backoff.
    embedder = use_embedder(_Embedder(fail_first=2))
    units = [_unit("u1")]

    handler_module._generate_embeddings(units)

    assert "embedding" in units[0].metadata
    assert embedder.calls == 3  # 2 failures + 1 success


def test_no_embeddable_units_returns_without_raise(use_embedder):
    embedder = use_embedder(_Embedder(always_fail=True))
    units = [_unit("   "), _unit("")]  # all empty/whitespace embedding_text

    handler_module._generate_embeddings(units)  # must not raise

    assert embedder.calls == 0


def test_threshold_is_configurable(use_embedder, monkeypatch):
    # Lowering the threshold to 0 disables the gate: 0/2 succeed, no raise.
    monkeypatch.setattr(handler_module, "_MIN_EMBED_SUCCESS_RATE", 0.0)
    use_embedder(_Embedder(always_fail=True))
    units = [_unit("u1"), _unit("u2")]

    handler_module._generate_embeddings(units)  # must not raise
