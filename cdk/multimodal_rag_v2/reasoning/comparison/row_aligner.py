"""Row alignment for table comparison — isolated behind a strategy.

Choosing which column is the "key" to align rows on is genuinely hard (``id`` vs
``SID`` vs ``Student Number``), so it lives behind ``AlignmentStrategy`` rather
than being baked into the comparator. v1 ships ``ExactHeaderKeyStrategy`` (exact
normalized header-name match); semantic/synonym strategies can be added later
without touching the comparator.

Everything here is a pure function of its inputs — no I/O, no LLM.
"""

from __future__ import annotations

from typing import Protocol

from ...models.data_models import ResolvedReferent, RowAlignmentResult, TableShape


def _norm(col: str) -> str:
    """Normalize a column name for comparison (trim + casefold)."""
    return (col or "").strip().casefold()


class AlignmentStrategy(Protocol):
    """Chooses the key column(s) to align rows on, or None if none is suitable."""

    def choose_key(self, shapes: list[TableShape]) -> list[str] | None:
        ...


class ExactHeaderKeyStrategy:
    """Pick a key by exact (normalized) header name shared across all referents.

    Prefers a column whose name looks like an identifier; otherwise the first
    shared column. Uniqueness is not asserted — a non-unique key still yields a
    useful (last-write-wins) alignment, reported as facts.
    """

    _KEY_HINTS = {
        "id", "key", "code", "name", "email",
        "student id", "student number", "student", "employee id",
    }

    def choose_key(self, shapes: list[TableShape]) -> list[str] | None:
        if len(shapes) < 2:
            return None
        col_sets = [{_norm(c) for c in s.columns} for s in shapes]
        shared = set.intersection(*col_sets) if col_sets else set()
        if not shared:
            return None
        # Original names from the first shape, in order, restricted to shared.
        shared_ordered = [c for c in shapes[0].columns if _norm(c) in shared]
        for col in shared_ordered:
            if _norm(col) in self._KEY_HINTS:
                return [col]
        return [shared_ordered[0]]


class RowAligner:
    """Aligns rows across referents on a chosen key and diffs shared columns."""

    def __init__(
        self,
        strategy: AlignmentStrategy | None = None,
        max_differing_cells: int = 50,
    ) -> None:
        self._strategy = strategy or ExactHeaderKeyStrategy()
        self._max_differing_cells = max_differing_cells

    def align(
        self, referents: list[ResolvedReferent], shapes: list[TableShape]
    ) -> RowAlignmentResult | None:
        """Return a RowAlignmentResult, or None when no key column is available."""
        key_cols = self._strategy.choose_key(shapes)
        if not key_cols:
            return None
        key_norm = _norm(key_cols[0])

        # Index each referent's rows by key value: {key_value: {norm_col: cell}}.
        indexed: list[tuple[str, dict[str, dict[str, str]]]] = []
        for ref in referents:
            sc = ref.structured_content or {}
            headers = sc.get("headers", []) or []
            rows = sc.get("rows", []) or []
            norm_headers = [_norm(h) for h in headers]
            if key_norm not in norm_headers:
                # Key not present in every referent -> cannot align.
                return None
            key_idx = norm_headers.index(key_norm)
            table: dict[str, dict[str, str]] = {}
            for row in rows:
                if key_idx >= len(row):
                    continue
                key_value = row[key_idx]
                table[key_value] = {
                    norm_headers[i]: (row[i] if i < len(row) else "")
                    for i in range(len(norm_headers))
                }
            indexed.append((ref.reference, table))

        key_sets = [set(table.keys()) for _, table in indexed]
        aligned_keys = set.intersection(*key_sets) if key_sets else set()

        # Shared (normalized) columns to diff, excluding the key column.
        col_sets = [{_norm(c) for c in s.columns} for s in shapes]
        shared_norm = (set.intersection(*col_sets) if col_sets else set()) - {key_norm}
        # Display names from the first shape, in order.
        shared_display = [
            c for c in shapes[0].columns if _norm(c) in shared_norm
        ]

        differing_cells: list[dict] = []
        for key_value in sorted(aligned_keys, key=str):
            for col in shared_display:
                col_norm = _norm(col)
                values_by_label = {
                    label: table.get(key_value, {}).get(col_norm, "")
                    for label, table in indexed
                }
                if len(set(values_by_label.values())) > 1:
                    differing_cells.append(
                        {"key": key_value, "column": col, "values_by_label": values_by_label}
                    )
                    if len(differing_cells) >= self._max_differing_cells:
                        break
            if len(differing_cells) >= self._max_differing_cells:
                break

        unaligned_by_label = {
            label: len(set(table.keys()) - aligned_keys) for label, table in indexed
        }

        return RowAlignmentResult(
            key_columns=[key_cols[0]],
            aligned_rows=len(aligned_keys),
            differing_cells=differing_cells,
            unaligned_by_label=unaligned_by_label,
        )
