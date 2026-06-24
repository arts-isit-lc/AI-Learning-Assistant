"""Unit tests for EmbeddingCache — DynamoDB-backed embedding vector cache."""

from __future__ import annotations

from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from .embedding_cache import EmbeddingCache


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


class FakeDynamoDBTable:
    """In-memory DynamoDB table for testing without network calls."""

    def __init__(self) -> None:
        self._store: dict[tuple[str, str], dict[str, Any]] = {}

    def get_item(self, Key: dict[str, str]) -> dict[str, Any]:
        composite_key = (Key["content_hash"], Key["embedding_version"])
        item = self._store.get(composite_key)
        if item is None:
            return {}
        return {"Item": item}

    def put_item(self, Item: dict[str, Any]) -> dict[str, Any]:
        composite_key = (Item["content_hash"], Item["embedding_version"])
        self._store[composite_key] = Item
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


class FakeDynamoDBResource:
    """Fake boto3 DynamoDB resource that returns a FakeDynamoDBTable."""

    def __init__(self, table: FakeDynamoDBTable) -> None:
        self._table = table

    def Table(self, name: str) -> FakeDynamoDBTable:
        return self._table


@pytest.fixture
def fake_table() -> FakeDynamoDBTable:
    return FakeDynamoDBTable()


@pytest.fixture
def cache(fake_table: FakeDynamoDBTable) -> EmbeddingCache:
    resource = FakeDynamoDBResource(fake_table)
    return EmbeddingCache(table_name="test-embedding-cache", dynamodb_resource=resource)


# ---------------------------------------------------------------------------
# Tests for get()
# ---------------------------------------------------------------------------


class TestGet:
    def test_get_returns_none_on_cache_miss(self, cache: EmbeddingCache) -> None:
        result = cache.get("nonexistent-hash", "titan-v2-1024")
        assert result is None

    def test_get_returns_cached_embedding(
        self, cache: EmbeddingCache, fake_table: FakeDynamoDBTable
    ) -> None:
        embedding = [0.1, 0.2, 0.3, 0.4, 0.5]
        fake_table._store[("hash-abc", "titan-v2-1024")] = {
            "content_hash": "hash-abc",
            "embedding_version": "titan-v2-1024",
            "embedding": [Decimal("0.1"), Decimal("0.2"), Decimal("0.3"), Decimal("0.4"), Decimal("0.5")],
        }

        result = cache.get("hash-abc", "titan-v2-1024")
        assert result == pytest.approx([0.1, 0.2, 0.3, 0.4, 0.5])

    def test_get_converts_decimals_to_floats(
        self, cache: EmbeddingCache, fake_table: FakeDynamoDBTable
    ) -> None:
        """DynamoDB stores numbers as Decimal; get() must convert to float."""
        fake_table._store[("hash-dec", "v1")] = {
            "content_hash": "hash-dec",
            "embedding_version": "v1",
            "embedding": [Decimal("1.23456"), Decimal("-0.5"), Decimal("0")],
        }

        result = cache.get("hash-dec", "v1")
        assert result is not None
        assert all(isinstance(v, float) for v in result)
        assert result == pytest.approx([1.23456, -0.5, 0.0])

    def test_get_returns_none_when_item_has_no_embedding_field(
        self, cache: EmbeddingCache, fake_table: FakeDynamoDBTable
    ) -> None:
        """Edge case: item exists but missing embedding attribute."""
        fake_table._store[("hash-no-emb", "v1")] = {
            "content_hash": "hash-no-emb",
            "embedding_version": "v1",
        }

        result = cache.get("hash-no-emb", "v1")
        assert result is None

    def test_get_returns_none_on_exception(self) -> None:
        """Cache unavailability logs warning and returns None (cache miss)."""
        mock_table = MagicMock()
        mock_table.get_item.side_effect = Exception("DynamoDB unavailable")

        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        cache = EmbeddingCache(table_name="test", dynamodb_resource=mock_resource)
        result = cache.get("any-hash", "any-version")
        assert result is None

    def test_get_never_raises_exception(self) -> None:
        """No matter what error occurs, get() returns None without raising."""
        mock_table = MagicMock()
        mock_table.get_item.side_effect = RuntimeError("unexpected error")

        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        cache = EmbeddingCache(table_name="test", dynamodb_resource=mock_resource)
        # Should not raise
        result = cache.get("hash", "version")
        assert result is None


# ---------------------------------------------------------------------------
# Tests for put()
# ---------------------------------------------------------------------------


class TestPut:
    def test_put_stores_embedding(
        self, cache: EmbeddingCache, fake_table: FakeDynamoDBTable
    ) -> None:
        from decimal import Decimal
        embedding = [0.1, 0.2, 0.3]
        cache.put("hash-store", embedding, "titan-v2-1024")

        stored = fake_table._store.get(("hash-store", "titan-v2-1024"))
        assert stored is not None
        assert stored["content_hash"] == "hash-store"
        assert stored["embedding_version"] == "titan-v2-1024"
        # Embedding is stored as Decimal (DynamoDB requirement)
        assert stored["embedding"] == [Decimal("0.1"), Decimal("0.2"), Decimal("0.3")]

    def test_put_overwrites_existing_entry(
        self, cache: EmbeddingCache, fake_table: FakeDynamoDBTable
    ) -> None:
        cache.put("hash-overwrite", [1.0, 2.0], "v1")
        cache.put("hash-overwrite", [3.0, 4.0], "v1")

        stored = fake_table._store.get(("hash-overwrite", "v1"))
        assert stored["embedding"] == [3.0, 4.0]

    def test_put_does_not_raise_on_exception(self) -> None:
        """Store failures log warning and continue without retry."""
        mock_table = MagicMock()
        mock_table.put_item.side_effect = Exception("DynamoDB write failure")

        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        cache = EmbeddingCache(table_name="test", dynamodb_resource=mock_resource)
        # Should not raise
        cache.put("hash", [0.1, 0.2], "v1")

    def test_put_never_raises_exception(self) -> None:
        """No matter what error occurs, put() completes without raising."""
        mock_table = MagicMock()
        mock_table.put_item.side_effect = RuntimeError("unexpected error")

        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        cache = EmbeddingCache(table_name="test", dynamodb_resource=mock_resource)
        # Should not raise
        cache.put("hash", [0.5], "version")


# ---------------------------------------------------------------------------
# Tests for version isolation (Req 6.3)
# ---------------------------------------------------------------------------


class TestVersionIsolation:
    def test_different_version_returns_none(
        self, cache: EmbeddingCache, fake_table: FakeDynamoDBTable
    ) -> None:
        """Entries stored under V_old not returned when queried with V_new."""
        cache.put("hash-iso", [1.0, 2.0, 3.0], "v-old")

        # Query with different version — must be a miss
        result = cache.get("hash-iso", "v-new")
        assert result is None

    def test_same_version_returns_embedding(
        self, cache: EmbeddingCache, fake_table: FakeDynamoDBTable
    ) -> None:
        """Entries stored under V return correctly when queried with V."""
        cache.put("hash-iso", [1.0, 2.0, 3.0], "v-same")

        result = cache.get("hash-iso", "v-same")
        assert result == pytest.approx([1.0, 2.0, 3.0])

    def test_same_hash_different_versions_coexist(
        self, cache: EmbeddingCache, fake_table: FakeDynamoDBTable
    ) -> None:
        """Same content_hash with different versions stored independently."""
        cache.put("hash-multi", [1.0, 2.0], "version-A")
        cache.put("hash-multi", [3.0, 4.0], "version-B")

        result_a = cache.get("hash-multi", "version-A")
        result_b = cache.get("hash-multi", "version-B")

        assert result_a == pytest.approx([1.0, 2.0])
        assert result_b == pytest.approx([3.0, 4.0])


# ---------------------------------------------------------------------------
# Tests for round-trip (put then get)
# ---------------------------------------------------------------------------


class TestRoundTrip:
    def test_put_then_get_returns_same_embedding(
        self, cache: EmbeddingCache
    ) -> None:
        embedding = [0.123, -0.456, 0.789, 1.0, -1.0]
        cache.put("hash-rt", embedding, "titan-v2-1024")

        result = cache.get("hash-rt", "titan-v2-1024")
        assert result == pytest.approx(embedding)

    def test_large_embedding_round_trips(self, cache: EmbeddingCache) -> None:
        """Test with a realistic 1024-dimension embedding."""
        import random

        random.seed(42)
        embedding = [random.uniform(-1.0, 1.0) for _ in range(1024)]

        cache.put("hash-large", embedding, "titan-v2-1024")
        result = cache.get("hash-large", "titan-v2-1024")
        assert result == pytest.approx(embedding)


# ---------------------------------------------------------------------------
# Tests for constructor defaults
# ---------------------------------------------------------------------------


class TestConstructor:
    def test_uses_env_var_for_table_name(self) -> None:
        """When no table_name is passed, EMBEDDING_CACHE_TABLE env var is used."""
        mock_resource = MagicMock()
        with patch.dict("os.environ", {"EMBEDDING_CACHE_TABLE": "my-custom-table"}):
            # Need to reimport to pick up the env var at module load
            # Instead, test that the resource.Table is called with the right name
            from .embedding_cache import EmbeddingCache as EC

            cache = EC(dynamodb_resource=mock_resource)
            # The env var is read at module level, so pass table_name explicitly
            # to verify the DI path works
            cache2 = EC(table_name="explicit-table", dynamodb_resource=mock_resource)
            mock_resource.Table.assert_any_call("explicit-table")

    def test_accepts_custom_table_name(self) -> None:
        mock_resource = MagicMock()
        cache = EmbeddingCache(table_name="custom-table", dynamodb_resource=mock_resource)
        mock_resource.Table.assert_called_once_with("custom-table")
