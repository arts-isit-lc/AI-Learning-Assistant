"""Symbolic equivalence of two expressions/equations (Tier 2 for formula compare).

Best-effort: parses each side with SymPy (parse_expr + implicit multiplication;
no LaTeX engine is bundled, so heavy-LaTeX inputs simply fail to parse) and
reports whether they are symbolically equivalent. Unparseable/undecidable input
-> equivalent is None (unknown). Safe parsing only — parse_expr with an explicit
transformation set, never eval / sympify of raw strings.
"""

from __future__ import annotations

import re

import sympy
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)

_TRANSFORMS = standard_transformations + (
    implicit_multiplication_application,
    convert_xor,  # treat ^ as exponentiation (common in stored formula text)
)

# Lightweight cleanup so common inputs parse without a full LaTeX engine.
_CLEANUP = [
    (re.compile(r"\$+"), " "),                       # $ / $$ delimiters
    (re.compile(r"\\left|\\right"), " "),
    (re.compile(r"\\,|\\;|\\:|\\!|\\quad|\\qquad"), " "),  # spacing macros
    (re.compile(r"\\cdot|\\times"), "*"),
    (re.compile(r"\\div"), "/"),
    (re.compile(r"[{}]"), " "),                       # grouping braces
]


def _clean(text: str) -> str:
    s = text or ""
    for pattern, repl in _CLEANUP:
        s = pattern.sub(repl, s)
    return s.strip()


def _parse_side(text: str):
    """Parse one side into (expr, is_equation). Raises on unparseable input.

    An equation ``L = R`` is normalized to the expression ``L - R`` (its =0 form)
    so two equations can be compared by their difference.
    """
    cleaned = _clean(text)
    if not cleaned:
        raise ValueError("empty expression")
    is_equation = "=" in cleaned
    if is_equation:
        lhs, rhs = cleaned.split("=", 1)
        expr = parse_expr(lhs, transformations=_TRANSFORMS) - parse_expr(
            rhs, transformations=_TRANSFORMS
        )
    else:
        expr = parse_expr(cleaned, transformations=_TRANSFORMS)
    return expr, is_equation


def compare_expressions(left: str, right: str) -> dict:
    """Compare two expressions/equations for symbolic equivalence.

    Returns ``{equivalent: True|False|None, method, reason}``. Never raises.
    ``None`` means "not determined" (unparseable or SymPy could not decide).
    """
    try:
        expr_left, is_eq_left = _parse_side(left)
        expr_right, is_eq_right = _parse_side(right)
    except Exception as exc:  # noqa: BLE001 — best-effort; any parse issue -> unknown
        return {"equivalent": None, "method": "sympy", "reason": f"parse_failed: {type(exc).__name__}"}

    try:
        difference = sympy.simplify(expr_left - expr_right)
        if difference == 0:
            return {
                "equivalent": True,
                "method": "sympy simplify(a-b)==0",
                "reason": "difference simplifies to 0",
            }
        # Two EQUATIONS (both in =0 form) that are nonzero scalar multiples of one
        # another describe the same equation -> equivalent. Only applied when both
        # sides were equations (never for bare expressions, where 2x != x).
        if is_eq_left and is_eq_right:
            try:
                ratio = sympy.simplify(expr_left / expr_right)
                if (
                    ratio.is_number
                    and ratio != 0
                    and not ratio.has(sympy.zoo, sympy.nan, sympy.oo)
                ):
                    return {
                        "equivalent": True,
                        "method": "sympy ratio",
                        "reason": f"scalar multiple ({ratio})",
                    }
            except Exception:  # noqa: BLE001 — ratio undecidable; fall through
                pass
        return {
            "equivalent": False,
            "method": "sympy simplify(a-b)==0",
            "reason": f"difference = {difference}",
        }
    except Exception as exc:  # noqa: BLE001
        return {"equivalent": None, "method": "sympy", "reason": f"compare_failed: {type(exc).__name__}"}
