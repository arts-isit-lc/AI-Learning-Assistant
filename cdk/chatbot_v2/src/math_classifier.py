"""Math intent classifier — multi-label routing for compute requests.

Determines whether a student query needs mathematical computation,
explanation, or verification. Returns flags with dependency graph
so the orchestrator knows execution order.

V1: Rule-based. Expect LLM-based routing as first upgrade when
rule-based ceiling is hit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")


@dataclass
class MathClassification:
    """Multi-label classification result."""
    compute: bool = False
    explain: bool = False
    verify: bool = False
    operation_hint: str = ""       # eigenvalues, determinant, derivative, etc.
    has_explicit_math: bool = False  # matrix/equation found in input
    is_discourse_reference: bool = False  # "the matrix above", "that one"
    raw_math_content: str = ""     # extracted math portion for compute Lambda

    def needs_compute_lambda(self) -> bool:
        """Whether this classification requires invoking the math compute Lambda."""
        return self.compute and self.has_explicit_math and not self.is_discourse_reference


# ──────────────────────────────────────────────────────────────────────────────
# Detection patterns
# ──────────────────────────────────────────────────────────────────────────────

# Operations that signal compute intent
_COMPUTE_PATTERNS = [
    re.compile(r"\b(?:find|compute|calculate|evaluate)\b", re.IGNORECASE),
    re.compile(r"\beigen(?:values?|vect(?:ors?)?)\b", re.IGNORECASE),
    re.compile(r"\b(?:determinant|det)\b", re.IGNORECASE),
    re.compile(r"\binverse\b", re.IGNORECASE),
    re.compile(r"\b(?:rref|row\s*reduce)\b", re.IGNORECASE),
    re.compile(r"\b(?:derivative|differentiate|d/d[a-z])\b", re.IGNORECASE),
    re.compile(r"\b(?:integral|integrate)\b", re.IGNORECASE),
    re.compile(r"\bsolve\b", re.IGNORECASE),
]

# Operation-specific hints
_OPERATION_HINTS = {
    "eigenvalues": re.compile(r"\beigen(?:values?|vect(?:ors?)?)\b", re.IGNORECASE),
    "determinant": re.compile(r"\b(?:determinant|det)\b", re.IGNORECASE),
    "inverse": re.compile(r"\binverse\b", re.IGNORECASE),
    "rref": re.compile(r"\b(?:rref|row\s*reduce|reduced\s*row)\b", re.IGNORECASE),
    "derivative": re.compile(r"\b(?:derivative|differentiate|d/d[a-z])\b", re.IGNORECASE),
    "integral": re.compile(r"\b(?:integral|integrate|antiderivative)\b", re.IGNORECASE),
    "solve": re.compile(r"\bsolve\b", re.IGNORECASE),
}

# Explain intent
_EXPLAIN_PATTERNS = [
    re.compile(r"\b(?:walk\s*me\s*through|show\s*me\s*how|explain|step\s*by\s*step)\b", re.IGNORECASE),
    re.compile(r"\b(?:what\s*does|what\s*is|why\s*does|how\s*does)\b", re.IGNORECASE),
]

# Verify intent
_VERIFY_PATTERNS = [
    re.compile(r"\b(?:check\s*my|verify|is\s*this\s*correct|did\s*i)\b", re.IGNORECASE),
]

# Explicit math content detection (matrix or equation present)
_MATH_CONTENT_PATTERNS = [
    re.compile(r"\[\s*\["),                              # [[...
    re.compile(r"\[[^\]]*;[^\]]*\]"),                    # [a;b]
    re.compile(r"\([^)]*;[^)]*\)"),                      # (a;b)
    re.compile(r"\\begin\{[bp]?matrix\}"),               # LaTeX matrix
    re.compile(r"[a-z]\s*\^?\s*\d|[a-z]\s*[\+\-\*/]\s*[a-z\d]"),  # expression-like: x^2, a+b
]

# Discourse references (V1 rejects these)
_DISCOURSE_PATTERNS = [
    re.compile(r"\b(?:the\s*matrix\s*(?:above|below|from\s*before))\b", re.IGNORECASE),
    re.compile(r"\b(?:that\s*(?:matrix|one|same))\b", re.IGNORECASE),
    re.compile(r"\b(?:use\s*(?:the\s*)?(?:previous|same|above))\b", re.IGNORECASE),
    re.compile(r"\b(?:part\s*[a-z])\b", re.IGNORECASE),
    re.compile(r"\b(?:example\s*\d+)\b", re.IGNORECASE),
]


# ──────────────────────────────────────────────────────────────────────────────
# Main classifier
# ──────────────────────────────────────────────────────────────────────────────

def classify_math_intent(query: str) -> MathClassification:
    """Classify a student query for math compute routing.

    Multi-label: a query can be compute + explain simultaneously.
    Rule-based for V1.

    Args:
        query: The student's message.

    Returns:
        MathClassification with flags and extracted content.
    """
    result = MathClassification()

    # Detect discourse references (V1 blocks these)
    for pattern in _DISCOURSE_PATTERNS:
        if pattern.search(query):
            result.is_discourse_reference = True
            break

    # Detect compute intent
    for pattern in _COMPUTE_PATTERNS:
        if pattern.search(query):
            result.compute = True
            break

    # Detect operation hint
    for op_name, pattern in _OPERATION_HINTS.items():
        if pattern.search(query):
            result.operation_hint = op_name
            if not result.compute:
                result.compute = True  # operation keyword implies compute
            break

    # Detect explain intent
    for pattern in _EXPLAIN_PATTERNS:
        if pattern.search(query):
            result.explain = True
            break

    # Detect verify intent
    for pattern in _VERIFY_PATTERNS:
        if pattern.search(query):
            result.verify = True
            if not result.compute:
                result.compute = True  # verification requires computation
            break

    # Detect explicit math content
    for pattern in _MATH_CONTENT_PATTERNS:
        if pattern.search(query):
            result.has_explicit_math = True
            result.raw_math_content = query  # full query sent to parser
            break

    # If compute flagged but no explicit math AND no discourse reference,
    # still flag compute=True (default-to-compute-required principle)
    # The compute Lambda's parser will handle "no math found" gracefully

    logger.info(
        "Math classification complete",
        extra={
            "compute": result.compute,
            "explain": result.explain,
            "verify": result.verify,
            "operation_hint": result.operation_hint,
            "has_explicit_math": result.has_explicit_math,
            "is_discourse_reference": result.is_discourse_reference,
            "needs_compute_lambda": result.needs_compute_lambda(),
        },
    )

    return result
