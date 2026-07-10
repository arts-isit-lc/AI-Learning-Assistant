"""Tier 2 symbolic equivalence checker (math_compute-backed).

Invokes the ``math_compute`` Lambda's ``compare_expressions`` operation and maps
the result to an ``EquivalenceResult``. Never raises: any failure (no client,
invoke error, malformed response, or an undecided verdict) yields UNKNOWN so the
lexical Tier 1 comparison always stands.
"""

from __future__ import annotations

import json
from typing import Any, Protocol

from aws_lambda_powertools import Logger

from ...models.data_models import EquivalenceResult, EquivalenceStatus

logger = Logger(service="multimodal-rag-reasoning")


class SymbolicEquivalenceChecker(Protocol):
    """Checks whether two formula LaTeX strings are symbolically equivalent."""

    def check(self, left: str, right: str) -> EquivalenceResult:
        ...


class MathComputeEquivalenceChecker:
    """Symbolic equivalence via the math_compute Lambda (Tier 2)."""

    def __init__(self, lambda_client: Any, function_name: str) -> None:
        self._lambda_client = lambda_client
        self._function_name = function_name

    def check(self, left: str, right: str) -> EquivalenceResult:
        if not self._lambda_client or not self._function_name:
            return EquivalenceResult()  # UNKNOWN — misconfigured, degrade
        try:
            response = self._lambda_client.invoke(
                FunctionName=self._function_name,
                InvocationType="RequestResponse",
                Payload=json.dumps(
                    {"operation": "compare_expressions", "left": left, "right": right}
                ).encode(),
            )
            payload = json.loads(response["Payload"].read())
            comparison = payload.get("comparison") or {}
            equivalent = comparison.get("equivalent")
            method = comparison.get("method", "") or ""
            reason = comparison.get("reason", "") or ""

            if equivalent is True:
                return EquivalenceResult(EquivalenceStatus.EQUIVALENT, method, reason)
            if equivalent is False:
                return EquivalenceResult(EquivalenceStatus.NOT_EQUIVALENT, method, reason)
            return EquivalenceResult(EquivalenceStatus.UNKNOWN, method, reason or "not determined")
        except Exception:
            logger.exception(
                "math_compute compare_expressions invoke failed; equivalence unknown"
            )
            return EquivalenceResult(EquivalenceStatus.UNKNOWN, "", "invoke_failed")
