"""Tests for stream_response latency + usage instrumentation.

Feeds a fake Bedrock event stream and asserts (a) the assembled text is
unchanged (behavior preserved) and (b) a `stream_latency` log is emitted with
ttft_ms / stream_total_ms / output_chars / input_tokens / output_tokens /
stop_reason. Deterministic: no network (appsync_url="" makes send_chunk a
no-op), no real Bedrock.
"""
from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(__file__))

import streaming  # noqa: E402


def _delta(text: str) -> dict:
    return {"chunk": {"bytes": json.dumps({"type": "content_block_delta", "delta": {"text": text}}).encode()}}


def _message_start(input_tokens: int) -> dict:
    return {"chunk": {"bytes": json.dumps(
        {"type": "message_start", "message": {"usage": {"input_tokens": input_tokens}}}
    ).encode()}}


def _message_delta(output_tokens: int, stop_reason: str) -> dict:
    return {"chunk": {"bytes": json.dumps(
        {"type": "message_delta", "usage": {"output_tokens": output_tokens}, "delta": {"stop_reason": stop_reason}}
    ).encode()}}


def _client_with(events):
    client = MagicMock()
    client.invoke_model_with_response_stream.return_value = {"body": events}
    return client


def _run(monkeypatch, events):
    calls = []
    monkeypatch.setattr(streaming.logger, "info", lambda msg, **kw: calls.append(kw.get("extra", {})))
    out = streaming.stream_response(
        _client_with(events), model_id="anthropic.claude-3-sonnet-20240229-v1:0",
        system_prompt="sys", user_message="hi", chat_history=[], appsync_url="", session_id="s1",
    )
    latency = [e for e in calls if e.get("event") == "stream_latency"]
    assert len(latency) == 1
    return out, latency[0]


def test_assembles_text_and_logs_ttft_and_usage(monkeypatch):
    events = [
        _message_start(1234),
        _delta("Hello "), _delta("world"), _delta("!"),
        _message_delta(50, "end_turn"),
    ]
    out, lat = _run(monkeypatch, events)

    assert out == "Hello world!"  # behavior preserved
    assert lat["ttft_ms"] is not None
    assert isinstance(lat["stream_total_ms"], (int, float))
    assert lat["output_chars"] == len("Hello world!")
    assert lat["input_tokens"] == 1234
    assert lat["output_tokens"] == 50
    assert lat["stop_reason"] == "end_turn"


def test_guardrail_stop_reason_is_captured(monkeypatch):
    # A guardrail that halts generation surfaces via stop_reason — the signal
    # we use to tell guardrail stops apart from normal completion.
    events = [
        _message_start(900),
        _delta("partial"),
        _message_delta(3, "guardrail_intervened"),
    ]
    _out, lat = _run(monkeypatch, events)
    assert lat["stop_reason"] == "guardrail_intervened"
    assert lat["input_tokens"] == 900


def test_no_content_yields_none_ttft_and_usage(monkeypatch):
    out, lat = _run(monkeypatch, [])
    assert out == streaming.FALLBACK_MESSAGE
    assert lat["ttft_ms"] is None
    assert lat["output_chars"] == 0
    assert lat["input_tokens"] is None
    assert lat["output_tokens"] is None
    assert lat["stop_reason"] is None
