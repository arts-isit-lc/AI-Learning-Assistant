"""Tests for stream_response latency instrumentation (TTFT).

Feeds a fake Bedrock event stream and asserts (a) the assembled text is
unchanged (behavior preserved) and (b) a `stream_latency` log is emitted with
ttft_ms / stream_total_ms / output_chars. Deterministic: no network
(appsync_url="" makes send_chunk a no-op), no real Bedrock.
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


def _client_with(events):
    client = MagicMock()
    client.invoke_model_with_response_stream.return_value = {"body": events}
    return client


def test_assembles_text_and_logs_ttft(monkeypatch):
    calls = []
    monkeypatch.setattr(streaming.logger, "info", lambda msg, **kw: calls.append(kw.get("extra", {})))
    client = _client_with([_delta("Hello "), _delta("world"), _delta("!")])

    out = streaming.stream_response(
        client, model_id="anthropic.claude-3-sonnet-20240229-v1:0",
        system_prompt="sys", user_message="hi", chat_history=[], appsync_url="", session_id="s1",
    )

    assert out == "Hello world!"  # behavior preserved
    latency = [e for e in calls if e.get("event") == "stream_latency"]
    assert len(latency) == 1
    assert latency[0]["ttft_ms"] is not None
    assert isinstance(latency[0]["stream_total_ms"], (int, float))
    assert latency[0]["output_chars"] == len("Hello world!")


def test_ttft_is_none_when_no_content(monkeypatch):
    # An empty stream (no content deltas) -> no first token -> ttft_ms None,
    # fallback returned. Guards against the timing crashing on empty output.
    calls = []
    monkeypatch.setattr(streaming.logger, "info", lambda msg, **kw: calls.append(kw.get("extra", {})))
    client = _client_with([])

    out = streaming.stream_response(
        client, model_id="anthropic.claude-3-sonnet-20240229-v1:0",
        system_prompt="sys", user_message="hi", chat_history=[], appsync_url="", session_id="s1",
    )

    assert out == streaming.FALLBACK_MESSAGE
    latency = [e for e in calls if e.get("event") == "stream_latency"]
    assert len(latency) == 1
    assert latency[0]["ttft_ms"] is None
    assert latency[0]["output_chars"] == 0
