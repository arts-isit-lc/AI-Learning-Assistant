"""Ambiguity gate — blocks computation if input has multiple valid interpretations.

Global invariant: if structure cannot be deterministically resolved → STOP.
Never guess. Ask clarification.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from parser import ParseResult


@dataclass
class AmbiguityResult:
    """Result of ambiguity check."""
    is_ambiguous: bool
    reason: str
    clarification_message: str = ""
    candidates: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "is_ambiguous": self.is_ambiguous,
            "candidate_count": len(self.candidates),
        }


def check_ambiguity(parse_result: ParseResult) -> AmbiguityResult:
    """Check if the parsed input is ambiguous.

    Ambiguity exists when:
    - Multiple valid mathematical structures can be inferred
    - Bare numbers without explicit structural delimiters
    - Object type is marked as "ambiguous" by parser

    Args:
        parse_result: The result from the parser.

    Returns:
        AmbiguityResult — if ambiguous, includes candidates for clarification.
    """
    # Check if parser flagged ambiguity
    if parse_result.object_type == "ambiguous" and parse_result.ambiguous_interpretations:
        candidates = parse_result.ambiguous_interpretations
        candidate_descriptions = [c["interpretation"] for c in candidates]

        clarification_msg = (
            "I found multiple valid interpretations of your input:\n"
            + "\n".join(f"  • {desc}" for desc in candidate_descriptions)
            + "\n\nPlease clarify which you meant, or provide the input with "
            "explicit structure (e.g., [[2,1],[1,2]] for a matrix)."
        )

        return AmbiguityResult(
            is_ambiguous=True,
            reason=f"Multiple valid interpretations: {', '.join(candidate_descriptions)}",
            clarification_message=clarification_msg,
            candidates=candidates,
        )

    # Check for matrix with inconsistent row lengths (structural ambiguity)
    if parse_result.matrix_values:
        row_lengths = [len(row) for row in parse_result.matrix_values]
        if len(set(row_lengths)) > 1:
            return AmbiguityResult(
                is_ambiguous=True,
                reason=f"Matrix rows have inconsistent lengths: {row_lengths}",
                clarification_message=(
                    f"The matrix has rows with different lengths ({row_lengths}). "
                    "Please check your input — all rows should have the same number of entries."
                ),
                candidates=[],
            )

    # No ambiguity detected
    return AmbiguityResult(
        is_ambiguous=False,
        reason="Input is unambiguous",
    )
