"""EmbeddingCache: DynamoDB-backed cache for embedding vectors.

Maps (content_hash, embedding_version) → embedding vector.
Avoids re-embedding identical content across ingestions.

DynamoDB schema:
- Partition key: content_hash (String)
- Sort key: embedding_version (String)
- Attribute: embedding (List of Numbers)
"""

from __future__ import annotations

import os
from typing import Any

import boto3
from aws_lambda_powertools import Logger

logger = Logger(service="multimodal-rag-cache")

EMBEDDING_CACHE_TABLE = os.environ.get("EMBEDDING_CACHE_TABLE", "embedding-cache")


class EmbeddingCache:
    """DynamoDB-backed cache mapping content_hash + embedding_version → embedding vector.

    Version isolation: queries with version V only return entries stored under V.
    The sort key IS the embedding_version, so get_item is an exact composite key match.

    Error handling:
    - get(): catches all exceptions, logs warning, returns None (cache miss)
    - put(): catches all exceptions, logs warning, continues (no retry)
    - Cache errors never propagate to the caller.
    """

    def __init__(
        self,
        table_name: str | None = None,
        dynamodb_resource: Any | None = None,
    ) -> None:
        """Initialize EmbeddingCache.

        Args:
            table_name: DynamoDB table name. Defaults to EMBEDDING_CACHE_TABLE env var.
            dynamodb_resource: Optional boto3 DynamoDB resource for DI/testing.
        """
        self._table_name = table_name or EMBEDDING_CACHE_TABLE
        resource = dynamodb_resource or boto3.resource("dynamodb")
        self._table = resource.Table(self._table_name)

    def get(self, content_hash: str, embedding_version: str) -> list[float] | None:
        """Look up a cached embedding by composite key.

        Uses DynamoDB get_item with exact (content_hash, embedding_version) match.
        Version isolation is enforced by the sort key — only entries stored under
        the requested version are returned.

        Args:
            content_hash: SHA256 hash of the content that was embedded.
            embedding_version: Version identifier (e.g., "titan-v2-1024").

        Returns:
            Cached embedding vector as list of floats, or None on miss/error.
        """
        try:
            response = self._table.get_item(
                Key={
                    "content_hash": content_hash,
                    "embedding_version": embedding_version,
                }
            )
            item = response.get("Item")
            if item is None:
                return None

            embedding_data = item.get("embedding")
            if embedding_data is None:
                return None

            return [float(v) for v in embedding_data]

        except Exception:
            logger.warning(
                "EmbeddingCache get failed, proceeding as cache miss",
                extra={
                    "content_hash": content_hash,
                    "embedding_version": embedding_version,
                },
                exc_info=True,
            )
            return None

    def put(
        self,
        content_hash: str,
        embedding: list[float],
        embedding_version: str,
    ) -> None:
        """Store an embedding in the cache.

        Writes to DynamoDB with composite key (content_hash, embedding_version).
        On failure, logs a warning and returns without retry — cache store failures
        never propagate to the caller.

        Args:
            content_hash: SHA256 hash of the content that was embedded.
            embedding: The embedding vector to cache.
            embedding_version: Version identifier (e.g., "titan-v2-1024").
        """
        try:
            self._table.put_item(
                Item={
                    "content_hash": content_hash,
                    "embedding_version": embedding_version,
                    "embedding": embedding,
                }
            )
        except Exception:
            logger.warning(
                "EmbeddingCache put failed, continuing without cache store",
                extra={
                    "content_hash": content_hash,
                    "embedding_version": embedding_version,
                },
                exc_info=True,
            )
