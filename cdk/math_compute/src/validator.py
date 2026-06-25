"""Validator module — pre-compute checks on parsed input.

Validates:
- Matrix dimensions (square for eigenvalue ops, size ≤ 10x10)
- Entry types (numeric or valid symbolic)
- Operation compatibility with input shape
"""

from __future__ import annotations

from dataclasses import dataclass

from parser import ParseResult


MAX_MATRIX_SIZE = 10
MAX_POLYNOMIAL_DEGREE = 20

# Operations that require a square matrix
SQUARE_REQUIRED_OPS = {"eigenvalues", "determinant", "inverse"}


@dataclass
class ValidationResult:
    """Result of input validation."""
    valid: bool
    reason: str
    error_message: str = ""

    def to_dict(self) -> dict:
        return {"valid": self.valid, "reason": self.reason}


def validate_input(parse_result: ParseResult) -> ValidationResult:
    """Validate parsed input before computation.

    Checks:
    - Matrix size limits
    - Square requirement for eigenvalue/determinant/inverse
    - Entry parseability (numeric or symbolic)
    - Expression structure sanity

    Args:
        parse_result: Successfully parsed input.

    Returns:
        ValidationResult — if invalid, includes user-friendly error.
    """
    if parse_result.object_type == "matrix":
        if not parse_result.matrix_values:
            return ValidationResult(
                valid=False,
                reason="Empty matrix",
                error_message="The matrix appears to be empty.",
            )
        return _validate_matrix(parse_result)
    elif parse_result.object_type == "expression":
        return _validate_expression(parse_result)
    else:
        return ValidationResult(
            valid=True,
            reason="No specific validation needed for this input type",
        )


def _validate_matrix(parse_result: ParseResult) -> ValidationResult:
    """Validate matrix input."""
    rows = parse_result.matrix_values
    if not rows:
        return ValidationResult(
            valid=False,
            reason="Empty matrix",
            error_message="The matrix appears to be empty.",
        )

    num_rows = len(rows)
    num_cols = len(rows[0]) if rows else 0

    # Size limit
    if num_rows > MAX_MATRIX_SIZE or num_cols > MAX_MATRIX_SIZE:
        return ValidationResult(
            valid=False,
            reason=f"Matrix too large: {num_rows}x{num_cols} exceeds {MAX_MATRIX_SIZE}x{MAX_MATRIX_SIZE} limit",
            error_message=(
                f"Matrix is {num_rows}x{num_cols} which exceeds the maximum "
                f"supported size of {MAX_MATRIX_SIZE}x{MAX_MATRIX_SIZE}."
            ),
        )

    # Square check for operations that require it
    if parse_result.operation in SQUARE_REQUIRED_OPS and num_rows != num_cols:
        return ValidationResult(
            valid=False,
            reason=f"Operation '{parse_result.operation}' requires square matrix, got {num_rows}x{num_cols}",
            error_message=(
                f"Computing {parse_result.operation} requires a square matrix, "
                f"but your input is {num_rows}x{num_cols}."
            ),
        )

    # Check entries are parseable
    for i, row in enumerate(rows):
        for j, entry in enumerate(row):
            if not _is_valid_entry(entry):
                return ValidationResult(
                    valid=False,
                    reason=f"Invalid entry at row {i+1}, col {j+1}: '{entry}'",
                    error_message=(
                        f"Could not parse entry '{entry}' at row {i+1}, column {j+1} "
                        f"as a number or valid symbol."
                    ),
                )

    return ValidationResult(
        valid=True,
        reason=f"Matrix {num_rows}x{num_cols} passed all checks",
    )


def _validate_expression(parse_result: ParseResult) -> ValidationResult:
    """Validate expression input."""
    expr = parse_result.expression_str
    if not expr or not expr.strip():
        return ValidationResult(
            valid=False,
            reason="Empty expression",
            error_message="The expression appears to be empty.",
        )

    # Basic sanity: balanced parentheses
    if expr.count("(") != expr.count(")"):
        return ValidationResult(
            valid=False,
            reason="Unbalanced parentheses in expression",
            error_message="The expression has unbalanced parentheses.",
        )

    return ValidationResult(
        valid=True,
        reason="Expression passed basic validation",
    )


def _is_valid_entry(entry: str) -> bool:
    """Check if a matrix entry is a valid number or symbol."""
    entry = entry.strip()
    if not entry:
        return False

    # Try as numeric
    try:
        float(entry)
        return True
    except ValueError:
        pass

    # Allow symbolic entries (single letter variables, simple expressions)
    import re
    if re.match(r"^[a-zA-Z_]\w*$", entry):
        return True  # simple variable like 'a', 'x', 'lambda'

    # Allow simple symbolic expressions (a+1, -b, 2*x)
    if re.match(r"^[-+]?[\w.*/+\-^()]+$", entry):
        return True

    return False
