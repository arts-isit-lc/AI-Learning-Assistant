"""Compute module — executes SymPy operations on validated input.

Phase 1 operations: eigenvalues, determinant, inverse, RREF.
Each returns structured JSON with the computation results.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import sympy
from sympy import Matrix, simplify, nsimplify
from sympy.parsing.sympy_parser import parse_expr

from parser import ParseResult


@dataclass
class ComputeResult:
    """Result of a SymPy computation."""
    success: bool
    answer: dict[str, Any] = field(default_factory=dict)
    method: str = ""
    failure_reason: str = ""
    error_message: str = ""
    # Internal: the SymPy objects for verification
    _matrix: Any = field(default=None, repr=False)
    _eigenvalues: Any = field(default=None, repr=False)
    _eigenvectors: Any = field(default=None, repr=False)

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "method": self.method,
            "answer_keys": list(self.answer.keys()) if self.answer else [],
        }


def execute_computation(parse_result: ParseResult) -> ComputeResult:
    """Execute the requested computation using SymPy.

    Routes to the appropriate operation handler based on parse_result.operation.

    Args:
        parse_result: Validated parse result.

    Returns:
        ComputeResult with structured answer or failure info.
    """
    try:
        if parse_result.object_type == "matrix":
            return _compute_matrix_operation(parse_result)
        elif parse_result.object_type == "expression":
            return _compute_expression_operation(parse_result)
        else:
            return ComputeResult(
                success=False,
                failure_reason="unsupported_operation",
                error_message=f"Cannot compute on object type '{parse_result.object_type}'.",
            )
    except sympy.SympifyError as e:
        return ComputeResult(
            success=False,
            failure_reason="parse_error",
            error_message=f"SymPy could not interpret the input: {e}",
        )
    except Exception as e:
        return ComputeResult(
            success=False,
            failure_reason="compute_error",
            error_message=f"Computation failed: {type(e).__name__}: {e}",
        )


def _compute_matrix_operation(parse_result: ParseResult) -> ComputeResult:
    """Compute a matrix operation."""
    # Build SymPy Matrix from parsed values
    matrix = _build_sympy_matrix(parse_result)

    operation = parse_result.operation

    if operation == "eigenvalues":
        return _compute_eigenvalues(matrix)
    elif operation == "determinant":
        return _compute_determinant(matrix)
    elif operation == "inverse":
        return _compute_inverse(matrix)
    elif operation == "rref":
        return _compute_rref(matrix)
    else:
        # Default to eigenvalues for matrix with no explicit operation
        return _compute_eigenvalues(matrix)


def _compute_expression_operation(parse_result: ParseResult) -> ComputeResult:
    """Compute an expression operation (derivative, integral, solve)."""
    expr_str = parse_result.expression_str or parse_result.sympy_input

    try:
        expr = parse_expr(expr_str)
    except Exception as e:
        return ComputeResult(
            success=False,
            failure_reason="parse_error",
            error_message=f"Could not parse expression '{expr_str}': {e}",
        )

    # Find the variable (first free symbol alphabetically)
    free_vars = sorted(expr.free_symbols, key=str)
    if not free_vars:
        return ComputeResult(
            success=False,
            failure_reason="validation_failed",
            error_message="Expression has no variables to operate on.",
        )
    var = free_vars[0]

    operation = parse_result.operation

    if operation == "derivative":
        return _compute_derivative(expr, var)
    elif operation == "integral":
        return _compute_integral(expr, var)
    elif operation in ("solve", "roots"):
        return _compute_solve(expr, var)
    else:
        return ComputeResult(
            success=False,
            failure_reason="unsupported_operation",
            error_message=f"Operation '{operation}' not supported for expressions.",
        )


# ──────────────────────────────────────────────────────────────────────────────
# Matrix operations
# ──────────────────────────────────────────────────────────────────────────────

def _build_sympy_matrix(parse_result: ParseResult) -> Matrix:
    """Build a SymPy Matrix from parsed values."""
    rows = parse_result.matrix_values
    if not rows:
        raise ValueError("No matrix values to build")

    # Parse each entry as a SymPy expression
    sympy_rows = []
    for row in rows:
        sympy_row = []
        for entry in row:
            sympy_row.append(parse_expr(str(entry).strip()))
        sympy_rows.append(sympy_row)

    return Matrix(sympy_rows)


def _compute_eigenvalues(matrix: Matrix) -> ComputeResult:
    """Compute eigenvalues and eigenvectors."""
    eigenvals = matrix.eigenvals()  # {eigenvalue: multiplicity}
    eigenvects = matrix.eigenvects()  # [(eigenval, multiplicity, [eigenvectors])]

    # Format eigenvalues as list (sorted for determinism)
    eigenvalue_list = []
    for val, mult in sorted(eigenvals.items(), key=lambda x: complex(x[0]).real, reverse=True):
        # Try to get numeric value for display
        numeric_val = complex(val.evalf())
        if abs(numeric_val.imag) < 1e-10:
            eigenvalue_list.append(float(numeric_val.real))
        else:
            eigenvalue_list.append(str(val))

    # Format eigenvectors
    eigenvector_list = []
    for val, mult, vects in eigenvects:
        for v in vects:
            eigenvector_list.append({
                "eigenvalue": float(complex(val.evalf()).real) if abs(complex(val.evalf()).imag) < 1e-10 else str(val),
                "vector": [str(x) for x in v],
                "multiplicity": mult,
            })

    # Characteristic polynomial
    lam = sympy.Symbol("lambda")
    char_poly = matrix.charpoly(lam)
    char_poly_str = str(char_poly.as_expr())

    return ComputeResult(
        success=True,
        answer={
            "eigenvalues": eigenvalue_list,
            "eigenvectors": eigenvector_list,
            "characteristic_polynomial": char_poly_str,
            "matrix_size": f"{matrix.rows}x{matrix.cols}",
        },
        method="Matrix.eigenvals() + eigenvects() + charpoly()",
        _matrix=matrix,
        _eigenvalues=eigenvals,
        _eigenvectors=eigenvects,
    )


def _compute_determinant(matrix: Matrix) -> ComputeResult:
    """Compute matrix determinant."""
    det = matrix.det()
    det_value = float(det.evalf()) if det.is_number else str(det)

    return ComputeResult(
        success=True,
        answer={
            "determinant": det_value,
            "matrix_size": f"{matrix.rows}x{matrix.cols}",
        },
        method="Matrix.det()",
        _matrix=matrix,
    )


def _compute_inverse(matrix: Matrix) -> ComputeResult:
    """Compute matrix inverse."""
    det = matrix.det()
    if det == 0:
        return ComputeResult(
            success=False,
            failure_reason="compute_error",
            error_message="Matrix is singular (determinant = 0) and has no inverse.",
        )

    inv = matrix.inv()
    # Format as list of lists
    inv_values = [[str(simplify(inv[i, j])) for j in range(inv.cols)] for i in range(inv.rows)]

    return ComputeResult(
        success=True,
        answer={
            "inverse": inv_values,
            "determinant": float(det.evalf()) if det.is_number else str(det),
            "matrix_size": f"{matrix.rows}x{matrix.cols}",
        },
        method="Matrix.inv()",
        _matrix=matrix,
    )


def _compute_rref(matrix: Matrix) -> ComputeResult:
    """Compute reduced row echelon form."""
    rref_matrix, pivot_cols = matrix.rref()
    rref_values = [[str(simplify(rref_matrix[i, j])) for j in range(rref_matrix.cols)] for i in range(rref_matrix.rows)]

    return ComputeResult(
        success=True,
        answer={
            "rref": rref_values,
            "pivot_columns": list(pivot_cols),
            "rank": len(pivot_cols),
            "matrix_size": f"{matrix.rows}x{matrix.cols}",
        },
        method="Matrix.rref()",
        _matrix=matrix,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Expression operations
# ──────────────────────────────────────────────────────────────────────────────

def _compute_derivative(expr, var) -> ComputeResult:
    """Compute derivative of expression."""
    result = sympy.diff(expr, var)
    return ComputeResult(
        success=True,
        answer={
            "derivative": str(result),
            "original": str(expr),
            "variable": str(var),
        },
        method=f"diff({expr}, {var})",
    )


def _compute_integral(expr, var) -> ComputeResult:
    """Compute indefinite integral."""
    result = sympy.integrate(expr, var)
    return ComputeResult(
        success=True,
        answer={
            "integral": str(result),
            "original": str(expr),
            "variable": str(var),
            "note": "+ C (constant of integration)",
        },
        method=f"integrate({expr}, {var})",
    )


def _compute_solve(expr, var) -> ComputeResult:
    """Solve equation (expr = 0)."""
    solutions = sympy.solve(expr, var)
    solution_strs = [str(s) for s in solutions]

    # Get numeric values where possible
    numeric_solutions = []
    for s in solutions:
        try:
            val = complex(s.evalf())
            if abs(val.imag) < 1e-10:
                numeric_solutions.append(round(float(val.real), 10))
            else:
                numeric_solutions.append(str(s))
        except (TypeError, ValueError):
            numeric_solutions.append(str(s))

    return ComputeResult(
        success=True,
        answer={
            "solutions": numeric_solutions,
            "solutions_symbolic": solution_strs,
            "equation": f"{expr} = 0",
            "variable": str(var),
        },
        method=f"solve({expr}, {var})",
    )
