"""CrossEncoderReranker rescores merged results using a cross-encoder model."""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from aws_lambda_powertools import Logger

from ..models.data_models import MergedResult, RankedResult

logger = Logger(service="multimodal-rag-retrieval")


@runtime_checkable
class CrossEncoderProtocol(Protocol):
    """Protocol for cross-encoder scoring clients."""

    def score(self, query: str, passages: list[str]) -> list[float]:
        """Score each (query, passage) pair.

        Args:
            query: The user's search query.
            passages: List of passage texts to score against the query.

        Returns:
            List of float scores, one per passage.
        """
        ...


class CrossEncoderReranker:
    """Reranks merged results using a cross-encoder model for precision ranking.

    Applied after reciprocal rank fusion, before ProductionRanker scoring.

    Constraints:
    - Returns top_k results sorted descending by cross_encoder_score
    - Scores clamped to [0, 1] range
    - On cross-encoder unavailability (None or exception): skip reranking,
      substitute RRF score as cross_encoder_score
    """

    def __init__(self, cross_encoder: Any | None = None) -> None:
        """Initialize with an optional cross-encoder client.

        Args:
            cross_encoder: An object implementing CrossEncoderProtocol,
                or None to always use the RRF-score fallback.
        """
        self._cross_encoder = cross_encoder

    def rerank(
        self, query: str, results: list[MergedResult], top_k: int = 30
    ) -> list[RankedResult]:
        """Rerank merged results using the cross-encoder.

        Args:
            query: The user's search query.
            results: Merged results from hybrid search.
            top_k: Maximum number of results to return (default 30).

        Returns:
            Top-k RankedResult list sorted descending by cross_encoder_score,
            with scores clamped to [0, 1].
        """
        if not results:
            return []

        if self._cross_encoder is None:
            logger.info(
                "Cross-encoder not configured, using RRF score fallback",
                extra={"result_count": len(results)},
            )
            return self._fallback_to_rrf(results, top_k)

        try:
            return self._rerank_with_cross_encoder(query, results, top_k)
        except Exception:
            logger.exception(
                "Cross-encoder scoring failed, falling back to RRF scores",
            )
            return self._fallback_to_rrf(results, top_k)

    def _rerank_with_cross_encoder(
        self, query: str, results: list[MergedResult], top_k: int
    ) -> list[RankedResult]:
        """Score and rerank using the cross-encoder model.

        Steps:
        1. Extract content from each MergedResult
        2. Score all (query, content) pairs
        3. Clamp scores to [0, 1]
        4. Convert to RankedResult with cross_encoder_score
        5. Sort descending by cross_encoder_score
        6. Return top_k
        """
        passages = [r.content for r in results]
        scores = self._cross_encoder.score(query, passages)

        ranked: list[RankedResult] = []
        for result, raw_score in zip(results, scores):
            clamped_score = self._clamp_score(raw_score)
            ranked.append(self._to_ranked_result(result, clamped_score))

        ranked.sort(key=lambda r: r.cross_encoder_score, reverse=True)
        return ranked[:top_k]

    def _fallback_to_rrf(
        self, results: list[MergedResult], top_k: int
    ) -> list[RankedResult]:
        """Use RRF score as cross_encoder_score when cross-encoder is unavailable.

        Sorts by rrf_score descending and returns top_k.
        """
        ranked: list[RankedResult] = []
        for result in results:
            clamped_rrf = self._clamp_score(result.rrf_score)
            ranked.append(self._to_ranked_result(result, clamped_rrf))

        ranked.sort(key=lambda r: r.cross_encoder_score, reverse=True)
        return ranked[:top_k]

    @staticmethod
    def _clamp_score(score: float) -> float:
        """Clamp a score to the [0, 1] range."""
        return max(0.0, min(1.0, score))

    @staticmethod
    def _to_ranked_result(result: MergedResult, cross_encoder_score: float) -> RankedResult:
        """Convert a MergedResult to a RankedResult.

        Fields set later by ProductionRanker (score, metadata_boost) are
        initialized to defaults.
        """
        return RankedResult(
            retrieval_id=result.retrieval_id,
            parent_element_id=result.parent_element_id,
            content=result.content,
            element_type=result.element_type,
            score=0.0,  # Set later by ProductionRanker
            cross_encoder_score=cross_encoder_score,
            metadata_boost=0.0,  # Set later by ProductionRanker
            metadata=result.metadata,
            image_s3_key=result.metadata.get("image_s3_key"),
            sibling_ids=result.sibling_ids,
        )
