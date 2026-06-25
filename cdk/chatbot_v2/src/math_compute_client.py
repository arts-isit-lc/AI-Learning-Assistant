"""Math compute client — invokes the math_compute Lambda synchronously.

Returns verified computation results or structured failure information
for injection into the chatbot's system prompt.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from aws_lambda_powertools import Logger

from math_classifier import MathClassification

logger = Logger(service="chatbot-v2")


@dataclass
class MathComputeResult:
    """Result from the math compute Lambda."""
    success: bool
    status: str = ""                  # verified | partial | failed
    answer: dict[str, Any] = field(default_factory=dict)
    verification: dict[str, Any] = field(default_factory=dict)
    failure_reason: str = ""
    failure_message: str = ""
    clarification_needed: list[dict] | None = None

    def get_prompt_injection(self) -> str:
        """Format the compute result for injection into the LLM system prompt.

        Returns a string that instructs the LLM how to use verified values.
        """
        if self.status == "verified":
            return self._format_verified()
        elif self.status == "partial":
            return self._format_partial()
        elif self.clarification_needed:
            return self._format_clarification()
        else:
            return self._format_failed()

    def _format_verified(self) -> str:
        """Format verified compute result for prompt injection."""
        lines = [
            "VERIFIED COMPUTATION (✅ computed by math engine):",
            ""
        ]

        # Format answer fields
        for key, value in self.answer.items():
            if key == "eigenvectors":
                # Format eigenvectors readably
                for ev in value:
                    lines.append(f"  Eigenvector for λ={ev['eigenvalue']}: {ev['vector']}")
            elif key == "inverse":
                lines.append(f"  {key}:")
                for row in value:
                    lines.append(f"    [{', '.join(row)}]")
            elif key == "rref":
                lines.append(f"  {key}:")
                for row in value:
                    lines.append(f"    [{', '.join(row)}]")
            else:
                lines.append(f"  {key}: {value}")

        # Verification info
        method = self.verification.get("method", "")
        scope = self.verification.get("scope", "")
        if method and method != "none":
            lines.append(f"\n  Verification: {method} ({scope}) — PASSED")

        lines.extend([
            "",
            "IMPORTANT: The values above are verified. Reproduce them EXACTLY.",
            "Do NOT round, approximate, recalculate, or modify any numerical values.",
            "You may explain what the results mean — but only derivations directly",
            "supported by the computed values (e.g., 'both eigenvalues are positive,",
            "so the matrix is positive definite'). Do NOT claim geometric or physical",
            "interpretations that require additional computation.",
        ])

        return "\n".join(lines)

    def _format_partial(self) -> str:
        """Format partially verified result."""
        lines = [
            "COMPUTATION RESULT (⚠️ partially verified):",
            ""
        ]
        for key, value in self.answer.items():
            if key not in ("eigenvectors", "inverse", "rref"):
                lines.append(f"  {key}: {value}")

        lines.extend([
            "",
            "Note: This result was computed but verification was inconclusive.",
            "Present these values but note they should be double-checked.",
        ])
        return "\n".join(lines)

    def _format_clarification(self) -> str:
        """Format clarification request."""
        lines = [
            "MATH INPUT AMBIGUOUS — clarification needed:",
            ""
        ]
        if self.clarification_needed:
            for candidate in self.clarification_needed:
                lines.append(f"  • {candidate.get('interpretation', 'Unknown')}")
        lines.extend([
            "",
            "Ask the student to clarify which interpretation they meant.",
            "Do NOT guess or assume. Present the options and ask.",
        ])
        return "\n".join(lines)

    def _format_failed(self) -> str:
        """Format failure information."""
        if self.failure_reason == "parse_error":
            return (
                "MATH COMPUTE: Could not parse the mathematical input.\n"
                f"Reason: {self.failure_message}\n\n"
                "Explain the METHOD to the student without performing the calculation.\n"
                "Say you can explain the approach but recommend they use a tool like\n"
                "Wolfram Alpha for the exact values."
            )
        elif self.failure_reason == "unsupported_operation":
            return (
                "MATH COMPUTE: Operation not yet supported.\n"
                f"Reason: {self.failure_message}\n\n"
                "You can explain the method conceptually but cannot provide\n"
                "verified numerical results for this operation."
            )
        else:
            return (
                f"MATH COMPUTE: Computation failed ({self.failure_reason}).\n"
                f"Reason: {self.failure_message}\n\n"
                "Explain the method to the student without claiming specific values.\n"
                "Recommend verifying with a calculator or math tool."
            )


def invoke_math_compute(
    lambda_client,
    function_arn: str,
    classification: MathClassification,
) -> MathComputeResult | None:
    """Invoke the math_compute Lambda synchronously.

    Args:
        lambda_client: Boto3 Lambda client.
        function_arn: ARN of the math_compute Lambda.
        classification: Classification result with query and operation hint.

    Returns:
        MathComputeResult on success/failure, None if invocation completely fails.
    """
    if not function_arn:
        logger.warning("MATH_COMPUTE_FUNCTION_ARN not configured, skipping compute")
        return None

    try:
        payload = {
            "raw_input": classification.raw_math_content,
            "operation_hint": classification.operation_hint,
            "source": "explicit",
        }

        logger.info(
            "Invoking math compute Lambda",
            extra={
                "operation_hint": classification.operation_hint,
                "input_length": len(classification.raw_math_content),
            },
        )

        response = lambda_client.invoke(
            FunctionName=function_arn,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode(),
        )

        response_payload = json.loads(response["Payload"].read())

        status = response_payload.get("status", "failed")
        answer = response_payload.get("answer")
        verification = response_payload.get("verification")
        failure_reason = response_payload.get("failure_reason")
        failure_message = response_payload.get("failure_message")
        clarification = response_payload.get("clarification_needed")

        logger.info(
            "Math compute result received",
            extra={
                "status": status,
                "failure_reason": failure_reason,
                "has_answer": answer is not None,
                "has_clarification": clarification is not None,
            },
        )

        return MathComputeResult(
            success=(status in ("verified", "partial")),
            status=status,
            answer=answer or {},
            verification=verification or {},
            failure_reason=failure_reason or "",
            failure_message=failure_message or "",
            clarification_needed=clarification,
        )

    except Exception:
        logger.exception("Math compute Lambda invocation failed")
        return None
