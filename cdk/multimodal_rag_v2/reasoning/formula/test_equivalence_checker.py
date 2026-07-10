"""Tests for MathComputeEquivalenceChecker (Tier 2, mocked Lambda)."""

from __future__ import annotations

import io
import json

from ...models.data_models import EquivalenceStatus
from .equivalence_checker import MathComputeEquivalenceChecker


class _FakeLambda:
    def __init__(self, payload=None, raise_exc=None):
        self._payload = payload
        self._raise = raise_exc
        self.calls: list[dict] = []

    def invoke(self, FunctionName, InvocationType, Payload):  # noqa: N803 (boto3 kwarg names)
        self.calls.append({
            "FunctionName": FunctionName,
            "InvocationType": InvocationType,
            "payload": json.loads(Payload.decode()),
        })
        if self._raise is not None:
            raise self._raise
        return {"Payload": io.BytesIO(json.dumps(self._payload).encode())}


def _checker(payload=None, raise_exc=None, function_name="math-compute"):
    client = _FakeLambda(payload=payload, raise_exc=raise_exc)
    return MathComputeEquivalenceChecker(client, function_name), client


def test_equivalent_maps_to_equivalent():
    checker, client = _checker({"status": "verified", "comparison": {"equivalent": True, "method": "sympy", "reason": "0"}})
    result = checker.check("x+1", "1+x")
    assert result.status is EquivalenceStatus.EQUIVALENT
    assert result.method == "sympy"
    # Correct operation + payload sent.
    assert client.calls[0]["payload"] == {"operation": "compare_expressions", "left": "x+1", "right": "1+x"}


def test_not_equivalent_maps_to_not_equivalent():
    checker, _ = _checker({"comparison": {"equivalent": False, "method": "sympy", "reason": "diff=1"}})
    assert checker.check("x", "y").status is EquivalenceStatus.NOT_EQUIVALENT


def test_none_maps_to_unknown():
    checker, _ = _checker({"comparison": {"equivalent": None, "reason": "parse_failed"}})
    assert checker.check(r"\frac{", "x").status is EquivalenceStatus.UNKNOWN


def test_missing_comparison_block_is_unknown():
    checker, _ = _checker({"status": "failed"})
    assert checker.check("x", "y").status is EquivalenceStatus.UNKNOWN


def test_invoke_error_degrades_to_unknown():
    checker, _ = _checker(raise_exc=RuntimeError("throttled"))
    assert checker.check("x", "y").status is EquivalenceStatus.UNKNOWN


def test_no_function_name_is_unknown_without_invoking():
    checker, client = _checker(function_name="")
    assert checker.check("x", "y").status is EquivalenceStatus.UNKNOWN
    assert client.calls == []
