"""TableComparator — deterministic, verified diff between tables.

Pure function of its inputs (reads only ``ResolvedReferent.structured_content``):
schema diff (shared/unique columns), per-referent shape, and row alignment
(delegated to RowAligner). Operates on a LIST of referents so it is N-way-ready;
the 2-referent cap is a policy applied by the engine, not baked in here.
"""

from __future__ import annotations

from ...models.data_models import ResolvedReferent, TableComparisonFacts, TableShape
from .row_aligner import RowAligner, _norm


class TableComparator:
    def __init__(self, aligner: RowAligner | None = None) -> None:
        self._aligner = aligner or RowAligner()

    def compare(self, referents: list[ResolvedReferent]) -> TableComparisonFacts:
        shapes: list[TableShape] = []
        for ref in referents:
            sc = ref.structured_content or {}
            headers = sc.get("headers", []) or []
            rows = sc.get("rows", []) or []
            shapes.append(
                TableShape(
                    label=ref.reference,
                    n_rows=len(rows),
                    n_cols=len(headers),
                    columns=list(headers),
                )
            )

        if not shapes:
            return TableComparisonFacts()

        col_sets = [{_norm(c) for c in s.columns} for s in shapes]
        shared_norm = set.intersection(*col_sets) if col_sets else set()
        # Report original names from the first referent, preserving order.
        shared_columns = [c for c in shapes[0].columns if _norm(c) in shared_norm]

        unique_columns: dict[str, list[str]] = {}
        for i, shape in enumerate(shapes):
            other_norm: set[str] = set()
            for j, cols in enumerate(col_sets):
                if j != i:
                    other_norm |= cols
            unique_columns[shape.label] = [
                c for c in shape.columns if _norm(c) not in other_norm
            ]

        # Row alignment only makes sense for >= 2 referents; aligner returns None
        # when there is no usable shared key (schema/shape-only comparison).
        row_alignment = self._aligner.align(referents, shapes) if len(shapes) >= 2 else None

        return TableComparisonFacts(
            per_referent=shapes,
            shared_columns=shared_columns,
            unique_columns=unique_columns,
            row_alignment=row_alignment,
        )
