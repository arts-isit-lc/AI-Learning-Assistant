"""LatexLexer — lightweight, parser-free tokenization + structural profiling.

Turns a (normalized) LaTeX string into a token stream and derives a
``FormulaProfile`` (variables, constants, operators, functions, Greek symbols,
best-effort equation type). Deliberately NOT ``sympy.parsing.latex``: it never
parses, so it succeeds on nearly all real inputs and never raises.
"""

from __future__ import annotations

import re

from ...models.data_models import EquationType, FormulaProfile
from .latex_normalizer import normalize

# --- Lexical vocabularies (lowercased) -------------------------------------

_GREEK = {
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
    "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
    "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi",
    "varphi", "chi", "psi", "omega",
}

# Function-like tokens (as commands OR plain words). \sum/\prod/\int are grouped
# here as "big-operator functions" per the spec's function inventory.
_FUNCTIONS = {
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
    "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "lim", "limsup", "liminf",
    "max", "min", "arg", "argmax", "argmin", "det", "dim", "gcd", "deg", "sup",
    "inf", "sum", "prod", "int", "oint", "iint", "sqrt", "frac",
}

# Operator commands (differential/relational/set operators written as \cmd).
_OP_COMMANDS = {
    "cdot", "times", "div", "pm", "mp", "ast", "star", "circ", "oplus", "otimes",
    "leq", "le", "geq", "ge", "neq", "ne", "approx", "equiv", "sim", "simeq",
    "cong", "propto", "nabla", "partial", "to", "rightarrow", "leftarrow",
    "mapsto", "forall", "exists", "in", "notin", "subset", "subseteq", "cup",
    "cap", "wedge", "vee", "land", "lor", "implies", "iff", "nabla",
}

# Constant commands (numeric-ish); numeric literals are handled separately.
_CONST_COMMANDS = {"infty"}

# Single-char symbol operators.
_SYMBOL_OPS = set("+-*/^=<>|!")

# Plain-word functions recognized without a backslash (implicit-mult guard).
_FUNC_WORDS = (
    "argmax|argmin|arcsin|arccos|arctan|sinh|cosh|tanh|"
    "sin|cos|tan|cot|sec|csc|log|ln|lg|exp|lim|max|min|arg|det|dim|gcd|sup|inf"
)

# Token order matters: commands, then known plain-word functions, then numbers,
# then a single letter (implicit multiplication), then a single symbol char.
_TOKEN_RE = re.compile(
    r"\\[a-zA-Z]+|(?:" + _FUNC_WORDS + r")|[0-9]+(?:\.[0-9]+)?|[A-Za-z]|[^\sA-Za-z0-9]"
)

# --- Equation-type heuristics (best-effort, lexical) -----------------------

_RE_CASES = re.compile(r"\\begin\s*\{?\s*cases|\\cases", re.IGNORECASE)
_RE_MATRIX = re.compile(r"\\begin\s*\{?\s*[bp]?matrix", re.IGNORECASE)
_RE_OPT = re.compile(r"argmax|argmin|\\arg\s*\\?(?:max|min)", re.IGNORECASE)
_RE_PROB = re.compile(r"\bp\s*\(|\\pr\b|\be\s*\[|\\mathbb\s*\{?\s*[ep]", re.IGNORECASE)
_RE_VECTOR = re.compile(r"\\vec|\\mathbf|\\boldsymbol", re.IGNORECASE)
_RE_RECURSIVE = re.compile(r"([a-z])\s*\(\s*n\s*\).*\1\s*\(\s*n\s*[-\u2212]", re.IGNORECASE)


def _dedupe(seq: list[str]) -> list[str]:
    """Order-preserving de-duplication."""
    seen: set[str] = set()
    out: list[str] = []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


class LatexLexer:
    """Tokenizes LaTeX and builds a lexical FormulaProfile."""

    @staticmethod
    def tokenize(s: str) -> list[str]:
        """Split a (normalized or raw) LaTeX string into lexical tokens."""
        return _TOKEN_RE.findall(s or "")

    @classmethod
    def profile(cls, label: str, latex: str) -> FormulaProfile:
        """Build a FormulaProfile from a formula's LaTeX. Never raises."""
        raw = latex or ""
        normalized = normalize(raw)
        tokens = cls.tokenize(raw)
        normalized_tokens = cls.tokenize(normalized)

        variables: list[str] = []
        constants: list[str] = []
        operators: list[str] = []
        functions: list[str] = []
        greek: list[str] = []

        for tok in normalized_tokens:
            if tok.startswith("\\"):
                name = tok[1:].lower()
                if name in _GREEK:
                    greek.append(name)
                elif name in _FUNCTIONS:
                    functions.append(name)
                elif name in _OP_COMMANDS:
                    operators.append(name)
                elif name in _CONST_COMMANDS:
                    constants.append(name)
                # else: structural/decorator command (frac handled above, begin/
                # end/mathbf/vec/operatorname/...) — ignored for the profile.
                continue

            low = tok.lower()
            if tok[0].isdigit():
                constants.append(tok)
            elif low in _FUNCTIONS:
                functions.append(low)
            elif len(tok) == 1 and tok.isalpha():
                variables.append(tok)
            elif tok in _SYMBOL_OPS:
                operators.append(tok)
            # else: punctuation/braces/commas/etc. — ignored.

        return FormulaProfile(
            label=label,
            variables=_dedupe(variables),
            constants=_dedupe(constants),
            operators=_dedupe(operators),
            functions=_dedupe(functions),
            greek=_dedupe(greek),
            equation_type=cls._equation_type(raw),
            tokens=tokens,
            normalized_tokens=normalized_tokens,
        )

    @staticmethod
    def _equation_type(raw: str) -> EquationType:
        """Best-effort LEXICAL classification (heuristics, not semantic parsing)."""
        s = raw or ""
        if _RE_CASES.search(s):
            return EquationType.PIECEWISE
        if _RE_MATRIX.search(s):
            return EquationType.MATRIX_EQUATION
        if _RE_OPT.search(s):
            return EquationType.OPTIMIZATION_OBJECTIVE
        if _RE_PROB.search(s):
            return EquationType.PROBABILITY_EXPRESSION
        if _RE_RECURSIVE.search(s):
            return EquationType.RECURSIVE_DEFINITION
        if _RE_VECTOR.search(s):
            return EquationType.VECTOR_EQUATION
        if "=" in s:
            return EquationType.SCALAR_EQUALITY
        return EquationType.UNKNOWN
