"""Tests for #7: eval || retrieval coordination (_eval_and_retrieve).

main.py imports psycopg2 at module load (not installed locally), so a bare fake
is injected before import (same pattern as test_appsync_url.py).
"""
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

sys.modules.setdefault("psycopg2", SimpleNamespace(connect=lambda *a, **k: None))
sys.path.insert(0, os.path.dirname(__file__))

import main  # noqa: E402


class TestEvalAndRetrieve:
    def test_parallel_runs_both_and_marks_retrieval_done(self):
        run_eval = MagicMock(return_value="EVAL")
        run_retrieval = MagicMock(return_value="RETR")

        evaluation, retrieval_result, retrieval_done = main._eval_and_retrieve(
            run_eval, run_retrieval, parallel=True
        )

        assert evaluation == "EVAL"
        assert retrieval_result == "RETR"
        assert retrieval_done is True
        run_eval.assert_called_once_with()
        # Parallel retrieval uses the pre-evaluation state: empty misunderstood.
        run_retrieval.assert_called_once_with([])

    def test_sequential_runs_eval_only_and_defers_retrieval(self):
        run_eval = MagicMock(return_value="EVAL")
        run_retrieval = MagicMock(return_value="RETR")

        evaluation, retrieval_result, retrieval_done = main._eval_and_retrieve(
            run_eval, run_retrieval, parallel=False
        )

        assert evaluation == "EVAL"
        assert retrieval_result is None  # caller runs retrieval with post-eval context
        assert retrieval_done is False
        run_eval.assert_called_once_with()
        run_retrieval.assert_not_called()

    def test_parallel_propagates_results_independently(self):
        # Evaluation may be None (skipped/failed) while retrieval still returns.
        run_eval = MagicMock(return_value=None)
        run_retrieval = MagicMock(return_value="RETR")

        evaluation, retrieval_result, retrieval_done = main._eval_and_retrieve(
            run_eval, run_retrieval, parallel=True
        )

        assert evaluation is None
        assert retrieval_result == "RETR"
        assert retrieval_done is True
