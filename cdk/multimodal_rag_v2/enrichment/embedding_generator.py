"""EmbeddingGenerator: generates embeddings with cache integration.

Checks EmbeddingCache before invoking Bedrock embedding service.
Stores generated embeddings in cache after computation.
Includes embedding_version as metadata field when storing in pgvector.

Bedrock model: amazon.titan-embed-text-v2:0 (1024 dimensions)
"""

from __future__ import annotations

import json
import time
from typing import Any

from aws_lambda_powertools import Logger

from ..cache.embedding_cache import EmbeddingCache
from ..models.data_models import EMBEDDING_VERSION

logger = Logger(service="multimodal-rag-enrichment")

EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0"
EMBEDDING_DIMENSIONS = 1024


class EmbeddingGenerator:
    """Generates embeddings via Bedrock with DynamoDB-backed caching.

    Flow for each item:
    1. Check cache: cache.get(content_hash, embedding_version)
    2. If hit: return cached embedding
    3. If miss: invoke Bedrock embedding model
    4. Store in cache: cache.put(content_hash, embedding, embedding_version)
       (fire-and-forget — don't fail on cache error)
    5. Return embedding

    Error handling:
    - If Bedrock invocation fails, raise (let caller handle)
    - If cache operations fail, they silently return None/log
      (already handled by EmbeddingCache)
    """

    def __init__(
        self,
        bedrock_client: Any | None = None,
        embedding_cache: EmbeddingCache | None = None,
        embedding_version: str = EMBEDDING_VERSION,
    ) -> None:
        """Initialize EmbeddingGenerator.

        Args:
            bedrock_client: boto3 Bedrock Runtime client for invoke_model calls.
            embedding_cache: EmbeddingCache instance for caching embeddings.
            embedding_version: Version string for cache key isolation and pgvector metadata.
        """
        self._bedrock_client = bedrock_client
        self._embedding_cache = embedding_cache
        self._embedding_version = embedding_version

    def generate(self, text: str, content_hash: str) -> list[float]:
        """Generate an embedding for a single text, using cache when available.

        Args:
            text: The text to embed.
            content_hash: SHA256 hash of the content for cache lookup.

        Returns:
            Embedding vector as a list of floats (1024 dimensions).

        Raises:
            Exception: If Bedrock invocation fails (propagated to caller).
        """
        # 1. Check cache
        if self._embedding_cache is not None:
            cached = self._embedding_cache.get(content_hash, self._embedding_version)
            if cached is not None:
                logger.debug(
                    "Embedding cache hit",
                    extra={
                        "content_hash": content_hash[:16],
                        "embedding_version": self._embedding_version,
                    },
                )
                return cached

        # 2. Cache miss — invoke Bedrock
        embed_start = time.time()
        embedding = self._invoke_bedrock(text)
        embed_latency = time.time() - embed_start

        logger.debug(
            "Embedding generated (cache miss)",
            extra={
                "content_hash": content_hash[:16],
                "text_length": len(text),
                "embed_latency_ms": round(embed_latency * 1000, 2),
            },
        )

        # 3. Store in cache (fire-and-forget)
        if self._embedding_cache is not None:
            self._embedding_cache.put(content_hash, embedding, self._embedding_version)

        return embedding

    def generate_batch(
        self, items: list[tuple[str, str]]
    ) -> list[list[float]]:
        """Generate embeddings for multiple (text, content_hash) pairs.

        Checks cache for each item individually. Items with cache misses
        are sent to Bedrock individually (Titan Embed v2 does not support
        batch requests in a single invoke_model call).

        Args:
            items: List of (text, content_hash) tuples.

        Returns:
            List of embedding vectors in the same order as input items.

        Raises:
            Exception: If any Bedrock invocation fails (propagated to caller).
        """
        batch_start = time.time()
        results: list[list[float]] = []
        cache_hits = 0
        cache_misses = 0

        for text, content_hash in items:
            # Check cache inline to count hits/misses
            if self._embedding_cache is not None:
                cached = self._embedding_cache.get(content_hash, self._embedding_version)
                if cached is not None:
                    cache_hits += 1
                    results.append(cached)
                    continue

            cache_misses += 1
            embedding = self._invoke_bedrock(text)
            if self._embedding_cache is not None:
                self._embedding_cache.put(content_hash, embedding, self._embedding_version)
            results.append(embedding)

        batch_latency = time.time() - batch_start

        logger.info(
            "Embedding batch complete",
            extra={
                "batch_size": len(items),
                "cache_hits": cache_hits,
                "cache_misses": cache_misses,
                "cache_hit_rate": round(cache_hits / len(items), 3) if items else 0,
                "batch_latency_ms": round(batch_latency * 1000, 2),
                "avg_latency_per_item_ms": round((batch_latency * 1000) / len(items), 2) if items else 0,
            },
        )

        return results

    def _invoke_bedrock(self, text: str) -> list[float]:
        """Invoke Bedrock embedding model for a single text.

        Args:
            text: The text to embed.

        Returns:
            Embedding vector as list of floats.

        Raises:
            Exception: If Bedrock invocation fails.
        """
        if self._bedrock_client is None:
            raise RuntimeError(
                "bedrock_client is required but not provided to EmbeddingGenerator"
            )

        request_body = json.dumps(
            {"inputText": text, "dimensions": EMBEDDING_DIMENSIONS}
        )

        response = self._bedrock_client.invoke_model(
            modelId=EMBEDDING_MODEL_ID,
            body=request_body,
        )

        response_body = json.loads(response["body"].read())
        embedding = response_body["embedding"]

        return embedding
