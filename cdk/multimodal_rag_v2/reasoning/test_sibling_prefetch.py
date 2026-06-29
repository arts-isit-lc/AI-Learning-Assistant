"""Tests for batched sibling prefetch (Phase 1 #6).

Proves the optimization (a) issues a single store query for all results and
(b) produces a sibling set identical to the previous per-result path.
"""
from __future__ import annotations

from ..models.data_models import ElementType, RankedResult
from .context_builder import ContextBuilder


def _r(rid: str, page: int, pos: int, siblings=None, content="some content here") -> RankedResult:
    return RankedResult(
        retrieval_id=rid,
        parent_element_id="p1",
        content=content,
        element_type=ElementType.TEXT,
        score=0.8,
        cross_encoder_score=0.7,
        metadata_boost=0.1,
        metadata={"provenance_page_num": page, "provenance_position_index": pos},
        image_s3_key=None,
        sibling_ids=siblings or [],
    )


class CountingStore:
    """Sibling store that records how many get_by_ids calls it received."""

    def __init__(self, pool: dict[str, RankedResult]) -> None:
        self._pool = pool
        self.call_count = 0
        self.calls: list[list[str]] = []

    def get_by_ids(self, retrieval_ids):
        self.call_count += 1
        self.calls.append(list(retrieval_ids))
        return [self._pool[i] for i in retrieval_ids if i in self._pool]


def _scenario():
    # Sibling rows in the store...
    s1, s2, s3, s4 = _r("s1", 1, 0), _r("s2", 1, 2), _r("s3", 1, 4), _r("s4", 2, 0)
    pool = {x.retrieval_id: x for x in (s1, s2, s3, s4)}
    # ...and 3 primary results with OVERLAPPING sibling refs (s2 shared).
    r_a = _r("a", 1, 1, siblings=["s1", "s2"])
    r_b = _r("b", 1, 3, siblings=["s2", "s3"])
    r_c = _r("c", 2, 1, siblings=["s4"])
    return pool, [r_a, r_b, r_c]


class TestSiblingPrefetch:
    def test_prefetch_issues_single_query_with_deduped_ids(self):
        pool, results = _scenario()
        store = CountingStore(pool)
        builder = ContextBuilder(sibling_store=store)

        prefetched = builder._prefetch_sibling_pool(results)

        assert store.call_count == 1  # one query for all 3 results (was N=3)
        assert set(store.calls[0]) == {"s1", "s2", "s3", "s4"}
        assert len(store.calls[0]) == 4  # s2 deduped, not requested twice
        assert set(prefetched) == {"s1", "s2", "s3", "s4"}

    def test_batched_expansion_equals_unbatched(self):
        # Equivalence: the pooled path returns the same siblings (same order)
        # the per-result store path returns.
        pool, results = _scenario()
        store = CountingStore(pool)
        builder = ContextBuilder(sibling_store=store)
        prefetched = builder._prefetch_sibling_pool(results)

        for r in results:
            batched = builder.expand_siblings(r, sibling_pool=prefetched)
            unbatched = builder.expand_siblings(r)  # pool=None -> per-result query
            assert [x.retrieval_id for x in batched] == [
                x.retrieval_id for x in unbatched
            ], f"mismatch for {r.retrieval_id}"

    def test_no_store_returns_empty_pool(self):
        _, results = _scenario()
        builder = ContextBuilder(sibling_store=None)
        assert builder._prefetch_sibling_pool(results) == {}

    def test_no_sibling_ids_issues_no_query(self):
        store = CountingStore({})
        builder = ContextBuilder(sibling_store=store)
        results = [_r("a", 1, 0), _r("b", 1, 1)]  # no sibling_ids
        assert builder._prefetch_sibling_pool(results) == {}
        assert store.call_count == 0
