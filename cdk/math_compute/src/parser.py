"""Math input parser — extracts structured mathematical objects from student input.

Supports:
- Bracket notation: [[2,1],[1,2]]
- Semicolon notation: [2 1; 1 2]
- Parenthesis notation: (2,1;1,2)
- LaTeX bmatrix: \\begin{bmatrix}2 & 1 \\\\ 1 & 2\\end{bmatrix}
- Equation notation: x^2 + 3x - 5, 2x + y = 7
- Operation keywords: eigenvalues, determinant, inverse, derivative, integrate

NO GUESSING: if input is ambiguous, returns partial result for ambiguity gate to handle.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class ParseResult:
    """Result of parsing a math input."""
    success: bool
    operation: str = ""                    # eigenvalues, determinant, inverse, derivative, etc.
    sympy_input: str = ""                  # SymPy-parseable string
    object_type: str = ""                  # matrix, expression, equation
    raw_source: str = ""                   # original input text
    matrix_values: list[list[float | str]] | None = None  # parsed matrix if applicable
    expression_str: str = ""               # parsed expression string if applicable
    reason: str = ""                       # why this parse result was produced
    error_message: str = ""                # user-facing error if success=False
    ambiguous_interpretations: list[dict] = field(default_factory=list)  # for ambiguity gate

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "operation": self.operation,
            "object_type": self.object_type,
            "sympy_input": self.sympy_input[:100] if self.sympy_input else "",
            "ambiguous_count": len(self.ambiguous_interpretations),
        }


# ──────────────────────────────────────────────────────────────────────────────
# Operation detection
# ──────────────────────────────────────────────────────────────────────────────

_OPERATION_PATTERNS: dict[str, re.Pattern] = {
    "eigenvalues": re.compile(r"\beigen(?:values?|vect(?:ors?)?)\b", re.IGNORECASE),
    "determinant": re.compile(r"\b(?:determinant|det)\b", re.IGNORECASE),
    "inverse": re.compile(r"\binverse\b", re.IGNORECASE),
    "rref": re.compile(r"\b(?:rref|row\s*reduce|reduced\s*row\s*echelon)\b", re.IGNORECASE),
    "derivative": re.compile(r"\b(?:derivative|differentiate|d/d[a-z])\b", re.IGNORECASE),
    "integral": re.compile(r"\b(?:integral|integrate|antiderivative)\b", re.IGNORECASE),
    "solve": re.compile(r"\bsolve\b", re.IGNORECASE),
    "roots": re.compile(r"\b(?:roots?|zeros?)\b", re.IGNORECASE),
}


def _detect_operation(text: str, hint: str | None = None) -> str:
    """Detect the mathematical operation requested."""
    if hint and hint in _OPERATION_PATTERNS:
        return hint

    for op_name, pattern in _OPERATION_PATTERNS.items():
        if pattern.search(text):
            return op_name

    return ""


# ──────────────────────────────────────────────────────────────────────────────
# Matrix parsing
# ──────────────────────────────────────────────────────────────────────────────

# Pattern: [[1,2],[3,4]] or [[1, 2], [3, 4]]
_BRACKET_MATRIX = re.compile(
    r"\[\s*\[([^\]]+)\](?:\s*,\s*\[([^\]]+)\])*\s*\]"
)

# Pattern: [1 2; 3 4] or [1,2; 3,4]
_SEMICOLON_MATRIX = re.compile(
    r"\[([^;\]]+(?:;[^;\]]+)+)\]"
)

# Pattern: (1,2; 3,4)
_PAREN_MATRIX = re.compile(
    r"\(([^;)]+(?:;[^;)]+)+)\)"
)

# Pattern: LaTeX \begin{bmatrix} ... \end{bmatrix}
_LATEX_MATRIX = re.compile(
    r"\\begin\{[bp]?matrix\}(.+?)\\end\{[bp]?matrix\}", re.DOTALL
)


def _parse_bracket_matrix(text: str) -> list[list[str]] | None:
    """Parse [[a,b],[c,d]] format."""
    # Find the outermost [[ ... ]]
    match = re.search(r"\[\s*(\[.+\])\s*\]", text)
    if not match:
        return None

    inner = match.group(1)
    # Split into rows by ],[ pattern
    rows_raw = re.split(r"\]\s*,\s*\[", inner)
    rows: list[list[str]] = []
    for row_str in rows_raw:
        row_str = row_str.strip().strip("[]")
        cells = [c.strip() for c in row_str.split(",")]
        if cells and any(c for c in cells):
            rows.append(cells)

    return rows if rows else None


def _parse_semicolon_matrix(text: str) -> list[list[str]] | None:
    """Parse [1 2; 3 4] or [1,2; 3,4] format."""
    match = _SEMICOLON_MATRIX.search(text)
    if not match:
        return None

    content = match.group(1)
    row_strs = content.split(";")
    rows: list[list[str]] = []
    for row_str in row_strs:
        row_str = row_str.strip()
        # Split by comma or whitespace
        if "," in row_str:
            cells = [c.strip() for c in row_str.split(",")]
        else:
            cells = row_str.split()
        if cells and any(c for c in cells):
            rows.append(cells)

    return rows if rows else None


def _parse_paren_matrix(text: str) -> list[list[str]] | None:
    """Parse (1,2; 3,4) format."""
    match = _PAREN_MATRIX.search(text)
    if not match:
        return None

    content = match.group(1)
    row_strs = content.split(";")
    rows: list[list[str]] = []
    for row_str in row_strs:
        row_str = row_str.strip()
        if "," in row_str:
            cells = [c.strip() for c in row_str.split(",")]
        else:
            cells = row_str.split()
        if cells and any(c for c in cells):
            rows.append(cells)

    return rows if rows else None


def _parse_latex_matrix(text: str) -> list[list[str]] | None:
    """Parse LaTeX \\begin{bmatrix} ... \\end{bmatrix} format."""
    match = _LATEX_MATRIX.search(text)
    if not match:
        return None

    content = match.group(1).strip()
    # Rows separated by \\ and cells by &
    row_strs = re.split(r"\\\\", content)
    rows: list[list[str]] = []
    for row_str in row_strs:
        row_str = row_str.strip()
        if not row_str:
            continue
        cells = [c.strip() for c in row_str.split("&")]
        if cells and any(c for c in cells):
            rows.append(cells)

    return rows if rows else None


def _matrix_to_sympy_string(rows: list[list[str]]) -> str:
    """Convert parsed matrix rows to SymPy Matrix(...) string."""
    row_strs = []
    for row in rows:
        row_strs.append(f"[{', '.join(row)}]")
    return f"Matrix([{', '.join(row_strs)}])"


# ──────────────────────────────────────────────────────────────────────────────
# Expression parsing
# ──────────────────────────────────────────────────────────────────────────────

def _extract_expression(text: str) -> str | None:
    """Try to extract a mathematical expression from text.

    Looks for patterns like: x^2 + 3x - 5, sin(x), etc.
    Returns the expression string or None if not found.
    """
    # Remove operation keywords and common preamble
    cleaned = re.sub(
        r"\b(?:find|compute|calculate|solve|evaluate|the|of|for)\b",
        "", text, flags=re.IGNORECASE
    ).strip()

    # Look for expression-like content (has variables + operators)
    expr_match = re.search(
        r"([a-zA-Z_]\w*(?:\s*[\^*/+\-]\s*[\w.()]+)+|"
        r"[a-zA-Z_]\w*\s*\(.+?\)|"
        r"\d+\s*[a-zA-Z]\w*(?:\s*[\^*/+\-]\s*[\w.()]+)*)",
        cleaned
    )
    if expr_match:
        return expr_match.group(0).strip()

    return None


# ──────────────────────────────────────────────────────────────────────────────
# Bare number detection (ambiguity source)
# ──────────────────────────────────────────────────────────────────────────────

_BARE_NUMBERS = re.compile(
    r"(?:^|(?:matrix|of|for)\s+)(\d+(?:\.\d+)?(?:\s+\d+(?:\.\d+)?){3,})"
)


def _detect_bare_numbers(text: str) -> list[str] | None:
    """Detect sequences of bare numbers without structural delimiters.

    These are ALWAYS ambiguous — could be matrix rows, vector, or separate values.
    """
    match = _BARE_NUMBERS.search(text)
    if match:
        return match.group(1).split()
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Main parse function
# ──────────────────────────────────────────────────────────────────────────────

def parse_math_input(raw_input: str, operation_hint: str | None = None) -> ParseResult:
    """Parse student math input into structured format.

    Attempts matrix parsing first (most common for linear algebra),
    then expression parsing. Detects bare numbers as ambiguous.

    Args:
        raw_input: The student's raw input string.
        operation_hint: Optional operation hint from classifier.

    Returns:
        ParseResult with either a successful parse or ambiguity information.
    """
    operation = _detect_operation(raw_input, hint=operation_hint)

    # ── Try matrix formats (in order of explicitness) ──
    # 1. Bracket notation [[a,b],[c,d]] — most explicit
    rows = _parse_bracket_matrix(raw_input)
    if rows:
        sympy_str = _matrix_to_sympy_string(rows)
        return ParseResult(
            success=True,
            operation=operation or "eigenvalues",
            sympy_input=sympy_str,
            object_type="matrix",
            raw_source=raw_input,
            matrix_values=rows,
            reason="Parsed bracket notation [[a,b],[c,d]]",
        )

    # 2. LaTeX bmatrix
    rows = _parse_latex_matrix(raw_input)
    if rows:
        sympy_str = _matrix_to_sympy_string(rows)
        return ParseResult(
            success=True,
            operation=operation or "eigenvalues",
            sympy_input=sympy_str,
            object_type="matrix",
            raw_source=raw_input,
            matrix_values=rows,
            reason="Parsed LaTeX bmatrix notation",
        )

    # 3. Semicolon notation [a b; c d]
    rows = _parse_semicolon_matrix(raw_input)
    if rows:
        sympy_str = _matrix_to_sympy_string(rows)
        return ParseResult(
            success=True,
            operation=operation or "eigenvalues",
            sympy_input=sympy_str,
            object_type="matrix",
            raw_source=raw_input,
            matrix_values=rows,
            reason="Parsed semicolon notation [a b; c d]",
        )

    # 4. Parenthesis notation (a,b; c,d)
    rows = _parse_paren_matrix(raw_input)
    if rows:
        sympy_str = _matrix_to_sympy_string(rows)
        return ParseResult(
            success=True,
            operation=operation or "eigenvalues",
            sympy_input=sympy_str,
            object_type="matrix",
            raw_source=raw_input,
            matrix_values=rows,
            reason="Parsed parenthesis notation (a,b; c,d)",
        )

    # ── Check for bare numbers (ALWAYS ambiguous) ──
    bare_nums = _detect_bare_numbers(raw_input)
    if bare_nums:
        n = len(bare_nums)
        candidates = []
        # Could be a square matrix if n is a perfect square
        import math
        sqrt_n = int(math.sqrt(n))
        if sqrt_n * sqrt_n == n and sqrt_n > 1:
            # Possible square matrix interpretation
            matrix_rows = [bare_nums[i:i + sqrt_n] for i in range(0, n, sqrt_n)]
            candidates.append({
                "interpretation": f"{sqrt_n}x{sqrt_n} matrix",
                "value": matrix_rows,
                "sympy_input": _matrix_to_sympy_string(matrix_rows),
            })
        # Always a possible vector
        candidates.append({
            "interpretation": f"{n}-dimensional vector",
            "value": bare_nums,
            "sympy_input": f"Matrix([{', '.join(bare_nums)}])",
        })

        return ParseResult(
            success=True,  # parsed something, but ambiguous
            operation=operation,
            object_type="ambiguous",
            raw_source=raw_input,
            reason=f"Bare numbers detected ({n} values) — multiple valid interpretations",
            ambiguous_interpretations=candidates,
        )

    # ── Try expression parsing ──
    if operation in ("derivative", "integral", "solve", "roots"):
        expr = _extract_expression(raw_input)
        if expr:
            return ParseResult(
                success=True,
                operation=operation,
                sympy_input=expr,
                object_type="expression",
                raw_source=raw_input,
                expression_str=expr,
                reason=f"Parsed expression for {operation}",
            )

    # ── Nothing parseable found ──
    if operation:
        return ParseResult(
            success=False,
            operation=operation,
            raw_source=raw_input,
            reason="Operation detected but no parseable mathematical object found",
            error_message=(
                f"I detected you want to compute '{operation}', but I couldn't find "
                f"a matrix or expression in your input. Please provide it in a format like "
                f"[[2,1],[1,2]] or [2 1; 1 2]."
            ),
        )

    return ParseResult(
        success=False,
        raw_source=raw_input,
        reason="No mathematical operation or object detected",
        error_message=(
            "I couldn't identify a mathematical computation in your input. "
            "Try formatting like: 'find eigenvalues of [[2,1],[1,2]]' or "
            "'derivative of x^2 + 3x'"
        ),
    )
