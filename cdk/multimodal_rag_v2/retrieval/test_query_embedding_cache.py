"""Tests for query-embedding caching + instrumentation (Phase 1 #5)."""
from __future__ import annotations

import json
from unittest.mock import MagicMock

from . import handler


class _FakeBody:
    def __init__(self, payload: dict) -> None:
        self._p = json.dumps(payload).encode()

    def read(self) -> bytes:
        return self._p


def _bedrock_returning(embedding: list[float], tokens: int = 5) -> MagicMock:
    client = MagicMock()
    client.invoke_model.return_value = {
        "body": _FakeBody({"embedding": embedding, "inputTextTokenCount": tokens})
    }
    return client


class TestQueryEmbeddingCache:
    def test_cache_hit_skips_bedrock(self, monkeypatch):
        monkeypatch.setattr(handler, "QUERY_EMBEDDING_CACHE", True)
        cache = MagicMock()
        cache.get.return_value = [0.1, 0.2, 0.3]
        monkeypatch.setattr(handler, "_embedding_cache", cache)
        bedrock = MagicMock()
        monkeypatch.setattr(handler, "_bedrock_client", bedrock)

        result = handler._generate_query_embedding("hello")

        assert result == [0.1, 0.2, 0.3]
        bedrock.invoke_model.assert_not_called()  # served from cache
        cache.put.assert_not_called()

    def test_cache_miss_calls_bedrock_and_stores_under_version(self, monkeypatch):
        monkeypatch.setattr(handler, "QUERY_EMBEDDING_CACHE", True)
        cache = MagicMock()
        cache.get.return_value = None
        monkeypatch.setattr(handler, "_embedding_cache", cache)
        monkeypatch.setattr(handler, "_bedrock_client", _bedrock_returning([0.4, 0.5]))

        result = handler._generate_query_embedding("hello")

        assert result == [0.4, 0.5]
        cache.put.assert_called_once()
        args = cache.put.call_args.args
        assert args[1] == [0.4, 0.5]
        assert args[2] == handler.EMBEDDING_VERSION

    def test_flag_off_bypasses_cache_entirely(self, monkeypatch):
        monkeypatch.setattr(handler, "QUERY_EMBEDDING_CACHE", False)
        cache = MagicMock()
        monkeypatch.setattr(handler, "_embedding_cache", cache)
        monkeypatch.setattr(handler, "_bedrock_client", _bedrock_returning([1.0]))

        result = handler._generate_query_embedding("hello")

        assert result == [1.0]
        cache.get.assert_not_called()
        cache.put.assert_not_called()

    def test_bedrock_failure_returns_none(self, monkeypatch):
        monkeypatch.setattr(handler, "QUERY_EMBEDDING_CACHE", False)
        bedrock = MagicMock()
        bedrock.invoke_model.side_effect = RuntimeError("boom")
        monkeypatch.setattr(handler, "_bedrock_client", bedrock)

        assert handler._generate_query_embedding("hello") is None

    def test_cache_get_failure_falls_through_to_bedrock(self, monkeypatch):
        # EmbeddingCache.get returns None on error; ensure we still embed.
        monkeypatch.setattr(handler, "QUERY_EMBEDDING_CACHE", True)
        cache = MagicMock()
        cache.get.return_value = None
        monkeypatch.setattr(handler, "_embedding_cache", cache)
        monkeypatch.setattr(handler, "_bedrock_client", _bedrock_returning([9.9]))

        assert handler._generate_query_embedding("x") == [9.9]
