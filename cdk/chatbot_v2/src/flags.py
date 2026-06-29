"""Feature flags for safe, reversible optimization rollout — Phase 0b.

Each optimization that can affect runtime behavior is gated by an environment
variable so it can be toggled per environment (via the Lambda's CDK
configuration) and rolled back without a code change.

Safety contract: **every flag defaults to the pre-optimization behavior**, so
deploying this code is a no-op until a flag is explicitly enabled. Behavioral
changes stay OFF until validated.

Flags are parsed once at module import (cold start). The pure ``parse_flag``
helper is exposed for deterministic unit testing.
"""
from __future__ import annotations

import os

_TRUTHY = {"1", "true", "yes", "on"}


def parse_flag(raw_value, default: bool) -> bool:
    """Parse an env-var string into a bool (see module docstring)."""
    if raw_value is None:
        return default
    return str(raw_value).strip().lower() in _TRUTHY


def _flag(name: str, default: bool) -> bool:
    return parse_flag(os.environ.get(name), default)


# --- Behavior-changing (default OFF = current behavior) -----------------------
# #11: on a guardrail SERVICE error, return the safe fallback instead of
# re-running generation without guardrails.
GUARDRAIL_FAIL_CLOSED = _flag("GUARDRAIL_FAIL_CLOSED", default=False)

# --- Behavior-preserving optimizations (default OFF for a no-op deploy) --------
# #8: move the post-stream RDS projection + engagement logging off the billed
# response path (fire-and-forget / async).
ASYNC_RDS_PROJECTION = _flag("ASYNC_RDS_PROJECTION", default=False)
# #4: run answer evaluation and RAG retrieval concurrently (independent inputs).
PARALLEL_EVAL_RETRIEVAL = _flag("PARALLEL_EVAL_RETRIEVAL", default=False)
# #10: cache static-per-module values (module_name, allowed_file_ids) in state.
CACHE_MODULE_METADATA = _flag("CACHE_MODULE_METADATA", default=False)
