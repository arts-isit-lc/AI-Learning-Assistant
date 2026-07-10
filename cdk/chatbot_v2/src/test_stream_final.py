"""Tests for the stream-authoritative delivery contract (Option B).

- send_final emits the SINGLE terminal message (done=true) carrying the final
  blocks + metadata, or error=true.
- send_chunk stays incremental (done=false, no payload).
- stream_response no longer emits any terminal done (that's the handler's job).
- main._stream_final forwards to send_final and no-ops without a session_id.

Deterministic: httpx + AppSync are faked; no network, no Bedrock.
"""
from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(__file__))

import streaming  # noqa: E402


class _FakeClient:
    """Captures posted JSON payloads; usable as a context manager (like httpx.Client)."""

    def __init__(self, sink):
        self._sink = sink

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def post(self, url, headers=None, json=None):
        self._sink.append({"url": url, "headers": headers, "json": json})
        return MagicMock(status_code=200)


def _capture(monkeypatch):
    sink = []
    monkeypatch.setattr(streaming.httpx, "Client", lambda *a, **k: _FakeClient(sink))
    return sink


class TestSendFinal:
    def test_emits_done_with_blocks_and_metadata(self, monkeypatch):
        sink = _capture(monkeypatch)
        blocks = [{"type": "text", "content": "hi"}, {"type": "figure", "id": "r1"}]
        streaming.send_final(
            "https://appsync", "s1", llm_output="hi", blocks=blocks,
            session_name="Chat", llm_verdict=True,
        )
        assert len(sink) == 1
        v = sink[0]["json"]["variables"]
        assert v["session_id"] == "s1"
        assert v["done"] is True
        assert v["error"] is False
        assert v["llm_output"] == "hi"
        assert v["session_name"] == "Chat"
        assert v["llm_verdict"] is True
        # blocks are serialized to an AWSJSON string on the wire
        assert json.loads(v["blocks"]) == blocks

    def test_error_final_flags_error_and_null_blocks(self, monkeypatch):
        sink = _capture(monkeypatch)
        streaming.send_final("https://appsync", "s1", error=True)
        v = sink[0]["json"]["variables"]
        assert v["done"] is True
        assert v["error"] is True
        assert v["blocks"] is None

    def test_no_appsync_url_is_noop(self, monkeypatch):
        sink = _capture(monkeypatch)
        streaming.send_final("", "s1", llm_output="x")
        assert sink == []


class TestSendChunk:
    def test_incremental_chunk_not_done_no_payload(self, monkeypatch):
        sink = _capture(monkeypatch)
        streaming.send_chunk("https://appsync", "s1", "hello")
        v = sink[0]["json"]["variables"]
        assert v["done"] is False
        assert v["chunk"] == "hello"
        assert v["blocks"] is None
        assert v["llm_output"] is None


class TestStreamResponseNoTerminalDone:
    def test_stream_response_emits_only_incremental_chunks(self, monkeypatch):
        """stream_response streams text (done=false) but never emits a terminal
        done — the handler owns that via send_final."""
        recorded_done_flags = []
        monkeypatch.setattr(
            streaming, "send_chunk",
            lambda url, sid, chunk, done=False: recorded_done_flags.append(done),
        )

        def fake_iter(*args, **kwargs):
            yield ("delta", "hello world " * 20)  # > CHUNK_SIZE, forces flushes
            yield ("stop", "end_turn")

        # Patch both iterators so the result is independent of USE_CONVERSE_STREAMING.
        monkeypatch.setattr(streaming, "_iter_invoke_events", fake_iter)
        monkeypatch.setattr(streaming, "_iter_converse_events", fake_iter)

        out = streaming.stream_response(
            MagicMock(), model_id="m", system_prompt="s", user_message="u",
            chat_history=[], appsync_url="https://x", session_id="s1", model_kwargs={},
        )
        assert out == "hello world " * 20  # assembled text unchanged
        assert recorded_done_flags  # some chunks were streamed
        assert all(done is False for done in recorded_done_flags)  # NO terminal done here


class TestMainStreamFinalHelper:
    def _import_main(self):
        import main  # noqa: E402
        return main

    def test_noop_without_session_id(self, monkeypatch):
        main = self._import_main()
        called = []
        monkeypatch.setattr(main, "send_final", lambda *a, **k: called.append((a, k)))
        main._stream_final("", llm_output="x")
        assert called == []

    def test_forwards_success_payload(self, monkeypatch):
        main = self._import_main()
        called = []
        monkeypatch.setattr(main, "send_final", lambda *a, **k: called.append((a, k)))
        monkeypatch.setattr(main, "_get_appsync_url", lambda: "https://x")
        blocks = [{"type": "text", "content": "hi"}]
        main._stream_final("s1", llm_output="hi", blocks=blocks, session_name="C", llm_verdict=False)
        assert len(called) == 1
        args, kwargs = called[0]
        assert args[0] == "https://x"
        assert args[1] == "s1"
        assert kwargs["llm_output"] == "hi"
        assert kwargs["blocks"] == blocks
        assert kwargs["error"] is False

    def test_forwards_error(self, monkeypatch):
        main = self._import_main()
        called = []
        monkeypatch.setattr(main, "send_final", lambda *a, **k: called.append(k))
        monkeypatch.setattr(main, "_get_appsync_url", lambda: "https://x")
        main._stream_final("s1", error=True)
        assert called[0]["error"] is True
