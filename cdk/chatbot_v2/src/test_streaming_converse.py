"""Tests for the ConverseStream generation path (USE_CONVERSE_STREAMING=on).

The Converse path runs the guardrail in ASYNCHRONOUS stream mode to cut TTFT. A
guardrail block is signalled by stopReason='guardrail_intervened' (NOT an
exception), and the assembled text / usage / latency instrumentation must match
the InvokeModel path's contract. Deterministic: no network (appsync_url="" makes
send_chunk a no-op), no real Bedrock.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(__file__))

import streaming  # noqa: E402


# ─── Converse event builders (boto3 yields one-key dicts per stream event) ────
def _delta(text: str) -> dict:
    return {"contentBlockDelta": {"delta": {"text": text}, "contentBlockIndex": 0}}


def _message_stop(stop_reason: str) -> dict:
    return {"messageStop": {"stopReason": stop_reason}}


def _metadata(input_tokens: int, output_tokens: int, trace: dict | None = None) -> dict:
    meta = {"usage": {"inputTokens": input_tokens, "outputTokens": output_tokens}}
    if trace is not None:
        meta["trace"] = trace
    return {"metadata": meta}


def _client_with(events, capture: dict | None = None):
    client = MagicMock()

    def _converse(**kwargs):
        if capture is not None:
            capture.update(kwargs)
        return {"stream": events}

    client.converse_stream.side_effect = _converse
    return client


_DEFAULT_KWARGS = {"max_tokens": 100, "guardrail_id": "gr-1", "guardrail_version": "2"}


def _run(monkeypatch, events, model_kwargs=_DEFAULT_KWARGS, capture=None):
    monkeypatch.setattr(streaming, "USE_CONVERSE_STREAMING", True)
    calls = []
    monkeypatch.setattr(streaming.logger, "info", lambda msg, **kw: calls.append(kw.get("extra", {})))
    monkeypatch.setattr(streaming.logger, "warning", lambda *a, **k: None)
    out = streaming.stream_response(
        _client_with(events, capture),
        model_id="anthropic.claude-3-sonnet-20240229-v1:0",
        system_prompt="sys", user_message="hi", chat_history=[],
        appsync_url="", session_id="s1", model_kwargs=model_kwargs,
    )
    latency = [e for e in calls if e.get("event") == "stream_latency"]
    assert len(latency) == 1
    return out, latency[0]


def test_converse_assembles_text_and_logs_usage(monkeypatch):
    events = [
        _delta("Hello "), _delta("world"), _delta("!"),
        _message_stop("end_turn"),
        _metadata(1234, 50),
    ]
    out, lat = _run(monkeypatch, events)
    assert out == "Hello world!"  # behavior preserved vs the invoke path
    assert lat["ttft_ms"] is not None
    assert lat["input_tokens"] == 1234
    assert lat["output_tokens"] == 50
    assert lat["stop_reason"] == "end_turn"
    assert lat["streaming_mode"] == "converse"
    assert lat["output_chars"] == len("Hello world!")


def test_converse_request_uses_async_guardrail(monkeypatch):
    capture: dict = {}
    _run(monkeypatch, [_message_stop("end_turn"), _metadata(1, 1)], capture=capture)
    gc = capture["guardrailConfig"]
    assert gc["streamProcessingMode"] == "async"  # the whole point: async = low TTFT
    assert gc["trace"] == "enabled"  # needed to classify input vs output blocks
    assert gc["guardrailIdentifier"] == "gr-1"
    assert gc["guardrailVersion"] == "2"
    assert capture["system"] == [{"text": "sys"}]
    assert capture["inferenceConfig"] == {"maxTokens": 100}
    assert capture["messages"][-1] == {"role": "user", "content": [{"text": "hi"}]}


def test_converse_output_block_returns_redirect_dict(monkeypatch):
    events = [
        _delta("partial that leaked before the block"),
        _message_stop("guardrail_intervened"),
        _metadata(10, 5, trace={"guardrail": {"outputAssessment": {"gr": {}}}}),
    ]
    out, lat = _run(monkeypatch, events)
    assert isinstance(out, dict)
    assert out["blocked"] is True
    assert out["type"] == "output"  # partial text discarded, redirect returned
    assert lat["stop_reason"] == "guardrail_intervened"


def test_converse_input_block_classified_as_input(monkeypatch):
    events = [
        _message_stop("guardrail_intervened"),
        _metadata(0, 0, trace={"guardrail": {"inputAssessment": {"gr": {}}}}),
    ]
    out, _lat = _run(monkeypatch, events)
    assert isinstance(out, dict)
    assert out["type"] == "input"


def test_converse_guardrail_disabled_omits_config(monkeypatch):
    monkeypatch.setattr(streaming, "STREAM_GUARDRAIL_DISABLED", True)
    capture: dict = {}
    _run(monkeypatch, [_message_stop("end_turn"), _metadata(1, 1)], capture=capture)
    assert "guardrailConfig" not in capture  # dev diagnostic drops the guardrail


def test_converse_no_guardrail_id_omits_config(monkeypatch):
    capture: dict = {}
    _run(
        monkeypatch, [_message_stop("end_turn"), _metadata(1, 1)],
        model_kwargs={"max_tokens": 100, "guardrail_id": "", "guardrail_version": ""},
        capture=capture,
    )
    assert "guardrailConfig" not in capture


def test_converse_error_event_returns_fallback(monkeypatch):
    # A service/model error surfaces as a terminal stream event; since it is not
    # guardrail-related it is swallowed to FALLBACK (parity with the invoke path).
    monkeypatch.setattr(streaming, "USE_CONVERSE_STREAMING", True)
    monkeypatch.setattr(streaming.logger, "info", lambda *a, **k: None)
    monkeypatch.setattr(streaming.logger, "exception", lambda *a, **k: None)
    events = [_delta("x"), {"throttlingException": {"message": "slow down"}}]
    out = streaming.stream_response(
        _client_with(events), model_id="anthropic.claude-3-sonnet-20240229-v1:0",
        system_prompt="sys", user_message="hi", chat_history=[],
        appsync_url="", session_id="s1", model_kwargs=_DEFAULT_KWARGS,
    )
    assert out == streaming.FALLBACK_MESSAGE


def test_flag_off_uses_invoke_not_converse(monkeypatch):
    monkeypatch.setattr(streaming, "USE_CONVERSE_STREAMING", False)
    monkeypatch.setattr(streaming.logger, "info", lambda *a, **k: None)
    client = MagicMock()
    client.invoke_model_with_response_stream.return_value = {"body": []}
    streaming.stream_response(
        client, model_id="m", system_prompt="s", user_message="u",
        chat_history=[], appsync_url="", session_id="s1", model_kwargs=None,
    )
    assert client.invoke_model_with_response_stream.called
    assert not client.converse_stream.called


def test_flag_on_uses_converse_not_invoke(monkeypatch):
    monkeypatch.setattr(streaming, "USE_CONVERSE_STREAMING", True)
    monkeypatch.setattr(streaming.logger, "info", lambda *a, **k: None)
    client = _client_with([_message_stop("end_turn"), _metadata(1, 1)])
    streaming.stream_response(
        client, model_id="m", system_prompt="s", user_message="u",
        chat_history=[], appsync_url="", session_id="s1", model_kwargs={"max_tokens": 100},
    )
    assert client.converse_stream.called
    assert not client.invoke_model_with_response_stream.called
