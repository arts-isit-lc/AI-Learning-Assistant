"""Unit tests for the Bedrock pricing helper (Phase 0a instrumentation)."""
from __future__ import annotations

import pytest

from .pricing import MODEL_PRICING, estimate_cost_usd

HAIKU = "anthropic.claude-3-haiku-20240307-v1:0"
SONNET = "anthropic.claude-3-sonnet-20240229-v1:0"
TITAN = "amazon.titan-embed-text-v2:0"


class TestEstimateCostUsd:
    def test_haiku_input_and_output(self):
        # 1,000,000 in @ $0.25 + 1,000,000 out @ $1.25 = $1.50
        assert estimate_cost_usd(HAIKU, 1_000_000, 1_000_000) == pytest.approx(1.50)

    def test_sonnet_input_and_output(self):
        # 1M in @ $3.00 + 1M out @ $15.00 = $18.00
        assert estimate_cost_usd(SONNET, 1_000_000, 1_000_000) == pytest.approx(18.00)

    def test_embedding_input_only_no_output_cost(self):
        # Titan bills input only; output rate is 0.
        assert estimate_cost_usd(TITAN, 1_000_000, 0) == pytest.approx(0.02)
        assert estimate_cost_usd(TITAN, 1_000_000, 9999) == pytest.approx(0.02)

    def test_unknown_model_returns_zero(self):
        assert estimate_cost_usd("made-up-model", 1_000_000, 1_000_000) == 0.0

    def test_zero_tokens_is_zero(self):
        assert estimate_cost_usd(HAIKU, 0, 0) == 0.0

    def test_negative_tokens_clamped_to_zero(self):
        assert estimate_cost_usd(HAIKU, -5, -10) == 0.0

    def test_none_tokens_treated_as_zero(self):
        assert estimate_cost_usd(HAIKU, None, None) == 0.0

    def test_typical_reasoning_call_is_small_but_nonzero(self):
        # ~6k input + 800 output Haiku tokens -> well under a cent, but > 0.
        cost = estimate_cost_usd(HAIKU, 6000, 800)
        assert 0.0 < cost < 0.01

    def test_all_registered_models_have_both_rates(self):
        for model_id, rates in MODEL_PRICING.items():
            assert "input" in rates and "output" in rates, model_id
            assert rates["input"] >= 0 and rates["output"] >= 0, model_id
