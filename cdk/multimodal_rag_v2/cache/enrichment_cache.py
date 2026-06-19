"""DynamoDB-backed enrichment cache.

Caches EnrichedElement results keyed by content hash, element type-dependent
context hash, and enrichment version.

Key design:
  - TEXT/FORMULA: PK = content_hash, SK = enrichment_version
  - IMAGE/TABLE: PK = content_hash, SK = f"{context_hash}#{enrichment_version}"

This ensures version isolation (same content + different version = different items)
and context-aware caching (same image in different course/module = different entries).
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict

import boto3
from aws_lambda_powertools import Logger

from ..models.data_models import ElementType, EnrichedElement, Provenance

logger = Logger(service="multimodal-rag-cache")

# Environment variable for the DynamoDB table name
_ENV_TABLE_NAME = "ENRICHMENT_CACHE_TABLE"


def compute_context_hash(course_topic: str, module_name: str) -> str:
    """Compute SHA256 hash of (course_topic + module_name) for context-aware caching.

    Used for IMAGE/TABLE elements where the same content in a different
    course/module context should produce a different cache entry.
    """
    combined = (course_topic + module_name).encode()
    return hashlib.sha256(combined).hexdigest()


class EnrichmentCache:
    """DynamoDB-backed cache for enrichment results.

    Parameters
    ----------
    table_name : str | None
        DynamoDB table name. Falls back to ENRICHMENT_CACHE_TABLE env var.
    dynamodb_resource : optional
        A boto3 DynamoDB resource for dependency injection / testing.
    """

    def __init__(
        self,
        table_name: str | None = None,
        dynamodb_resource=None,
    ) -> None:
        self._table_name = table_name or os.environ.get(_ENV_TABLE_NAME, "")
        self._dynamodb = dynamodb_resource or boto3.resource("dynamodb")
        self._table = self._dynamodb.Table(self._table_name) if self._table_name else None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(
        self,
        content_hash: str,
        element_type: ElementType,
        enrichment_version: str,
        context_hash: str = "",
    ) -> EnrichedElement | None:
        """Look up a cached EnrichedElement.

        Returns the cached element or None on miss or error.
        Errors are logged but never propagated — cache unavailability is
        treated as a cache miss.
        """
        if self._table is None:
            logger.warning("EnrichmentCache table not configured, treating as miss")
            return None

        sort_key = self._build_sort_key(element_type, enrichment_version, context_hash)

        try:
            response = self._table.get_item(
                Key={"content_hash": content_hash, "sort_key": sort_key},
                ConsistentRead=False,
            )
        except Exception:
            logger.warning(
                "EnrichmentCache lookup failed, treating as cache miss",
                extra={"content_hash": content_hash, "enrichment_version": enrichment_version},
                exc_info=True,
            )
            return None

        item = response.get("Item")
        if item is None:
            return None

        try:
            return self._deserialize(item["data"])
        except Exception:
            logger.warning(
                "EnrichmentCache deserialization failed, treating as cache miss",
                extra={"content_hash": content_hash},
                exc_info=True,
            )
            return None

    def put(
        self,
        content_hash: str,
        enriched_element: EnrichedElement,
        element_type: ElementType,
        enrichment_version: str,
        context_hash: str = "",
    ) -> None:
        """Store an EnrichedElement in the cache.

        Errors are logged as warnings and never propagated — store failures
        do not interrupt processing.
        """
        if self._table is None:
            logger.warning("EnrichmentCache table not configured, skipping store")
            return

        sort_key = self._build_sort_key(element_type, enrichment_version, context_hash)

        try:
            serialized = self._serialize(enriched_element)
            self._table.put_item(
                Item={
                    "content_hash": content_hash,
                    "sort_key": sort_key,
                    "data": serialized,
                    "enrichment_version": enrichment_version,
                    "element_type": element_type.value,
                }
            )
        except Exception:
            logger.warning(
                "EnrichmentCache store failed, continuing without cache write",
                extra={"content_hash": content_hash, "enrichment_version": enrichment_version},
                exc_info=True,
            )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_sort_key(
        element_type: ElementType,
        enrichment_version: str,
        context_hash: str,
    ) -> str:
        """Build the DynamoDB sort key based on element type.

        TEXT/FORMULA: SK = enrichment_version
        IMAGE/TABLE: SK = f"{context_hash}#{enrichment_version}"
        """
        if element_type in (ElementType.IMAGE, ElementType.TABLE):
            return f"{context_hash}#{enrichment_version}"
        # TEXT / FORMULA — context-independent
        return enrichment_version

    @staticmethod
    def _serialize(enriched_element: EnrichedElement) -> str:
        """Serialize an EnrichedElement to a JSON string for DynamoDB storage."""
        data = asdict(enriched_element)
        # Convert ElementType enum to its value for JSON compatibility
        data["element_type"] = enriched_element.element_type.value
        return json.dumps(data)

    @staticmethod
    def _deserialize(data_str: str) -> EnrichedElement:
        """Deserialize a JSON string back into an EnrichedElement."""
        data = json.loads(data_str)
        # Restore ElementType enum from stored value
        data["element_type"] = ElementType(data["element_type"])
        # Restore Provenance dataclass from dict
        data["provenance"] = Provenance(**data["provenance"])
        return EnrichedElement(**data)
