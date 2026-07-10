"""Shared, pure helpers for resolving figure/table references against the DB.

Extracted from ``image_escalation.py`` so the image-escalation path and the
structured (table) comparison path share ONE implementation of the anchored
reference regex and the scope predicate. These are pure functions: no I/O, no
state, no logging — trivially unit-testable and safe to import anywhere.
"""

from __future__ import annotations


def scope_predicate(scope_filter: dict | None) -> tuple[str, list]:
    """Render a file/module scope filter into an AND SQL fragment + params.

    Mirrors the retrieval handler's scope selection for the two promoted
    scope columns so direct DB reference lookups are restricted to the same
    files/modules as the main search (preventing a "Figure 4.1"/"Table 2.1"
    match from another course/file). file_id and module_id are TEXT columns, so
    a list value binds as text[] via ``= ANY(%s)`` and a scalar as ``= %s``.

    Returns ("", []) when no scope is supplied.
    """
    if not scope_filter:
        return "", []
    clauses: list[str] = []
    params: list = []
    for key in ("file_id", "module_id"):
        if key not in scope_filter:
            continue
        value = scope_filter[key]
        if isinstance(value, (list, tuple)):
            clauses.append(f"{key} = ANY(%s)")
            params.append([str(v) for v in value])
        else:
            clauses.append(f"{key} = %s")
            params.append(str(value))
    if not clauses:
        return "", []
    return " AND " + " AND ".join(clauses), params


def build_reference_regex(ref_type: str, number: str) -> str:
    """Build a POSIX regex matching an EXACT figure/table reference (M11).

    Anchors the number between non-digit/non-dot boundaries so a bare
    substring match can't over-match: "figure 4.1" must not match
    "figure 4.10" or "figure 14.1", and "figure 4" must not match
    "figure 4.1". Used with Postgres `~*` (case-insensitive).
    """
    num_re = number.replace(".", r"\.")
    return f"(^|[^0-9.]){ref_type}\\s+{num_re}([^0-9.]|$)"
