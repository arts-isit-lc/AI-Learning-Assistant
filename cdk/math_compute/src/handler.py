"""Math Compute Lambda handler.

Orchestrates: parse → ambiguity gate → validate → compute → verify.
Returns structured JSON with answer, verification status, and execution trace.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from aws_lambda_powertools import Logger

from parser import parse_math_input
from ambiguity_gate import check_ambiguity
from validator import validate_input
from compute import execute_computation
from verifier import verify_result
from step_generator import generate_steps
from compare import compare_expressions

logger = Logger(service="math-compute")


@logger.inject_lambda_context(clear_state=True)
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Math Compute Lambda handler.

    Event format:
    {
        "raw_input": "find eigenvalues of [[2,1],[1,2]]",
        "operation_hint": "eigenvalues",  # optional — from classifier
        "source": "explicit"              # "explicit" in V1
    }

    Response format:
    {
        "status": "verified" | "partial" | "failed",
        "answer": { ... },
        "verification": { ... },
        "failure_reason": null | "parse_error" | ...,
        "clarification_needed": null | { ... },
        "trace": { ... }
    }
    """
    trace_id = str(uuid.uuid4())
    start_time = time.time()
    stages: list[dict] = []

    # Tier-2 formula comparison: compare two expressions/equations for symbolic
    # equivalence. Distinct entry from the single-input compute pipeline below.
    if event.get("operation") == "compare_expressions":
        return _handle_compare_expressions(event, trace_id, start_time)

    raw_input = event.get("raw_input", "").strip()
    operation_hint = event.get("operation_hint")

    if not raw_input:
        return _build_response(
            status="failed",
            failure_reason="parse_error",
            failure_message="No mathematical input provided.",
            trace_id=trace_id,
            stages=stages,
            start_time=start_time,
        )

    # ─── Stage 1: Parse ────────────────────────────────────────────────────
    parse_start = time.time()
    parse_result = parse_math_input(raw_input, operation_hint=operation_hint)
    stages.append({
        "stage": "parser",
        "result": parse_result.to_dict(),
        "reason": parse_result.reason,
        "latency_ms": round((time.time() - parse_start) * 1000, 2),
    })

    if not parse_result.success:
        return _build_response(
            status="failed",
            failure_reason="parse_error",
            failure_message=parse_result.error_message,
            trace_id=trace_id,
            stages=stages,
            start_time=start_time,
        )

    # ─── Stage 2: Ambiguity Gate ───────────────────────────────────────────
    ambiguity_start = time.time()
    ambiguity_result = check_ambiguity(parse_result)
    stages.append({
        "stage": "ambiguity_gate",
        "result": ambiguity_result.to_dict(),
        "reason": ambiguity_result.reason,
        "latency_ms": round((time.time() - ambiguity_start) * 1000, 2),
    })

    if ambiguity_result.is_ambiguous:
        return _build_response(
            status="failed",
            failure_reason="ambiguous_input",
            failure_message=ambiguity_result.clarification_message,
            clarification_needed=ambiguity_result.candidates,
            trace_id=trace_id,
            stages=stages,
            start_time=start_time,
        )

    # ─── Stage 3: Validate ─────────────────────────────────────────────────
    validate_start = time.time()
    validation_result = validate_input(parse_result)
    stages.append({
        "stage": "validator",
        "result": validation_result.to_dict(),
        "reason": validation_result.reason,
        "latency_ms": round((time.time() - validate_start) * 1000, 2),
    })

    if not validation_result.valid:
        return _build_response(
            status="failed",
            failure_reason="validation_failed",
            failure_message=validation_result.error_message,
            trace_id=trace_id,
            stages=stages,
            start_time=start_time,
        )

    # ─── Stage 4: Compute ──────────────────────────────────────────────────
    compute_start = time.time()
    compute_result = execute_computation(parse_result)
    stages.append({
        "stage": "compute",
        "result": compute_result.to_dict(),
        "reason": compute_result.method,
        "latency_ms": round((time.time() - compute_start) * 1000, 2),
    })

    if not compute_result.success:
        return _build_response(
            status="failed",
            failure_reason=compute_result.failure_reason,
            failure_message=compute_result.error_message,
            trace_id=trace_id,
            stages=stages,
            start_time=start_time,
        )

    # ─── Stage 5: Verify ───────────────────────────────────────────────────
    verify_start = time.time()
    verification_result = verify_result(parse_result, compute_result)
    stages.append({
        "stage": "verify",
        "result": verification_result.to_dict(),
        "reason": verification_result.reason,
        "latency_ms": round((time.time() - verify_start) * 1000, 2),
    })

    # ─── Build Response ────────────────────────────────────────────────────
    status = "verified" if verification_result.passed else "partial"

    # ─── Generate Solution Steps (V2) ──────────────────────────────────────
    steps = []
    try:
        step_objects = generate_steps(parse_result.operation, parse_result, compute_result)
        steps = [s.to_dict() for s in step_objects]
    except Exception:
        logger.exception("Step generation failed (non-blocking)")

    return _build_response(
        status=status,
        answer=compute_result.answer,
        verification=verification_result.to_dict(),
        steps=steps,
        trace_id=trace_id,
        stages=stages,
        start_time=start_time,
    )


def _handle_compare_expressions(
    event: dict[str, Any], trace_id: str, start_time: float
) -> dict[str, Any]:
    """Compare two expressions/equations for symbolic equivalence (Tier 2).

    Response carries a ``comparison`` block: {equivalent: True|False|None,
    method, reason}. equivalent=None means "not determined" (unparseable or
    SymPy could not decide) — the caller degrades to a lexical-only comparison.
    """
    left = (event.get("left") or "").strip()
    right = (event.get("right") or "").strip()
    if not left or not right:
        comparison = {"equivalent": None, "method": "", "reason": "missing input"}
        status = "failed"
        failure_reason: str | None = "parse_error"
        failure_message: str | None = "compare_expressions requires non-empty 'left' and 'right'."
    else:
        comparison = compare_expressions(left, right)
        failure_reason = None
        failure_message = None
        # A determinate verdict (True/False) is 'verified'; None is 'partial'.
        status = "verified" if comparison.get("equivalent") is not None else "partial"

    total_latency = round((time.time() - start_time) * 1000, 2)
    logger.info(
        "compare_expressions complete",
        extra={
            "trace_id": trace_id,
            "status": status,
            "equivalent": comparison.get("equivalent"),
            "total_latency_ms": total_latency,
        },
    )
    return {
        "status": status,
        "comparison": comparison,
        "answer": None,
        "verification": None,
        "steps": [],
        "failure_reason": failure_reason,
        "failure_message": failure_message,
        "clarification_needed": None,
        "trace": {"trace_id": trace_id, "stages": [], "total_latency_ms": total_latency},
    }


def _build_response(
    status: str,
    trace_id: str,
    stages: list[dict],
    start_time: float,
    answer: dict | None = None,
    verification: dict | None = None,
    steps: list[dict] | None = None,
    failure_reason: str | None = None,
    failure_message: str | None = None,
    clarification_needed: list | None = None,
) -> dict[str, Any]:
    """Build standardized response with execution trace."""
    total_latency = round((time.time() - start_time) * 1000, 2)

    response = {
        "status": status,
        "answer": answer,
        "verification": verification,
        "steps": steps or [],
        "failure_reason": failure_reason,
        "failure_message": failure_message,
        "clarification_needed": clarification_needed,
        "trace": {
            "trace_id": trace_id,
            "stages": stages,
            "total_latency_ms": total_latency,
        },
    }

    logger.info(
        "Math compute request complete",
        extra={
            "trace_id": trace_id,
            "status": status,
            "failure_reason": failure_reason,
            "total_latency_ms": total_latency,
            "stage_count": len(stages),
        },
    )

    return response
