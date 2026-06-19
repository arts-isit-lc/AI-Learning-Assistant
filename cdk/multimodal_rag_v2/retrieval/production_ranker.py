"""ProductionRanker applies final scoring and type-cap filtering."""

from __future__ import annotations

from aws_lambda_powertools import Logger

from ..models.data_models import ElementType, QueryIntent, RankedResult, TypeCaps

logger = Logger(service="multimodal-rag-retrieval")


class ProductionRanker:
    """Post-cross-encoder ranking with metadata boost and TypeCaps diversity.

    Score computation:
    - final_score = cross_encoder_score + metadata_boost
    - metadata_boost in [0, 0.1]
    - final_score is never negative

    TypeCaps filtering:
    - Default: text=8, image=4, formula=3, table=2
    - Adjusted by QueryIntent (image->6, formula->5, table->4)
    - Deterministic ordering (no randomness)
    """

    def rank(
        self,
        results: list[RankedResult],
        type_caps: TypeCaps | None = None,
        query_intent: QueryIntent | None = None,
    ) -> list[RankedResult]:
        """Apply production ranking with metadata boost and type caps.

        Args:
            results: Reranked results from CrossEncoderReranker.
            type_caps: Per-type diversity limits. Uses defaults if None.
            query_intent: Query intent for adjusting type caps.

        Returns:
            Ranked and filtered results respecting type caps.
        """
        if not results:
            return []

        # Step 1: Compute metadata_boost and final_score for each result
        scored_results = self._compute_scores(results)

        # Step 2: Sort results descending by final_score (stable sort)
        scored_results.sort(key=lambda r: r.score, reverse=True)

        # Step 3: Resolve effective type caps
        effective_caps = self._resolve_caps(type_caps, query_intent)

        # Step 4: Apply TypeCaps filtering
        filtered_results = self._apply_type_caps(scored_results, effective_caps)

        logger.info(
            "Production ranking complete",
            extra={
                "input_count": len(results),
                "output_count": len(filtered_results),
                "caps": {
                    "text": effective_caps.max_text,
                    "image": effective_caps.max_image,
                    "formula": effective_caps.max_formula,
                    "table": effective_caps.max_table,
                },
            },
        )

        return filtered_results

    def _compute_scores(self, results: list[RankedResult]) -> list[RankedResult]:
        """Compute metadata_boost and final_score for each result.

        metadata_boost heuristic:
        - is_document_summary=True -> 0.05 boost
        - lecture_number matches query -> 0.03 boost
        - page_num=1 (early content) -> 0.02 boost
        - Cap total boost at 0.1
        """
        for result in results:
            boost = 0.0

            metadata = result.metadata or {}

            # is_document_summary boost
            if metadata.get("is_document_summary", False):
                boost += 0.05

            # lecture_number presence boost (if lecture_number is set in metadata)
            if metadata.get("lecture_number") is not None:
                boost += 0.03

            # Early content boost (page_num == 1)
            if metadata.get("page_num") == 1:
                boost += 0.02

            # Cap metadata_boost at 0.1
            boost = min(boost, 0.1)

            # Ensure boost is non-negative
            boost = max(boost, 0.0)

            # Compute final_score, clamped to never be negative
            final_score = result.cross_encoder_score + boost
            final_score = max(final_score, 0.0)

            # Store computed values
            result.score = final_score
            result.metadata_boost = boost

        return results

    def _resolve_caps(
        self,
        type_caps: TypeCaps | None,
        query_intent: QueryIntent | None,
    ) -> TypeCaps:
        """Resolve effective type caps based on defaults and query intent adjustments.

        Default caps: text=8, image=4, formula=3, table=2
        Adjustments based on QueryIntent:
        - requires_image -> max_image = 6
        - requires_formula -> max_formula = 5
        - requires_table -> max_table = 4
        """
        if type_caps is not None:
            caps = TypeCaps(
                max_text=type_caps.max_text,
                max_image=type_caps.max_image,
                max_formula=type_caps.max_formula,
                max_table=type_caps.max_table,
            )
        else:
            caps = TypeCaps(max_text=8, max_image=4, max_formula=3, max_table=2)

        # Adjust caps based on query intent
        if query_intent is not None:
            if query_intent.requires_image:
                caps.max_image = 6
            if query_intent.requires_formula:
                caps.max_formula = 5
            if query_intent.requires_table:
                caps.max_table = 4

        return caps

    def _apply_type_caps(
        self, results: list[RankedResult], caps: TypeCaps
    ) -> list[RankedResult]:
        """Apply type caps filtering. Iterate sorted results, count per type, skip when cap reached.

        Deterministic: relies on stable sort order, no randomness.
        """
        type_counts: dict[ElementType, int] = {
            ElementType.TEXT: 0,
            ElementType.IMAGE: 0,
            ElementType.FORMULA: 0,
            ElementType.TABLE: 0,
        }

        cap_limits: dict[ElementType, int] = {
            ElementType.TEXT: caps.max_text,
            ElementType.IMAGE: caps.max_image,
            ElementType.FORMULA: caps.max_formula,
            ElementType.TABLE: caps.max_table,
        }

        filtered: list[RankedResult] = []

        for result in results:
            element_type = result.element_type
            current_count = type_counts.get(element_type, 0)
            cap_limit = cap_limits.get(element_type)

            if cap_limit is not None and current_count >= cap_limit:
                continue

            filtered.append(result)
            type_counts[element_type] = current_count + 1

        return filtered
