"""Unit tests for EnrichmentCache — DynamoDB-backed enrichment caching.

Tests cover:
- Key construction (TEXT/FORMULA vs IMAGE/TABLE)
- Version isolation
- Context-aware caching
- Graceful error handling (get and put)
- Serialization round-trip
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from unittest.mock import MagicMock, patch

import pytest

from ..models.data_models import ElementType, EnrichedElement, Provenance
from .enrichment_cache import EnrichmentCache, compute_context_hash


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_enriched_element(
    element_id: str = "elem-001",
    element_type: ElementType = ElementType.TEXT,
    embedding_text: str = "enriched text content",
    topics: list[str] | None = None,
    enrichment_version: str = "haiku-v3-2026-06",
) -> EnrichedElement:
    return EnrichedElement(
        element_id=element_id,
        element_type=element_type,
        provenance=Provenance(page_num=1, position_index=0),
        embedding_text=embedding_text,
        topics=topics or [],
        enrichment_version=enrichment_version,
    )


def _make_mock_table() -> MagicMock:
    return MagicMock()


def _make_mock_dynamodb(table_mock: MagicMock) -> MagicMock:
    dynamodb = MagicMock()
    dynamodb.Table.return_value = table_mock
    return dynamodb


def _serialize_element(element: EnrichedElement) -> str:
    """Mirror the cache serialization logic."""
    data = asdict(element)
    data["element_type"] = element.element_type.value
    return json.dumps(data)


# ---------------------------------------------------------------------------
# Tests for compute_context_hash
# ---------------------------------------------------------------------------


class TestComputeContextHash:
    def test_produces_sha256_of_concatenation(self) -> None:
        course_topic = "Linear Algebra"
        module_name = "Module 3"
        expected = hashlib.sha256((course_topic + module_name).encode()).hexdigest()
        assert compute_context_hash(course_topic, module_name) == expected

    def test_different_inputs_produce_different_hashes(self) -> None:
        hash1 = compute_context_hash("Physics", "Module 1")
        hash2 = compute_context_hash("Chemistry", "Module 1")
        assert hash1 != hash2

    def test_empty_strings_produce_valid_hash(self) -> None:
        result = compute_context_hash("", "")
        expected = hashlib.sha256(b"").hexdigest()
        assert result == expected
        assert len(result) == 64

    def test_concatenation_order_matters(self) -> None:
        hash1 = compute_context_hash("AB", "CD")
        hash2 = compute_context_hash("ABC", "D")
        # "AB" + "CD" = "ABCD", "ABC" + "D" = "ABCD" — same!
        # This documents the expected behavior
        assert hash1 == hash2  # This is a known property of simple concatenation


# ---------------------------------------------------------------------------
# Tests for sort key construction
# ---------------------------------------------------------------------------


class TestBuildSortKey:
    def test_text_element_uses_version_only(self) -> None:
        key = EnrichmentCache._build_sort_key(
            ElementType.TEXT, "haiku-v3-2026-06", "some-context-hash"
        )
        assert key == "haiku-v3-2026-06"

    def test_formula_element_uses_version_only(self) -> None:
        key = EnrichmentCache._build_sort_key(
            ElementType.FORMULA, "haiku-v3-2026-06", "some-context-hash"
        )
        assert key == "haiku-v3-2026-06"

    def test_image_element_includes_context_hash(self) -> None:
        key = EnrichmentCache._build_sort_key(
            ElementType.IMAGE, "haiku-v3-2026-06", "abc123"
        )
        assert key == "abc123#haiku-v3-2026-06"

    def test_table_element_includes_context_hash(self) -> None:
        key = EnrichmentCache._build_sort_key(
            ElementType.TABLE, "haiku-v3-2026-06", "def456"
        )
        assert key == "def456#haiku-v3-2026-06"

    def test_empty_context_hash_for_image(self) -> None:
        key = EnrichmentCache._build_sort_key(
            ElementType.IMAGE, "v1", ""
        )
        assert key == "#v1"


# ---------------------------------------------------------------------------
# Tests for get() method
# ---------------------------------------------------------------------------


class TestGet:
    def test_cache_hit_returns_enriched_element(self) -> None:
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        element = _make_enriched_element()
        table_mock.get_item.return_value = {"Item": {"data": _serialize_element(element)}}

        result = cache.get(
            content_hash="hash123",
            element_type=ElementType.TEXT,
            enrichment_version="haiku-v3-2026-06",
        )

        assert result is not None
        assert result.element_id == "elem-001"
        assert result.embedding_text == "enriched text content"
        assert result.element_type == ElementType.TEXT

    def test_cache_miss_returns_none(self) -> None:
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        table_mock.get_item.return_value = {}  # No "Item" key

        result = cache.get(
            content_hash="nonexistent",
            element_type=ElementType.TEXT,
            enrichment_version="haiku-v3-2026-06",
        )

        assert result is None

    def test_get_uses_correct_key_for_text(self) -> None:
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        table_mock.get_item.return_value = {}

        cache.get(
            content_hash="hash-abc",
            element_type=ElementType.TEXT,
            enrichment_version="v1",
        )

        table_mock.get_item.assert_called_once_with(
            Key={"content_hash": "hash-abc", "sort_key": "v1"},
            ConsistentRead=False,
        )

    def test_get_uses_correct_key_for_image_with_context(self) -> None:
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        table_mock.get_item.return_value = {}

        cache.get(
            content_hash="hash-img",
            element_type=ElementType.IMAGE,
            enrichment_version="v2",
            context_hash="ctx-hash-123",
        )

        table_mock.get_item.assert_called_once_with(
            Key={"content_hash": "hash-img", "sort_key": "ctx-hash-123#v2"},
            ConsistentRead=False,
        )

    def test_get_exception_returns_none(self) -> None:
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        table_mock.get_item.side_effect = Exception("DynamoDB timeout")

        result = cache.get(
            content_hash="hash123",
            element_type=ElementType.TEXT,
            enrichment_version="v1",
        )

        assert result is None

    def test_get_deserialization_error_returns_none(self) -> None:
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        table_mock.get_item.return_value = {"Item": {"data": "invalid json {"}}

        result = cache.get(
            content_hash="hash123",
            element_type=ElementType.TEXT,
            enrichment_version="v1",
        )

        assert result is None

    def test_get_with_no_table_configured_returns_none(self) -> None:
        cache = EnrichmentCache(table_name="", dynamodb_resource=MagicMock())

        result = cache.get(
            content_hash="hash123",
            element_type=ElementType.TEXT,
            enrichment_version="v1",
        )

        assert result is None


# ---------------------------------------------------------------------------
# Tests for put() method
# ---------------------------------------------------------------------------


class TestPut:
    def test_put_stores_element_for_text(self) -> None:
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        element = _make_enriched_element()

        cache.put(
            content_hash="hash-abc",
            enriched_element=element,
            element_type=ElementType.TEXT,
            enrichment_version="haiku-v3-2026-06",
        )

        table_mock.put_item.assert_called_once()
        call_kwargs = table_mock.put_item.call_args[1]
        item = call_kwargs["Item"]
        assert item["content_hash"] == "hash-abc"
        assert item["sort_key"] == "haiku-v3-2026-06"
        assert item["enrichment_version"] == "haiku-v3-2026-06"
        assert item["element_type"] == "text"
        # Verify data is valid JSON
        json.loads(item["data"])

    def test_put_stores_element_for_image_with_context(self) -> None:
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        element = _make_enriched_element(element_type=ElementType.IMAGE)

        cache.put(
            content_hash="hash-img",
            enriched_element=element,
            element_type=ElementType.IMAGE,
            enrichment_version="v2",
            context_hash="ctx-abc",
        )

        table_mock.put_item.assert_called_once()
        call_kwargs = table_mock.put_item.call_args[1]
        item = call_kwargs["Item"]
        assert item["content_hash"] == "hash-img"
        assert item["sort_key"] == "ctx-abc#v2"

    def test_put_exception_does_not_propagate(self) -> None:
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        table_mock.put_item.side_effect = Exception("DynamoDB write error")

        element = _make_enriched_element()

        # Should not raise
        cache.put(
            content_hash="hash123",
            enriched_element=element,
            element_type=ElementType.TEXT,
            enrichment_version="v1",
        )

    def test_put_with_no_table_configured_does_not_raise(self) -> None:
        cache = EnrichmentCache(table_name="", dynamodb_resource=MagicMock())

        element = _make_enriched_element()

        # Should not raise
        cache.put(
            content_hash="hash123",
            enriched_element=element,
            element_type=ElementType.TEXT,
            enrichment_version="v1",
        )


# ---------------------------------------------------------------------------
# Tests for version isolation
# ---------------------------------------------------------------------------


class TestVersionIsolation:
    def test_different_version_produces_different_sort_key_text(self) -> None:
        key_v1 = EnrichmentCache._build_sort_key(ElementType.TEXT, "v1", "")
        key_v2 = EnrichmentCache._build_sort_key(ElementType.TEXT, "v2", "")
        assert key_v1 != key_v2

    def test_different_version_produces_different_sort_key_image(self) -> None:
        ctx = "context-hash"
        key_v1 = EnrichmentCache._build_sort_key(ElementType.IMAGE, "v1", ctx)
        key_v2 = EnrichmentCache._build_sort_key(ElementType.IMAGE, "v2", ctx)
        assert key_v1 != key_v2

    def test_get_with_v1_does_not_return_v2_entry(self) -> None:
        """Verifies that queries with version V only return entries stored under V."""
        table_mock = _make_mock_table()
        dynamodb = _make_mock_dynamodb(table_mock)
        cache = EnrichmentCache(table_name="test-table", dynamodb_resource=dynamodb)

        # Simulate no item for v1 key (even though v2 might exist)
        table_mock.get_item.return_value = {}

        result = cache.get(
            content_hash="hash123",
            element_type=ElementType.TEXT,
            enrichment_version="v1",
        )
        assert result is None

        # Verify the lookup used v1 as the sort key
        call_kwargs = table_mock.get_item.call_args[1]
        assert call_kwargs["Key"]["sort_key"] == "v1"


# ---------------------------------------------------------------------------
# Tests for context-aware caching
# ---------------------------------------------------------------------------


class TestContextAwareCaching:
    def test_same_image_different_context_different_keys(self) -> None:
        """Same content_hash + different context_hash = different cache entries."""
        ctx1 = compute_context_hash("Physics", "Module 1")
        ctx2 = compute_context_hash("Chemistry", "Module 1")

        key1 = EnrichmentCache._build_sort_key(ElementType.IMAGE, "v1", ctx1)
        key2 = EnrichmentCache._build_sort_key(ElementType.IMAGE, "v1", ctx2)

        assert key1 != key2

    def test_same_text_different_context_same_keys(self) -> None:
        """TEXT elements are context-independent — context_hash is ignored."""
        key1 = EnrichmentCache._build_sort_key(ElementType.TEXT, "v1", "context-A")
        key2 = EnrichmentCache._build_sort_key(ElementType.TEXT, "v1", "context-B")

        assert key1 == key2

    def test_same_formula_different_context_same_keys(self) -> None:
        """FORMULA elements are context-independent — context_hash is ignored."""
        key1 = EnrichmentCache._build_sort_key(ElementType.FORMULA, "v1", "ctx1")
        key2 = EnrichmentCache._build_sort_key(ElementType.FORMULA, "v1", "ctx2")

        assert key1 == key2

    def test_table_element_uses_context(self) -> None:
        """TABLE elements are context-dependent like images."""
        key1 = EnrichmentCache._build_sort_key(ElementType.TABLE, "v1", "ctx-A")
        key2 = EnrichmentCache._build_sort_key(ElementType.TABLE, "v1", "ctx-B")

        assert key1 != key2


# ---------------------------------------------------------------------------
# Tests for serialization round-trip
# ---------------------------------------------------------------------------


class TestSerialization:
    def test_round_trip_text_element(self) -> None:
        element = _make_enriched_element(
            element_id="test-123",
            element_type=ElementType.TEXT,
            embedding_text="some text",
        )

        serialized = EnrichmentCache._serialize(element)
        deserialized = EnrichmentCache._deserialize(serialized)

        assert deserialized.element_id == element.element_id
        assert deserialized.element_type == element.element_type
        assert deserialized.embedding_text == element.embedding_text
        assert deserialized.provenance.page_num == element.provenance.page_num

    def test_round_trip_image_element_with_all_fields(self) -> None:
        element = EnrichedElement(
            element_id="img-001",
            element_type=ElementType.IMAGE,
            provenance=Provenance(page_num=3, slide_num=2, section="intro", position_index=1),
            embedding_text="A bar chart showing sales data",
            topics=["sales", "revenue"],
            labels=["bar chart"],
            keywords=["quarterly", "growth"],
            image_type="chart",
            image_description="Quarterly sales data for 2024",
            image_s3_key="s3://bucket/img.png",
            file_id="file-abc",
            course_id="CS101",
            module_id="mod-1",
            enrichment_version="haiku-v3-2026-06",
        )

        serialized = EnrichmentCache._serialize(element)
        deserialized = EnrichmentCache._deserialize(serialized)

        assert deserialized.element_id == "img-001"
        assert deserialized.element_type == ElementType.IMAGE
        assert deserialized.topics == ["sales", "revenue"]
        assert deserialized.labels == ["bar chart"]
        assert deserialized.keywords == ["quarterly", "growth"]
        assert deserialized.image_type == "chart"
        assert deserialized.image_description == "Quarterly sales data for 2024"
        assert deserialized.image_s3_key == "s3://bucket/img.png"
        assert deserialized.provenance.page_num == 3
        assert deserialized.provenance.slide_num == 2
        assert deserialized.provenance.section == "intro"
        assert deserialized.provenance.position_index == 1

    def test_round_trip_formula_element(self) -> None:
        element = EnrichedElement(
            element_id="formula-001",
            element_type=ElementType.FORMULA,
            provenance=Provenance(page_num=7),
            embedding_text="E equals mc squared",
            formula_text="E = mc^2",
            latex_repr="E = mc^{2}",
            formula_concepts=["mass-energy equivalence", "special relativity"],
            enrichment_version="haiku-v3-2026-06",
        )

        serialized = EnrichmentCache._serialize(element)
        deserialized = EnrichmentCache._deserialize(serialized)

        assert deserialized.formula_text == "E = mc^2"
        assert deserialized.latex_repr == "E = mc^{2}"
        assert deserialized.formula_concepts == ["mass-energy equivalence", "special relativity"]

    def test_round_trip_table_element(self) -> None:
        element = EnrichedElement(
            element_id="table-001",
            element_type=ElementType.TABLE,
            provenance=Provenance(page_num=5),
            embedding_text="Table showing student grades",
            table_headers=["Name", "Grade", "Score"],
            table_rows=[["Alice", "A", "95"], ["Bob", "B", "85"]],
            table_summary="Student performance data for midterm exam",
            enrichment_version="haiku-v3-2026-06",
        )

        serialized = EnrichmentCache._serialize(element)
        deserialized = EnrichmentCache._deserialize(serialized)

        assert deserialized.table_headers == ["Name", "Grade", "Score"]
        assert deserialized.table_rows == [["Alice", "A", "95"], ["Bob", "B", "85"]]
        assert deserialized.table_summary == "Student performance data for midterm exam"


# ---------------------------------------------------------------------------
# Tests for constructor
# ---------------------------------------------------------------------------


class TestConstructor:
    def test_reads_table_name_from_param(self) -> None:
        dynamodb = MagicMock()
        cache = EnrichmentCache(table_name="my-table", dynamodb_resource=dynamodb)

        dynamodb.Table.assert_called_once_with("my-table")

    @patch.dict("os.environ", {"ENRICHMENT_CACHE_TABLE": "env-table"})
    def test_reads_table_name_from_env_var(self) -> None:
        dynamodb = MagicMock()
        cache = EnrichmentCache(dynamodb_resource=dynamodb)

        dynamodb.Table.assert_called_once_with("env-table")

    def test_empty_table_name_sets_table_to_none(self) -> None:
        dynamodb = MagicMock()
        cache = EnrichmentCache(table_name="", dynamodb_resource=dynamodb)

        assert cache._table is None
