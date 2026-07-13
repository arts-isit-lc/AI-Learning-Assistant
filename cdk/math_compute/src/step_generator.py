"""Step Generator — produces canonical linear step lists from SymPy results.

For each supported operation, generates a structured solution path where
each step has an expected output and transformation type. Steps are
verifiable against SymPy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import sympy
from sympy import Matrix, Symbol, det, simplify, factor, solve, diff, integrate
from sympy.parsing.sympy_parser import parse_expr


@dataclass
class SolutionStep:
    """A single step in the canonical solution path."""
    step_id: int
    description: str
    expected_output: str
    transformation_type: str
    hint: str

    def to_dict(self) -> dict:
        return {
            "step_id": self.step_id,
            "description": self.description,
            "expected_output": self.expected_output,
            "transformation_type": self.transformation_type,
            "hint": self.hint,
        }


def _eigenvalue_sort_key(val):
    """Deterministic sort key for numeric and symbolic eigenvalues.

    Numeric eigenvalues sort by real part; symbolic eigenvalues (which cannot
    be converted to a float, e.g. ``a - 1``) sort by their string form and are
    grouped after the numeric ones.
    """
    try:
        return (0, complex(val.evalf()).real)
    except (TypeError, ValueError):
        return (1, str(val))


def generate_steps(operation: str, parse_result: Any, compute_result: Any) -> list[SolutionStep]:
    """Generate canonical solution steps for an operation.

    Args:
        operation: The math operation (eigenvalues, determinant, etc.)
        parse_result: The ParseResult from the parser.
        compute_result: The ComputeResult with verified answer.

    Returns:
        Ordered list of SolutionSteps.
    """
    if operation == "eigenvalues":
        return _steps_eigenvalues(parse_result, compute_result)
    elif operation == "determinant":
        return _steps_determinant(parse_result, compute_result)
    elif operation == "inverse":
        return _steps_inverse(parse_result, compute_result)
    elif operation == "derivative":
        return _steps_derivative(parse_result, compute_result)
    elif operation == "integral":
        return _steps_integral(parse_result, compute_result)
    elif operation in ("solve", "roots"):
        return _steps_solve(parse_result, compute_result)
    else:
        return []


def _build_matrix(parse_result: Any) -> Matrix:
    """Build SymPy Matrix from parse result."""
    rows = parse_result.matrix_values
    sympy_rows = []
    for row in rows:
        sympy_rows.append([parse_expr(str(entry).strip()) for entry in row])
    return Matrix(sympy_rows)


# ──────────────────────────────────────────────────────────────────────────────
# Eigenvalues
# ──────────────────────────────────────────────────────────────────────────────

def _steps_eigenvalues(parse_result: Any, compute_result: Any) -> list[SolutionStep]:
    """Generate steps for finding eigenvalues."""
    matrix = _build_matrix(parse_result)
    n = matrix.rows
    lam = Symbol("lambda")

    # Step 1: Form A - λI
    identity = sympy.eye(n)
    a_minus_li = matrix - lam * identity
    a_minus_li_str = str(a_minus_li)

    # Step 2: Compute determinant
    char_det = det(a_minus_li)
    char_det_expanded = sympy.expand(char_det)
    char_det_str = str(char_det_expanded)

    # Step 3: Simplify / factor polynomial
    char_poly_factored = factor(char_det)
    char_poly_str = str(char_poly_factored)

    # Step 4: Solve for eigenvalues
    eigenvalues = solve(char_det, lam)
    eigenvalues_str = ", ".join(
        str(ev) for ev in sorted(eigenvalues, key=_eigenvalue_sort_key, reverse=True)
    )

    steps = [
        SolutionStep(
            step_id=1,
            description="Form the matrix A - λI (subtract λ from each diagonal entry)",
            expected_output=a_minus_li_str,
            transformation_type="matrix_subtraction",
            hint=f"Subtract λ from each diagonal entry of the {n}x{n} matrix. Off-diagonal entries stay the same.",
        ),
        SolutionStep(
            step_id=2,
            description="Compute the determinant of (A - λI)",
            expected_output=char_det_str,
            transformation_type="determinant_expansion",
            hint=f"For a {n}x{n} matrix, expand the determinant. For 2x2: ad - bc.",
        ),
        SolutionStep(
            step_id=3,
            description="Factor or simplify the characteristic polynomial",
            expected_output=char_poly_str,
            transformation_type="factor_polynomial",
            hint="Try factoring the polynomial. Look for common patterns or use the quadratic formula.",
        ),
        SolutionStep(
            step_id=4,
            description="Solve the characteristic equation (set polynomial = 0)",
            expected_output=eigenvalues_str,
            transformation_type="solve_equation",
            hint="Set each factor equal to zero and solve for λ.",
        ),
    ]

    return steps


# ──────────────────────────────────────────────────────────────────────────────
# Determinant
# ──────────────────────────────────────────────────────────────────────────────

def _steps_determinant(parse_result: Any, compute_result: Any) -> list[SolutionStep]:
    """Generate steps for computing a determinant."""
    matrix = _build_matrix(parse_result)
    n = matrix.rows

    if n == 2:
        a, b, c, d = matrix[0, 0], matrix[0, 1], matrix[1, 0], matrix[1, 1]
        product_ad = str(simplify(a * d))
        product_bc = str(simplify(b * c))
        det_val = str(simplify(matrix.det()))

        return [
            SolutionStep(
                step_id=1,
                description="Identify entries: a, b, c, d in [[a,b],[c,d]]",
                expected_output=f"a={a}, b={b}, c={c}, d={d}",
                transformation_type="identify_entries",
                hint="For a 2x2 matrix [[a,b],[c,d]], label each position.",
            ),
            SolutionStep(
                step_id=2,
                description="Apply formula: det = ad - bc",
                expected_output=f"({a})({d}) - ({b})({c}) = {product_ad} - {product_bc}",
                transformation_type="determinant_formula",
                hint="Multiply diagonal entries (ad), multiply off-diagonal (bc), subtract.",
            ),
            SolutionStep(
                step_id=3,
                description="Compute final value",
                expected_output=det_val,
                transformation_type="arithmetic",
                hint="Subtract the two products to get the determinant.",
            ),
        ]
    else:
        # For larger matrices, use cofactor expansion description
        det_val = str(simplify(matrix.det()))
        return [
            SolutionStep(
                step_id=1,
                description="Choose a row or column for cofactor expansion (row 1 recommended)",
                expected_output=f"Expand along row 1: entries {[str(matrix[0, j]) for j in range(n)]}",
                transformation_type="cofactor_setup",
                hint="Pick the row with the most zeros to minimize computation.",
            ),
            SolutionStep(
                step_id=2,
                description="Compute cofactors and sum: Σ(-1)^(i+j) * a_ij * M_ij",
                expected_output=det_val,
                transformation_type="cofactor_expansion",
                hint="For each entry in your chosen row, multiply by its cofactor (minor with sign).",
            ),
        ]


# ──────────────────────────────────────────────────────────────────────────────
# Inverse
# ──────────────────────────────────────────────────────────────────────────────

def _steps_inverse(parse_result: Any, compute_result: Any) -> list[SolutionStep]:
    """Generate steps for matrix inverse."""
    matrix = _build_matrix(parse_result)
    n = matrix.rows
    det_val = simplify(matrix.det())
    det_str = str(det_val)

    if n == 2:
        a, b, c, d = matrix[0, 0], matrix[0, 1], matrix[1, 0], matrix[1, 1]
        adj_str = f"[[{d}, {-b}], [{-c}, {a}]]"
        inv_matrix = matrix.inv()
        inv_str = str(inv_matrix)

        return [
            SolutionStep(
                step_id=1,
                description="Compute the determinant",
                expected_output=det_str,
                transformation_type="determinant",
                hint="For 2x2 [[a,b],[c,d]]: det = ad - bc",
            ),
            SolutionStep(
                step_id=2,
                description="Form the adjugate (swap diagonal, negate off-diagonal)",
                expected_output=adj_str,
                transformation_type="adjugate",
                hint="Swap a and d, negate b and c: [[d,-b],[-c,a]]",
            ),
            SolutionStep(
                step_id=3,
                description="Divide adjugate by determinant: A⁻¹ = (1/det) * adj(A)",
                expected_output=inv_str,
                transformation_type="scalar_division",
                hint=f"Multiply each entry of the adjugate by 1/{det_str}.",
            ),
        ]
    else:
        inv_matrix = matrix.inv()
        inv_str = str(inv_matrix)
        return [
            SolutionStep(
                step_id=1,
                description="Compute determinant (must be non-zero)",
                expected_output=f"det = {det_str} ≠ 0 ✓",
                transformation_type="determinant",
                hint="If determinant is 0, the matrix has no inverse.",
            ),
            SolutionStep(
                step_id=2,
                description="Augment matrix with identity: [A | I] and row reduce",
                expected_output=inv_str,
                transformation_type="row_reduction",
                hint="Perform row operations on [A|I] until left side becomes I. Right side is A⁻¹.",
            ),
        ]


# ──────────────────────────────────────────────────────────────────────────────
# Derivative
# ──────────────────────────────────────────────────────────────────────────────

def _steps_derivative(parse_result: Any, compute_result: Any) -> list[SolutionStep]:
    """Generate steps for differentiation."""
    expr_str = parse_result.expression_str or parse_result.sympy_input
    expr = parse_expr(expr_str)
    var = sorted(expr.free_symbols, key=str)[0] if expr.free_symbols else Symbol("x")

    result = diff(expr, var)
    result_str = str(result)

    # Identify which rule applies
    rule = _identify_diff_rule(expr, var)

    steps = [
        SolutionStep(
            step_id=1,
            description=f"Identify the differentiation rule needed for: {expr_str}",
            expected_output=f"Rule: {rule}",
            transformation_type="identify_rule",
            hint="Look at the structure: is it a power, product, chain rule, or trig function?",
        ),
        SolutionStep(
            step_id=2,
            description=f"Apply {rule} to differentiate with respect to {var}",
            expected_output=result_str,
            transformation_type="apply_rule",
            hint=f"Apply the {rule} carefully to each term.",
        ),
    ]

    # Add simplification step if result simplifies further
    simplified = simplify(result)
    if str(simplified) != result_str:
        steps.append(SolutionStep(
            step_id=3,
            description="Simplify the result",
            expected_output=str(simplified),
            transformation_type="simplify",
            hint="Combine like terms and simplify.",
        ))

    return steps


def _identify_diff_rule(expr, var) -> str:
    """Identify which differentiation rule applies."""
    if expr.is_polynomial(var):
        return "power rule"
    elif expr.has(sympy.sin, sympy.cos, sympy.tan):
        return "trigonometric differentiation"
    elif expr.has(sympy.exp):
        return "exponential rule"
    elif expr.has(sympy.log, sympy.ln):
        return "logarithmic differentiation"
    elif len(expr.args) > 1 and expr.func == sympy.Mul:
        return "product rule"
    else:
        return "standard differentiation rules"


# ──────────────────────────────────────────────────────────────────────────────
# Integral
# ──────────────────────────────────────────────────────────────────────────────

def _steps_integral(parse_result: Any, compute_result: Any) -> list[SolutionStep]:
    """Generate steps for integration."""
    expr_str = parse_result.expression_str or parse_result.sympy_input
    expr = parse_expr(expr_str)
    var = sorted(expr.free_symbols, key=str)[0] if expr.free_symbols else Symbol("x")

    result = integrate(expr, var)
    result_str = str(result)

    rule = _identify_integration_rule(expr, var)

    steps = [
        SolutionStep(
            step_id=1,
            description=f"Identify the integration technique for: {expr_str}",
            expected_output=f"Technique: {rule}",
            transformation_type="identify_technique",
            hint="Is this a power rule, substitution, or known integral form?",
        ),
        SolutionStep(
            step_id=2,
            description=f"Apply {rule} to integrate with respect to {var}",
            expected_output=result_str,
            transformation_type="apply_technique",
            hint=f"Apply the {rule}. Remember: ∫xⁿ dx = xⁿ⁺¹/(n+1) for power rule.",
        ),
        SolutionStep(
            step_id=3,
            description="Add the constant of integration",
            expected_output=f"{result_str} + C",
            transformation_type="add_constant",
            hint="Don't forget the constant of integration (+C) for indefinite integrals.",
        ),
    ]

    return steps


def _identify_integration_rule(expr, var) -> str:
    """Identify which integration technique applies."""
    if expr.is_polynomial(var):
        return "power rule (reverse)"
    elif expr.has(sympy.sin, sympy.cos):
        return "trigonometric integration"
    elif expr.has(sympy.exp):
        return "exponential integration"
    else:
        return "standard integration technique"


# ──────────────────────────────────────────────────────────────────────────────
# Solve
# ──────────────────────────────────────────────────────────────────────────────

def _steps_solve(parse_result: Any, compute_result: Any) -> list[SolutionStep]:
    """Generate steps for solving equations."""
    expr_str = parse_result.expression_str or parse_result.sympy_input
    expr = parse_expr(expr_str)
    var = sorted(expr.free_symbols, key=str)[0] if expr.free_symbols else Symbol("x")

    solutions = solve(expr, var)
    solutions_str = ", ".join(str(s) for s in solutions)

    # Determine degree for method selection
    poly = sympy.Poly(expr, var) if expr.is_polynomial(var) else None
    degree = poly.degree() if poly else 0

    steps = [
        SolutionStep(
            step_id=1,
            description=f"Set expression equal to zero: {expr_str} = 0",
            expected_output=f"{expr_str} = 0",
            transformation_type="equation_setup",
            hint="We're finding values where this expression equals zero.",
        ),
    ]

    if degree == 2:
        # Quadratic — try factoring
        factored = factor(expr)
        factored_str = str(factored)
        steps.append(SolutionStep(
            step_id=2,
            description="Factor the expression (or use quadratic formula)",
            expected_output=f"{factored_str} = 0",
            transformation_type="factor_polynomial",
            hint="Try factoring. If that doesn't work, use the quadratic formula: x = (-b ± √(b²-4ac)) / 2a",
        ))
        steps.append(SolutionStep(
            step_id=3,
            description="Set each factor equal to zero and solve",
            expected_output=solutions_str,
            transformation_type="solve_factors",
            hint="Each factor that equals zero gives a solution.",
        ))
    elif degree == 1:
        steps.append(SolutionStep(
            step_id=2,
            description="Isolate the variable",
            expected_output=solutions_str,
            transformation_type="isolate_variable",
            hint="Move terms to isolate the variable on one side.",
        ))
    else:
        steps.append(SolutionStep(
            step_id=2,
            description="Solve the equation",
            expected_output=solutions_str,
            transformation_type="solve_equation",
            hint="Factor if possible, or apply appropriate solving technique for the degree.",
        ))

    return steps
