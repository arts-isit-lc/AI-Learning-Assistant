"""Feature flags for safe, reversible optimization rollout — Phase 0b.

Each optimization that can affect runtime behavior is gated by an environment
variable so it can be toggled per environment (via the Lambda's CDK
configuration) and rolled back without a code change.

Safety contract: **every flag defaults to the pre-optimization behavior**, so
deploying this code is a no-op until a flag is explicitly enabled. Behavioral
changes stay OFF until the offline eval harness is green and a human signs off.

Flags are parsed once at module import (cold start) to keep the request hot
path free of per-invoke env lookups. The pure ``parse_flag`` helper is exposed
for deterministic unit testing.
"""
from __future__ import annotations

import os

_TRUTHY = {"1", "true", "yes", "on"}


def parse_flag(raw_value: str | None, default: bool) -> bool:
    """Parse an env-var string into a bool.

    Args:
        raw_value: The raw env value (or None if unset).
        default: Value to use when unset (should equal current behavior).

    Returns:
        True if the value is one of {1,true,yes,on} (case/space-insensitive),
        the default when unset, else False.
    """
    if raw_value is None:
        return default
    return raw_value.strip().lower() in _TRUTHY


def _flag(name: str, default: bool) -> bool:
    return parse_flag(os.environ.get(name), default)


# --- Behavior-changing (default OFF = current behavior; opt-in per env) -------
# #1: retrieval returns ranked passages instead of a generated Haiku answer.
RAG_RETURN_PASSAGES = _flag("RAG_RETURN_PASSAGES", default=False)
# #9: require an explicit figure reference (not a bare keyword) to run vision.
STRICT_IMAGE_ESCALATION = _flag("STRICT_IMAGE_ESCALATION", default=False)

# --- Behavior-preserving optimizations (default OFF for a no-op deploy) --------
# #5: cache query embeddings in the existing DynamoDB EmbeddingCache.
QUERY_EMBEDDING_CACHE = _flag("QUERY_EMBEDDING_CACHE", default=False)
# #4: parallelize the two independent image-escalation vision calls.
PARALLEL_IMAGE_ESCALATION = _flag("PARALLEL_IMAGE_ESCALATION", default=False)
