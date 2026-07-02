"""Tests for guardrail fail-closed behavior (Phase 3 #11).

main.py imports psycopg2 at module load (not installed locally), so a bare fake
is injected before import (same pattern as test_appsync_url.py).
"""
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

sys.modules.setdefault("psycopg2", SimpleNamespace(connect=lambda *a, **k: None))
sys.path.insert(0, os.path.dirname(__file__))

import main  # noqa: E402


@pytest.fixture(autouse=True)
def _appsync(monkeypatch):
    monkeypatch.setattr(main, "_get_appsync_url", lambda: "https://x/graphql")


def _kwargs():
    return {"max_tokens": 100, "guardrail_id": "gr-1", "guardrail_version": "1"}


def _call():
    return main._stream_with_guardrail_retry(
        system_prompt="s",
        user_message="u",
        prompt_history=[],
        session_id="sess",
        model_kwargs=_kwargs(),
        guardrail_id="gr-1",
    )


class TestGuardrailFailClosed:
    def test_success_returns_streamed_text(self, monkeypatch):
        monkeypatch.setattr(main, "stream_response", MagicMock(return_value="ok answer"))
        assert _call() == "ok answer"

    def test_content_intervention_returns_redirect_no_retry(self, monkeypatch):
        sr = MagicMock(side_effect=RuntimeError("blocked"))
        monkeypatch.setattr(main, "stream_response", sr)
        monkeypatch.setattr(
            main, "handle_guardrail_error",
            lambda e, gid: {"message": "redirect", "blocked": True, "type": "input"},
        )
        out = _call()
        assert out == {"message": "redirect", "blocked": True, "type": "input"}
        assert sr.call_count == 1  # intervention never retries

    def test_service_error_flag_off_retries_without_guardrails(self, monkeypatch):
        monkeypatch.setattr(main, "GUARDRAIL_FAIL_CLOSED", False)
        sr = MagicMock(side_effect=[RuntimeError("svc"), "ungated answer"])
        monkeypatch.setattr(main, "stream_response", sr)
        monkeypatch.setattr(main, "handle_guardrail_error", lambda e, gid: None)
        out = _call()
        assert out == "ungated answer"
        assert sr.call_count == 2  # retried once
        second_kwargs = sr.call_args_list[1].kwargs["model_kwargs"]
        assert "guardrail_id" not in second_kwargs
        assert "guardrail_version" not in second_kwargs

    def test_service_error_flag_on_fails_closed_no_retry(self, monkeypatch):
        monkeypatch.setattr(main, "GUARDRAIL_FAIL_CLOSED", True)
        sr = MagicMock(side_effect=RuntimeError("svc"))
        monkeypatch.setattr(main, "stream_response", sr)
        monkeypatch.setattr(main, "handle_guardrail_error", lambda e, gid: None)
        out = _call()
        assert isinstance(out, dict)
        assert out["blocked"] is True
        assert out["type"] == "service_error"
        assert out["message"] == main.GUARDRAIL_SERVICE_ERROR_MESSAGE
        assert sr.call_count == 1  # did NOT regenerate without guardrails

    def test_converse_block_dict_passthrough_no_retry(self, monkeypatch):
        # ConverseStream signals a guardrail block by RETURNING a dict (not by
        # raising). _stream_with_guardrail_retry must pass that dict through
        # unchanged and never retry — the block already happened.
        blocked = {"message": "redirect", "blocked": True, "type": "output"}
        sr = MagicMock(return_value=blocked)
        monkeypatch.setattr(main, "stream_response", sr)
        out = _call()
        assert out == blocked
        assert sr.call_count == 1
