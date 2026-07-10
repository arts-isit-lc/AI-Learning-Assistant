"""LaTeX normalization — a textual cleanup pass BEFORE tokenization.

Keeps the lexer simple and robust: strips math delimiters, sizing/ spacing
macros, and grouping braces, and collapses whitespace. Purely textual — no
parsing, no SymPy. Idempotent: normalize(normalize(x)) == normalize(x).
"""

from __future__ import annotations

import re

# \left / \right (optionally followed by a delimiter char handled separately)
_LEFT_RIGHT = re.compile(r"\\left|\\right")
# spacing macros: \, \; \: \! \quad \qquad \enspace \thinspace and backslash-space
_SPACING = re.compile(r"\\(?:qquad|quad|enspace|thinspace|;|:|,|!|\s)")
_WHITESPACE = re.compile(r"\s+")


def normalize(latex: str) -> str:
    """Normalize a LaTeX string for lexical analysis.

    Args:
        latex: Raw LaTeX (e.g. a stored ``latex_repr``). May be empty/None-ish.

    Returns:
        A cleaned, single-spaced LaTeX string safe to tokenize.
    """
    s = latex or ""

    # Display / inline math delimiters.
    s = s.replace("$$", " ")
    s = s.replace(r"\[", " ").replace(r"\]", " ")
    s = s.replace(r"\(", " ").replace(r"\)", " ")
    s = s.replace("$", " ")

    # \left / \right sizing.
    s = _LEFT_RIGHT.sub(" ", s)

    # Spacing macros (order: multi-char before single-char is handled by the regex).
    s = _SPACING.sub(" ", s)

    # Grouping braces are redundant for lexical profiling — keep their content.
    s = s.replace("{", " ").replace("}", " ")

    # Collapse whitespace.
    s = _WHITESPACE.sub(" ", s).strip()
    return s
