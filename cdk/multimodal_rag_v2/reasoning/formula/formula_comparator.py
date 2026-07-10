"""FormulaComparator — deterministic lexical comparison of formulas.

Tier 1 is a pure function of the referents' ``latex`` (normalize -> lex ->
profile, then shared/unique per category). Tier 2 (symbolic equivalence) is an
OPTIONAL injected ``equivalence_checker``; when absent (Phase 1) equivalence
stays UNKNOWN and the lexical comparison stands alone. N-way-ready.
"""

from __future__ import annotations

from typing import Any

from ...models.data_models import (
    EquivalenceResult,
    FormulaComparisonFacts,
    ResolvedReferent,
)
from .latex_lexer import LatexLexer

_CATEGORIES = ("variables", "constants", "operators", "functions", "greek")


def _latex_of(referent: ResolvedReferent) -> str:
    sc = referent.structured_content or {}
    return sc.get("latex") or sc.get("content") or ""


class FormulaComparator:
    def __init__(self, equivalence_checker: Any = None) -> None:
        # Tier 2 collaborator (Phase 2). None => lexical-only (Tier 1).
        self._checker = equivalence_checker

    def compare(self, referents: list[ResolvedReferent]) -> FormulaComparisonFacts:
        if not referents:
            return FormulaComparisonFacts()

        profiles = [LatexLexer.profile(r.reference, _latex_of(r)) for r in referents]

        shared: dict[str, list[str]] = {}
        for cat in _CATEGORIES:
            sets = [set(getattr(p, cat)) for p in profiles]
            intersection = set.intersection(*sets) if sets else set()
            # Report using the first referent's original order.
            shared[cat] = [v for v in getattr(profiles[0], cat) if v in intersection]

        unique: dict[str, dict[str, list[str]]] = {}
        for i, profile in enumerate(profiles):
            per_cat: dict[str, list[str]] = {}
            for cat in _CATEGORIES:
                others: set[str] = set()
                for j, other in enumerate(profiles):
                    if j != i:
                        others |= set(getattr(other, cat))
                per_cat[cat] = [v for v in getattr(profile, cat) if v not in others]
            unique[profile.label] = per_cat

        equivalence = self._check_equivalence(referents)

        return FormulaComparisonFacts(
            per_referent=profiles,
            shared=shared,
            unique=unique,
            equivalence=equivalence,
        )

    def _check_equivalence(self, referents: list[ResolvedReferent]) -> EquivalenceResult:
        """Tier 2: symbolic equivalence, only with a checker and exactly 2 referents.

        Never raises — any checker failure degrades to UNKNOWN so the lexical
        comparison always stands.
        """
        if self._checker is None or len(referents) != 2:
            return EquivalenceResult()
        try:
            result = self._checker.check(_latex_of(referents[0]), _latex_of(referents[1]))
            return result or EquivalenceResult()
        except Exception:
            return EquivalenceResult()
