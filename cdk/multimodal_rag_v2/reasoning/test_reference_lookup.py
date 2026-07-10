"""Tests for the shared reference-lookup helpers (reference_lookup.py).

These mirror the intent of the original TestReferenceRegex/scope tests in
test_image_escalation.py; the image path now delegates to these functions, so
parity here guarantees the image path is unchanged.
"""

from __future__ import annotations

import re

from .reference_lookup import build_reference_regex, scope_predicate
from .image_escalation import ImageEscalation


class TestBuildReferenceRegex:
    def _matches(self, ref_type: str, number: str, text: str) -> bool:
        # Postgres uses ~* (case-insensitive POSIX); Python re + IGNORECASE is
        # equivalent for these boundary classes.
        return re.search(build_reference_regex(ref_type, number), text, re.IGNORECASE) is not None

    def test_exact_match(self) -> None:
        assert self._matches("table", "2.1", "See Table 2.1 for details")

    def test_number_boundary_no_overmatch(self) -> None:
        # "table 4" must NOT match "table 4.1"; "table 4.1" must NOT match "4.10"
        assert not self._matches("table", "4", "Table 4.1 shows")
        assert not self._matches("table", "4.1", "Table 4.10 shows")
        assert not self._matches("figure", "4.1", "Figure 14.1 shows")

    def test_case_insensitive_via_flag(self) -> None:
        assert self._matches("figure", "3", "the FIGURE 3 above")

    def test_delegation_parity_with_image_escalation(self) -> None:
        # The static method on ImageEscalation must produce the SAME regex.
        assert ImageEscalation._build_reference_regex("table", "2.1") == build_reference_regex("table", "2.1")


class TestScopePredicate:
    def test_empty_scope(self) -> None:
        assert scope_predicate(None) == ("", [])
        assert scope_predicate({}) == ("", [])

    def test_list_binds_as_any(self) -> None:
        sql, params = scope_predicate({"file_id": ["a", "b"]})
        assert "file_id = ANY(%s)" in sql
        assert params == [["a", "b"]]

    def test_scalar_binds_as_eq(self) -> None:
        sql, params = scope_predicate({"module_id": "m1"})
        assert "module_id = %s" in sql
        assert params == ["m1"]

    def test_unknown_keys_ignored(self) -> None:
        assert scope_predicate({"course_id": "c1"}) == ("", [])

    def test_delegation_parity_with_image_escalation(self) -> None:
        assert ImageEscalation._scope_predicate({"file_id": ["x"]}) == scope_predicate({"file_id": ["x"]})
