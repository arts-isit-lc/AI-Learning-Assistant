"""Bedrock model pricing helpers for per-call cost measurement.

Phase 0a (cost/performance instrumentation): the authoritative per-request
cost is reconstructed from the structured ``bedrock_call`` log events emitted
at each invocation site (model_id, input/output tokens, est_cost_usd,
latency_ms), correlated by ``query_id`` in CloudWatch Logs Insights. This
module provides the rate table + a pure helper those sites and the coarse
``_estimate_cost`` summary share.

Rates are on-demand list prices (USD per 1,000,000 tokens) for the models in
use. They can drift — update this table when Bedrock pricing changes or a new
model is onboarded (see the cdk-conventions "Adding a New Bedrock Model"
checklist). Embeddings bill input tokens only.
"""
from __future__ import annotations

# USD per 1,000,000 tokens: {model_id: {"input": rate, "output": rate}}.
# Keyed on the BARE foundation-model id. Callers now pass Geo-US cross-Region
# inference-profile ids (e.g. "us.anthropic.claude-haiku-4-5-..."); the geo
# prefix is stripped in estimate_cost_usd before lookup. Claude 3 rates are
# retained so historical bedrock_call logs still reconstruct correctly.
MODEL_PRICING: dict[str, dict[str, float]] = {
    # Current models (Claude 4.5 family via cross-Region inference)
    "anthropic.claude-sonnet-4-5-20250929-v1:0": {"input": 3.00, "output": 15.00},
    "anthropic.claude-haiku-4-5-20251001-v1:0": {"input": 1.00, "output": 5.00},
    "amazon.titan-embed-text-v2:0": {"input": 0.02, "output": 0.0},
    # Retired models (kept for historical log cost reconstruction)
    "anthropic.claude-3-haiku-20240307-v1:0": {"input": 0.25, "output": 1.25},
    "anthropic.claude-3-sonnet-20240229-v1:0": {"input": 3.00, "output": 15.00},
}

# Geo/global cross-Region inference profile prefixes stripped before pricing
# lookup so a profile id resolves to its underlying foundation-model rate.
_INFERENCE_PROFILE_PREFIXES: tuple[str, ...] = (
    "us.",
    "eu.",
    "au.",
    "jp.",
    "apac.",
    "us-gov.",
    "global.",
)


def _normalize_model_id(model_id: str) -> str:
    """Strip a leading cross-Region inference-profile prefix from a model id.

    "us.anthropic.claude-haiku-4-5-20251001-v1:0" ->
    "anthropic.claude-haiku-4-5-20251001-v1:0". Ids without a known prefix are
    returned unchanged.
    """
    if not model_id:
        return model_id
    for prefix in _INFERENCE_PROFILE_PREFIXES:
        if model_id.startswith(prefix):
            return model_id[len(prefix):]
    return model_id


def estimate_cost_usd(
    model_id: str, input_tokens: int = 0, output_tokens: int = 0
) -> float:
    """Estimate the USD cost of a single Bedrock call from token counts.

    Pure and side-effect free. Unknown models return 0.0 (callers should log
    the unknown model id so the table can be updated). Cross-Region inference
    profile ids (geo-prefixed) are normalized to their foundation-model id
    before lookup. Token counts are clamped to be non-negative so a
    missing/garbled usage block can never produce a negative or
    exception-raising cost.

    Args:
        model_id: Bedrock foundation-model id or cross-Region inference-profile id.
        input_tokens: Prompt/input token count for the call.
        output_tokens: Generated/output token count (0 for embeddings).

    Returns:
        Estimated cost in USD as a float (0.0 for unknown models).
    """
    rates = MODEL_PRICING.get(_normalize_model_id(model_id))
    if not rates:
        return 0.0
    safe_in = max(0, int(input_tokens or 0))
    safe_out = max(0, int(output_tokens or 0))
    return (
        (safe_in / 1_000_000.0) * rates["input"]
        + (safe_out / 1_000_000.0) * rates["output"]
    )
