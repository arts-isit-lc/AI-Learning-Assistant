"""ContextBuilder orchestrates context assembly for the reasoning engine.

Responsibilities:
- Sibling expansion (±2 siblings, max 500 added tokens per result)
- Clustering by (page_num, parent_element_id) — deterministic, ordered operations
- Token budget allocation (128,000 tokens, ranked by highest element score)
- Prompt formatting with source grouping
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Protocol

from aws_lambda_powertools import Logger

from ..models.data_models import (
    ContextCluster,
    ElementType,
    RankedResult,
    StructuredContext,
)

logger = Logger(service="multimodal-rag-reasoning")


def _estimate_tokens(text: str) -> int:
    """Estimate token count from text. ~4 chars per token."""
    return len(text) // 4 if text else 0


class SiblingStoreProtocol(Protocol):
    """Protocol for retrieving siblings by their retrieval IDs."""

    def get_by_ids(self, retrieval_ids: list[str]) -> list[RankedResult]:
        """Retrieve RankedResults by their retrieval IDs."""
        ...


class ContextBuilder:
    """Orchestrates context assembly: sibling expansion → cluster construction →
    token budget management → prompt formatting.

    Key parameters:
    - max_sibling_distance: 2 (expand ±2 siblings from same parent)
    - max_expansion_tokens: 500 (stop expansion when added tokens > 500)
    - max_tokens: 128,000 (total token budget)

    Deterministic: uses ordered operations, no hash-based or concurrent algorithms.
    """

    def __init__(self, sibling_store: SiblingStoreProtocol | None = None) -> None:
        """Initialize ContextBuilder with optional sibling store.

        Args:
            sibling_store: Store for looking up siblings by retrieval_id.
                          If None, sibling expansion is skipped.
        """
        self._sibling_store = sibling_store

    def build_context(
        self,
        results: list[RankedResult],
        module_id: str = "",
        max_tokens: int = 128_000,
    ) -> StructuredContext:
        """Build structured context from ranked results.

        Orchestrates: expand → cluster → budget → format → return StructuredContext.

        Args:
            results: Ranked results from the retrieval layer.
            module_id: Module identifier for clustering context.
            max_tokens: Maximum token budget for assembled context.

        Returns:
            StructuredContext ready for prompt formatting.
        """
        build_start = time.time()

        logger.info(
            "Building context from ranked results",
            extra={
                "input_result_count": len(results),
                "module_id": module_id,
                "max_tokens": max_tokens,
                "has_sibling_store": self._sibling_store is not None,
            },
        )

        # Step 1: Expand siblings.
        # Batch-prefetch every referenced sibling row in a single query (#6),
        # eliminating the previous per-result N+1 against the RDS proxy.
        expand_start = time.time()
        sibling_pool = self._prefetch_sibling_pool(results)
        expanded: list[RankedResult] = []
        seen_ids: list[str] = []
        siblings_added = 0
        for result in results:
            siblings = self.expand_siblings(result, sibling_pool=sibling_pool)
            for sibling in siblings:
                if sibling.retrieval_id not in seen_ids:
                    seen_ids.append(sibling.retrieval_id)
                    expanded.append(sibling)
            siblings_added += len(siblings) - 1  # subtract the original result
        expand_latency = time.time() - expand_start

        logger.info(
            "Sibling expansion complete",
            extra={
                "original_count": len(results),
                "expanded_count": len(expanded),
                "siblings_added": siblings_added,
                "expand_latency_ms": round(expand_latency * 1000, 2),
            },
        )

        # Step 2: Build clusters
        cluster_start = time.time()
        clusters = self.build_clusters(expanded, module_id)
        cluster_latency = time.time() - cluster_start

        logger.info(
            "Clustering complete",
            extra={
                "cluster_count": len(clusters),
                "total_token_cost": sum(c.token_cost for c in clusters),
                "cluster_latency_ms": round(cluster_latency * 1000, 2),
            },
        )

        # Step 3: Allocate token budget
        budget_start = time.time()
        budgeted_clusters = self.allocate_token_budget(clusters, max_tokens)
        budget_latency = time.time() - budget_start

        excluded_count = len(clusters) - len(budgeted_clusters)
        logger.info(
            "Token budget allocation complete",
            extra={
                "clusters_included": len(budgeted_clusters),
                "clusters_excluded": excluded_count,
                "budgeted_tokens": sum(c.token_cost for c in budgeted_clusters),
                "max_tokens": max_tokens,
                "budget_latency_ms": round(budget_latency * 1000, 2),
            },
        )

        # Step 4: Assemble StructuredContext from budgeted clusters
        context = self._assemble_context(budgeted_clusters)

        total_latency = time.time() - build_start
        logger.info(
            "Context build complete",
            extra={
                "text_passages": len(context.text_passages),
                "image_descriptions": len(context.image_descriptions),
                "formula_results": len(context.formula_results),
                "table_results": len(context.table_results),
                "total_token_count": context.token_count,
                "total_latency_ms": round(total_latency * 1000, 2),
            },
        )

        return context

    def _prefetch_sibling_pool(
        self, results: list[RankedResult]
    ) -> dict[str, RankedResult]:
        """Fetch every sibling referenced by ``results`` in one store query (#6).

        Collects the union of all ``sibling_ids`` across the ranked results and
        issues a single ``get_by_ids`` call, returning a {retrieval_id: result}
        map. Returns an empty dict when there is no sibling store or nothing to
        fetch, so ``expand_siblings`` behaves exactly as the unbatched path.
        """
        if self._sibling_store is None:
            return {}

        unique_ids: list[str] = []
        seen: set[str] = set()
        for result in results:
            for sid in result.sibling_ids:
                if sid not in seen:
                    seen.add(sid)
                    unique_ids.append(sid)

        if not unique_ids:
            return {}

        fetched = self._sibling_store.get_by_ids(unique_ids)
        return {s.retrieval_id: s for s in fetched}

    def expand_siblings(
        self,
        result: RankedResult,
        max_expansion_tokens: int = 500,
        max_sibling_distance: int = 2,
        sibling_pool: dict[str, RankedResult] | None = None,
    ) -> list[RankedResult]:
        """Expand a result by retrieving nearby siblings from same parent.

        If sibling_ids is empty, returns [result] without modification.
        If sibling_store is None, returns [result] without modification.

        Retrieves up to ±max_sibling_distance siblings from sibling_ids,
        stopping when added tokens exceed max_expansion_tokens.
        Maintains provenance order of expanded siblings.

        Args:
            result: The result to expand.
            max_expansion_tokens: Stop when added tokens exceed this.
            max_sibling_distance: Maximum siblings in each direction (±).

        Returns:
            List including the original result and its expanded siblings,
            ordered by provenance.
        """
        # Skip expansion if no sibling_ids or no store
        if not result.sibling_ids or self._sibling_store is None:
            return [result]

        # Retrieve siblings — from the prefetched pool (#6 batch path) when one
        # is provided, otherwise fall back to a per-result store query. The pool
        # holds the same RankedResult objects get_by_ids would return, so the
        # selection below is identical either way (it re-sorts by provenance).
        if sibling_pool is not None:
            siblings = [
                sibling_pool[sid]
                for sid in result.sibling_ids
                if sid in sibling_pool
            ]
        else:
            siblings = self._sibling_store.get_by_ids(result.sibling_ids)
        if not siblings:
            logger.debug(
                "Sibling store returned empty for result",
                extra={
                    "retrieval_id": result.retrieval_id,
                    "sibling_ids_requested": len(result.sibling_ids),
                },
            )
            return [result]

        # Sort siblings by provenance (page_num, position_index) for ordering
        siblings_sorted = sorted(
            siblings,
            key=lambda s: (
                s.metadata.get("provenance_page_num", 0),
                s.metadata.get("provenance_position_index", 0),
            ),
        )

        # Find the position of the current result in the provenance order
        # Build a combined list: current result + siblings, all sorted by provenance
        result_page = result.metadata.get("provenance_page_num", 0)
        result_pos = result.metadata.get("provenance_position_index", 0)

        # Separate siblings into those before and after the current result
        before: list[RankedResult] = []
        after: list[RankedResult] = []
        for s in siblings_sorted:
            s_page = s.metadata.get("provenance_page_num", 0)
            s_pos = s.metadata.get("provenance_position_index", 0)
            if (s_page, s_pos) < (result_page, result_pos):
                before.append(s)
            elif (s_page, s_pos) > (result_page, result_pos):
                after.append(s)
            # Skip if same position (duplicate of the result itself)

        # Take at most max_sibling_distance in each direction
        # Before: take the closest N (last N elements of 'before' list)
        candidates_before = before[-max_sibling_distance:] if before else []
        # After: take the first N elements
        candidates_after = after[:max_sibling_distance] if after else []

        # Apply token budget: add siblings until exceeding max_expansion_tokens
        added_tokens = 0
        selected: list[RankedResult] = []

        # Process before siblings (closest to result first, then farther)
        for s in reversed(candidates_before):
            token_cost = _estimate_tokens(s.content)
            if added_tokens + token_cost > max_expansion_tokens:
                break
            added_tokens += token_cost
            selected.append(s)

        # Process after siblings
        for s in candidates_after:
            if added_tokens > max_expansion_tokens:
                break
            token_cost = _estimate_tokens(s.content)
            if added_tokens + token_cost > max_expansion_tokens:
                break
            added_tokens += token_cost
            selected.append(s)

        # Combine result with selected siblings, sort by provenance
        all_elements = [result] + selected
        all_elements.sort(
            key=lambda r: (
                r.metadata.get("provenance_page_num", 0),
                r.metadata.get("provenance_position_index", 0),
            )
        )

        if selected:
            logger.debug(
                "Siblings expanded for result",
                extra={
                    "retrieval_id": result.retrieval_id,
                    "siblings_selected": len(selected),
                    "added_tokens": added_tokens,
                    "max_expansion_tokens": max_expansion_tokens,
                },
            )

        return all_elements

    def build_clusters(
        self, results: list[RankedResult], module_id: str = ""
    ) -> list[ContextCluster]:
        """Group results into clusters by same page AND same parent.

        Uses ordered operations (OrderedDict with list of tuples for keys)
        for deterministic output. No hash-based or concurrent processing.

        Args:
            results: Expanded results to cluster.
            module_id: Module context for cluster metadata.

        Returns:
            Deterministic list of ContextClusters.
        """
        if not results:
            return []

        # Use an OrderedDict keyed by (page_num, parent_element_id)
        # Keys are added in the order they are first encountered
        cluster_keys: list[tuple[int | None, str]] = []
        cluster_map: OrderedDict[tuple[int | None, str], list[RankedResult]] = (
            OrderedDict()
        )

        for result in results:
            page_num = result.metadata.get("provenance_page_num")
            parent_id = result.parent_element_id
            key = (page_num, parent_id)

            if key not in cluster_map:
                cluster_keys.append(key)
                cluster_map[key] = []
            cluster_map[key].append(result)

        # Build ContextCluster objects in deterministic order
        clusters: list[ContextCluster] = []
        for key in cluster_keys:
            elements = cluster_map[key]
            # Primary element is the highest-scored element in the cluster
            sorted_elements = sorted(elements, key=lambda r: r.score, reverse=True)
            primary = sorted_elements[0]
            related = sorted_elements[1:]

            # Compute token cost: sum of token estimates for all elements
            token_cost = sum(_estimate_tokens(e.content) for e in elements)

            page_num, parent_id = key
            relationship_note = (
                f"Page {page_num}, parent {parent_id}"
                if page_num is not None
                else f"Parent {parent_id}"
            )

            cluster = ContextCluster(
                primary_element=primary,
                related_elements=related,
                relationship_note=relationship_note,
                module_context=module_id,
                token_cost=token_cost,
            )
            clusters.append(cluster)

        return clusters

    def allocate_token_budget(
        self, clusters: list[ContextCluster], max_tokens: int = 128_000
    ) -> list[ContextCluster]:
        """Allocate token budget across clusters by score priority.

        Ranks clusters descending by highest element score (the max score
        among elements in the cluster), includes until budget exceeded,
        excludes lowest-scored clusters.

        Args:
            clusters: List of context clusters.
            max_tokens: Maximum total tokens allowed.

        Returns:
            Subset of clusters fitting within the token budget.
        """
        if not clusters:
            return []

        # Sort clusters descending by highest element score (primary_element.score)
        # Use a stable sort with explicit key to maintain determinism for ties
        sorted_clusters = sorted(
            clusters,
            key=lambda c: c.primary_element.score if c.primary_element else 0.0,
            reverse=True,
        )

        # Include clusters until budget exceeded
        selected: list[ContextCluster] = []
        total_tokens = 0

        for cluster in sorted_clusters:
            if total_tokens + cluster.token_cost > max_tokens:
                # Skip this cluster — budget would be exceeded
                continue
            total_tokens += cluster.token_cost
            selected.append(cluster)

        return selected

    def format_for_prompt(
        self, context: StructuredContext, module_context: str | None = None
    ) -> str:
        """Format structured context into a final prompt string.

        Assembles context grouped by source type with page/section headers.

        Args:
            context: Assembled structured context.
            module_context: Optional module-level context to include.

        Returns:
            Formatted context string for the reasoning engine.
        """
        sections: list[str] = []

        if module_context:
            sections.append(f"## Module Context\n{module_context}\n")

        # Format text passages grouped by page
        if context.text_passages:
            sections.append("## Text Passages")
            for result in context.text_passages:
                page = result.metadata.get("provenance_page_num")
                header = f"[Page {page}]" if page is not None else "[Source]"
                sections.append(f"\n### {header}\n{result.content}")

        # Format image descriptions
        if context.image_descriptions:
            sections.append("\n## Image Descriptions")
            for result in context.image_descriptions:
                page = result.metadata.get("provenance_page_num")
                header = f"[Page {page}]" if page is not None else "[Image]"
                sections.append(f"\n### {header}\n{result.content}")

        # Format formula results
        if context.formula_results:
            sections.append("\n## Formulas")
            for result in context.formula_results:
                page = result.metadata.get("provenance_page_num")
                header = f"[Page {page}]" if page is not None else "[Formula]"
                sections.append(f"\n### {header}\n{result.content}")

        # Format table results
        if context.table_results:
            sections.append("\n## Tables")
            for result in context.table_results:
                page = result.metadata.get("provenance_page_num")
                header = f"[Page {page}]" if page is not None else "[Table]"
                sections.append(f"\n### {header}\n{result.content}")

        return "\n".join(sections)

    def _assemble_context(
        self, clusters: list[ContextCluster]
    ) -> StructuredContext:
        """Assemble StructuredContext from budgeted clusters.

        Groups all elements from clusters by their element_type.

        Args:
            clusters: Budget-allocated clusters.

        Returns:
            StructuredContext with elements categorized by type.
        """
        text_passages: list[RankedResult] = []
        image_descriptions: list[RankedResult] = []
        formula_results: list[RankedResult] = []
        table_results: list[RankedResult] = []
        total_tokens = 0

        for cluster in clusters:
            all_elements = [cluster.primary_element] + cluster.related_elements if cluster.primary_element else cluster.related_elements
            total_tokens += cluster.token_cost

            for element in all_elements:
                if element.element_type == ElementType.TEXT:
                    text_passages.append(element)
                elif element.element_type == ElementType.IMAGE:
                    image_descriptions.append(element)
                elif element.element_type == ElementType.FORMULA:
                    formula_results.append(element)
                elif element.element_type == ElementType.TABLE:
                    table_results.append(element)

        return StructuredContext(
            text_passages=text_passages,
            image_descriptions=image_descriptions,
            formula_results=formula_results,
            table_results=table_results,
            token_count=total_tokens,
        )
