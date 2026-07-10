"""Tests for the compare_expressions operation (Tier 2 formula equivalence)."""

import pytest

sympy = pytest.importorskip("sympy")

from compare import compare_expressions  # noqa: E402
import handler as handler_mod  # noqa: E402


class _FakeContext:
    function_name = "math-compute"
    function_version = "$LATEST"
    invoked_function_arn = "arn:aws:lambda:ca-central-1:0:function:math-compute"
    memory_limit_in_mb = 256
    aws_request_id = "test-req"
    log_group_name = "/aws/lambda/math-compute"
    log_stream_name = "stream"

    def get_remaining_time_in_millis(self):
        return 30000


class TestCompareExpressions:
    def test_identical_expressions_equivalent(self):
        assert compare_expressions("x + 1", "1 + x")["equivalent"] is True

    def test_expanded_form_equivalent(self):
        assert compare_expressions("2*(x + 1)", "2*x + 2")["equivalent"] is True

    def test_caret_is_treated_as_power(self):
        assert compare_expressions("x^2", "x*x")["equivalent"] is True

    def test_non_equivalent_expressions(self):
        assert compare_expressions("x + 1", "x + 2")["equivalent"] is False

    def test_equations_scalar_multiple_are_equivalent(self):
        # 2x + 2y = 4 is the same equation as x + y = 2.
        assert compare_expressions("2*x + 2*y = 4", "x + y = 2")["equivalent"] is True

    def test_equations_not_equivalent(self):
        assert compare_expressions("x = 1", "x = 2")["equivalent"] is False

    def test_unparseable_returns_none(self):
        assert compare_expressions("%%%", "x")["equivalent"] is None

    def test_empty_returns_none(self):
        assert compare_expressions("", "x")["equivalent"] is None

    def test_result_shape(self):
        r = compare_expressions("x", "x")
        assert set(r) == {"equivalent", "method", "reason"}


class TestHandlerCompareRoute:
    def test_handler_dispatches_and_reports_equivalent(self):
        resp = handler_mod.handler(
            {"operation": "compare_expressions", "left": "x + 1", "right": "1 + x"}, _FakeContext()
        )
        assert resp["comparison"]["equivalent"] is True
        assert resp["status"] == "verified"

    def test_handler_not_equivalent(self):
        resp = handler_mod.handler(
            {"operation": "compare_expressions", "left": "x = 1", "right": "x = 2"}, _FakeContext()
        )
        assert resp["comparison"]["equivalent"] is False

    def test_handler_missing_input_is_parse_error(self):
        resp = handler_mod.handler(
            {"operation": "compare_expressions", "left": "", "right": "x"}, _FakeContext()
        )
        assert resp["comparison"]["equivalent"] is None
        assert resp["failure_reason"] == "parse_error"

    def test_handler_unparseable_is_partial(self):
        resp = handler_mod.handler(
            {"operation": "compare_expressions", "left": "%%%", "right": "x"}, _FakeContext()
        )
        assert resp["comparison"]["equivalent"] is None
        assert resp["status"] == "partial"

    def test_handler_still_serves_compute_path(self):
        # A normal compute request (no 'operation') is unaffected by the new route.
        resp = handler_mod.handler(
            {"raw_input": "determinant of [[1,2],[3,4]]", "operation_hint": "determinant"},
            _FakeContext(),
        )
        assert resp["status"] in ("verified", "partial")
        assert resp["answer"] is not None
