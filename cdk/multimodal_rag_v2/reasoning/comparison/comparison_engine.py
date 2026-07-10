"""ComparisonEngine — orchestrates resolution + comparison by type.

Selects a resolver and comparator from a registry keyed by ``ComparisonType``
(no if/else chain — adding a type is a registry entry). Applies the policy cap
on the number of referents (2 in v1). Makes NO model call: the comparator is the
source of truth; the LLM only explains the resulting facts downstream.
"""

from __future__ import annotations

from typing import Any

from aws_lambda_powertools import Logger

from ...models.data_models import (
    ComparisonIntent,
    ComparisonType,
    FigureReference,
    QueryIntent,
    RankedResult,
    StructuredComparison,
)

logger = Logger(service="multimodal-rag-reasoning")


class ComparisonEngine:
    """Registry-driven orchestrator for structured comparisons."""

    def __init__(
        self,
        resolvers: dict[ComparisonType, Any],
        comparators: dict[ComparisonType, Any],
        max_referents: int = 2,
    ) -> None:
        self._resolvers = resolvers
        self._comparators = comparators
        self._max_referents = max_referents

    def compare(
        self,
        query_intent: QueryIntent,
        ranked_results: list[RankedResult],
        scope_filter: dict | None = None,
    ) -> StructuredComparison | None:
        """Resolve referents and compute a StructuredComparison, or None.

        Returns None when the intent is not a supported comparison, no
        resolver/comparator is registered for the type, or nothing resolved.
        """
        plan = self._plan(query_intent)
        if plan is None:
            return None
        comparison_type, refs, intent = plan

        resolver = self._resolvers.get(comparison_type)
        comparator = self._comparators.get(comparison_type)
        if resolver is None or comparator is None:
            logger.warning(
                "No resolver/comparator registered for comparison type",
                extra={"comparison_type": comparison_type.value},
            )
            return None

        # Policy cap: compare the first N distinct referents (§4.7). The
        # comparator itself is N-way; only this boundary enforces the cap.
        referents = resolver.resolve(refs[: self._max_referents], ranked_results, scope_filter)
        if not referents:
            logger.info(
                "Structured comparison resolved no referents",
                extra={"comparison_type": comparison_type.value, "requested": len(refs)},
            )
            return None

        facts = comparator.compare(referents)
        logger.info(
            "Structured comparison built",
            extra={
                "comparison_type": comparison_type.value,
                "intent": intent.value,
                "referents_requested": len(refs),
                "referents_resolved": len(referents),
                "confidences": [r.confidence.value for r in referents],
            },
        )
        return StructuredComparison(
            comparison_type=comparison_type,
            intent=intent,
            referents=referents,
            facts=facts,
        )

    def _plan(
        self, query_intent: QueryIntent
    ) -> tuple[ComparisonType, list[FigureReference], ComparisonIntent] | None:
        """Decide the comparison type, referenced items, and prompt intent.

        v1 only supports table comparison (comparison verb present -> COMPARE).
        """
        if getattr(query_intent, "requires_table_comparison", False):
            table_refs = [
                r for r in (getattr(query_intent, "figure_references", None) or [])
                if r.ref_type == "table"
            ]
            return ComparisonType.TABLE, table_refs, ComparisonIntent.COMPARE
        return None
