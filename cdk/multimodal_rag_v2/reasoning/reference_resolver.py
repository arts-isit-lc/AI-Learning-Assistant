"""Reference resolution — turn parsed references into resolved referents.

This is deliberately SEPARATE from comparison (`comparison/`) so resolution is
reusable outside a comparison (e.g. a future "Show me Table 2.1"). A resolver
finds each referenced item, loads its structured content, and assigns a
resolution confidence — it does not compare anything.

v1 ships ``TableReferenceResolver``; the deferred formula spec adds a formula
resolver behind the same protocol.
"""

from __future__ import annotations

import re
from typing import Any, Protocol

from aws_lambda_powertools import Logger

from ..models.data_models import (
    ElementType,
    FigureReference,
    RankedResult,
    ResolutionConfidence,
    ResolvedReferent,
)
from .reference_lookup import build_reference_regex, scope_predicate

logger = Logger(service="multimodal-rag-reasoning")


class ReferenceResolver(Protocol):
    """Resolves parsed references to structured referents (no comparison)."""

    def resolve(
        self,
        refs: list[FigureReference],
        ranked_results: list[RankedResult],
        scope_filter: dict | None = None,
    ) -> list[ResolvedReferent]:
        ...


class TableReferenceResolver:
    """Resolve ``table`` references to their stored structured content.

    Strategy (mirrors the image path, scoped + deterministic):
    1. A TABLE already present in the ranked results whose text matches the
       exact reference -> HIGH (it was retrieved for this query).
    2. Otherwise a scoped direct DB lookup on ``element_type='table'``; confidence
       reflects ambiguity (single in-scope match -> HIGH; several in one module
       -> MEDIUM; spanning modules -> LOW).

    Never raises: any DB error logs and yields no referent for that reference.
    """

    def __init__(self, db_connection_factory: Any = None) -> None:
        self._db_connection_factory = db_connection_factory

    def resolve(
        self,
        refs: list[FigureReference],
        ranked_results: list[RankedResult],
        scope_filter: dict | None = None,
    ) -> list[ResolvedReferent]:
        resolved: list[ResolvedReferent] = []
        seen_parents: set[str] = set()
        for ref in refs:
            if ref.ref_type != "table":
                continue
            referent = self._resolve_one(ref, ranked_results, scope_filter)
            # Avoid resolving two references to the SAME physical table.
            if referent is not None and referent.parent_element_id not in seen_parents:
                if referent.parent_element_id:
                    seen_parents.add(referent.parent_element_id)
                resolved.append(referent)
        return resolved

    def _resolve_one(
        self, ref: FigureReference, ranked_results: list[RankedResult], scope_filter: dict | None
    ) -> ResolvedReferent | None:
        # Strategy 1: a matching TABLE already in the retrieved context.
        in_context = self._find_in_results(ref, ranked_results)
        if in_context is not None:
            return self._referent(ref, in_context, ResolutionConfidence.HIGH)

        # Strategy 2: scoped direct DB lookup.
        db_result = self._find_in_db(ref, scope_filter)
        if db_result is None:
            return None
        count, module_count = self._count_candidates(ref, scope_filter)
        if count >= 2 and module_count >= 2:
            confidence = ResolutionConfidence.LOW
        elif count >= 2:
            confidence = ResolutionConfidence.MEDIUM
        else:
            confidence = ResolutionConfidence.HIGH
        return self._referent(ref, db_result, confidence)

    def _find_in_results(
        self, ref: FigureReference, ranked_results: list[RankedResult]
    ) -> RankedResult | None:
        """First TABLE in the ranked results whose text matches the exact ref."""
        pattern = re.compile(build_reference_regex(ref.ref_type, ref.number), re.IGNORECASE)
        for r in ranked_results:
            if r.element_type != ElementType.TABLE:
                continue
            haystack = f"{r.content or ''} {r.metadata.get('table_summary', '') or ''}"
            if pattern.search(haystack):
                return r
        return None

    def _find_in_db(
        self, ref: FigureReference, scope_filter: dict | None
    ) -> RankedResult | None:
        if self._db_connection_factory is None:
            return None
        try:
            import json as _json

            conn = self._db_connection_factory()
            if conn is None:
                return None
            cur = conn.cursor()
            scope_sql, scope_params = scope_predicate(scope_filter)
            ref_regex = build_reference_regex(ref.ref_type, ref.number)
            # ORDER BY retrieval_id makes the pick deterministic when several
            # in-scope table units match the same reference.
            cur.execute(
                f"""
                SELECT retrieval_id, parent_element_id, embedding_text, metadata
                FROM retrieval_units
                WHERE element_type = 'table'
                AND embedding_text ~* %s{scope_sql}
                ORDER BY retrieval_id
                LIMIT 1;
                """,
                (ref_regex, *scope_params),
            )
            row = cur.fetchone()
            cur.close()
            if not row:
                return None
            metadata = row[3] if isinstance(row[3], dict) else (_json.loads(row[3]) if row[3] else {})
            logger.info(
                "Resolved table reference via direct DB lookup",
                extra={"retrieval_id": row[0], "ref_type": ref.ref_type, "number": ref.number},
            )
            return RankedResult(
                retrieval_id=row[0],
                parent_element_id=row[1] or "",
                content=row[2] or "",
                element_type=ElementType.TABLE,
                score=1.0,
                cross_encoder_score=0.0,
                metadata_boost=0.0,
                metadata=metadata,
                image_s3_key=None,
                sibling_ids=[],
            )
        except Exception:
            logger.exception("Error during direct DB lookup for table reference")
            return None

    def _count_candidates(
        self, ref: FigureReference, scope_filter: dict | None
    ) -> tuple[int, int]:
        """Count distinct in-scope tables (by parent) matching the exact ref, and
        how many distinct modules they span. Used only to assign confidence.
        Returns (candidate_count, distinct_module_count); (0, 0) on no-DB/error.
        """
        if self._db_connection_factory is None:
            return 0, 0
        try:
            conn = self._db_connection_factory()
            if conn is None:
                return 0, 0
            cur = conn.cursor()
            scope_sql, scope_params = scope_predicate(scope_filter)
            ref_regex = build_reference_regex(ref.ref_type, ref.number)
            cur.execute(
                f"""
                SELECT DISTINCT parent_element_id, metadata->>'module_id'
                FROM retrieval_units
                WHERE element_type = 'table'
                AND embedding_text ~* %s{scope_sql}
                LIMIT 20;
                """,
                (ref_regex, *scope_params),
            )
            rows = cur.fetchall()
            cur.close()
            parents = {r[0] for r in rows if r and r[0] is not None}
            modules = {r[1] for r in rows if r and r[1] is not None}
            return len(parents), len(modules)
        except Exception:
            logger.exception("Error counting table-reference candidates")
            return 0, 0

    @staticmethod
    def _referent(
        ref: FigureReference, result: RankedResult, confidence: ResolutionConfidence
    ) -> ResolvedReferent:
        md = result.metadata or {}
        structured_content = {
            "headers": md.get("table_headers", []) or [],
            "rows": md.get("table_rows", []) or [],
            "summary": md.get("table_summary") or "",
            "page_num": md.get("provenance_page_num") or md.get("page_num"),
            "module_id": md.get("module_id"),
            "content": result.content or "",
        }
        return ResolvedReferent(
            reference=f"{ref.ref_type.title()} {ref.number}",
            retrieval_id=result.retrieval_id,
            parent_element_id=result.parent_element_id,
            confidence=confidence,
            structured_content=structured_content,
            result=result,
        )
