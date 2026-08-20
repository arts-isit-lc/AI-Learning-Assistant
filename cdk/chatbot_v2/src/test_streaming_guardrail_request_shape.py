"""Tests for the Bedrock request shape built by stream_response.

Guardrail identifiers are top-level InvokeModelWithResponseStream parameters
(sent as X-Amzn-Bedrock-Guardrail* headers) — NOT fields inside the JSON model
body. Putting them in the body previously caused:

    ValidationException: Malformed input request: #: subject must not be valid
    against schema {"required":["messages"]}#: extraneous key
    [amazon-bedrock-guardrailConfig] is not permitted

because the body is passed straight through to the model (Claude's Messages
API schema rejects unknown keys). This locks in the correct request shape.
"""
from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(__file__))

from streaming import stream_response  # noqa: E402


def _fake_bedrock_client(captured: dict):
    client = MagicMock()

    def _invoke(**kwargs):
        captured.update(kwargs)
        return {"body": []}  # empty stream -> stream_response returns FALLBACK_MESSAGE

    client.invoke_model_with_response_stream.side_effect = _invoke
    return client


class TestGuardrailRequestShape:
    def test_guardrail_params_are_top_level_kwargs_not_in_body(self):
        captured: dict = {}
        client = _fake_bedrock_client(captured)

        stream_response(
            bedrock_client=client,
            model_id="anthropic.claude-3-5-sonnet",
            system_prompt="s",
            user_message="hello",
            chat_history=[],
            appsync_url="",
            session_id="sess-1",
            model_kwargs={"max_tokens": 100, "guardrail_id": "gr-1", "guardrail_version": "2"},
        )

        assert captured["guardrailIdentifier"] == "gr-1"
        assert captured["guardrailVersion"] == "2"

        body = json.loads(captured["body"])
        assert "amazon-bedrock-guardrailConfig" not in body
        assert "guardrailIdentifier" not in body
        assert set(body.keys()) == {"anthropic_version", "max_tokens", "system", "messages"}

    def test_no_guardrail_id_omits_guardrail_kwargs_entirely(self):
        captured: dict = {}
        client = _fake_bedrock_client(captured)

        stream_response(
            bedrock_client=client,
            model_id="anthropic.claude-3-5-sonnet",
            system_prompt="s",
            user_message="hello",
            chat_history=[],
            appsync_url="",
            session_id="sess-1",
            model_kwargs={"max_tokens": 100, "guardrail_id": "", "guardrail_version": ""},
        )

        assert "guardrailIdentifier" not in captured
        assert "guardrailVersion" not in captured

    def test_no_model_kwargs_does_not_raise(self):
        captured: dict = {}
        client = _fake_bedrock_client(captured)

        result = stream_response(
            bedrock_client=client,
            model_id="anthropic.claude-3-5-sonnet",
            system_prompt="s",
            user_message="hello",
            chat_history=[],
            appsync_url="",
            session_id="sess-1",
            model_kwargs=None,
        )

        assert "guardrailIdentifier" not in captured
        assert result  # FALLBACK_MESSAGE on an empty stream

    def test_disabled_flag_omits_guardrail_even_with_id(self, monkeypatch):
        # STREAM_GUARDRAIL_DISABLED (dev diagnostic) must drop the guardrail from
        # the streaming call even when a guardrail_id is supplied, so we can
        # measure TTFT without it. Default (False) behavior is covered above.
        import streaming
        monkeypatch.setattr(streaming, "STREAM_GUARDRAIL_DISABLED", True)

        captured: dict = {}
        client = _fake_bedrock_client(captured)

        stream_response(
            bedrock_client=client,
            model_id="anthropic.claude-3-sonnet-20240229-v1:0",
            system_prompt="s",
            user_message="hello",
            chat_history=[],
            appsync_url="",
            session_id="sess-1",
            model_kwargs={"max_tokens": 100, "guardrail_id": "gr-1", "guardrail_version": "2"},
        )

        assert "guardrailIdentifier" not in captured
        assert "guardrailVersion" not in captured


def _fake_converse_client(captured: dict):
    """Fake Bedrock client for the ConverseStream path. Captures converse_stream
    kwargs and returns an empty stream so stream_response falls through to
    FALLBACK_MESSAGE without needing real events."""
    client = MagicMock()

    def _converse(**kwargs):
        captured.update(kwargs)
        return {"stream": []}

    client.converse_stream.side_effect = _converse
    return client


class TestConverseGuardContentScoping:
    """The ConverseStream path must scope the INPUT guardrail to ONLY the current
    student message via a guardContent block, so the system prompt and the whole
    conversation history are NOT re-scanned as input every turn (the guardrail
    false-positive fix). XML input tags (wrap_user_message) do not apply to the
    Converse API — guardContent is the Converse-native mechanism."""

    HISTORY = [
        {"role": "user", "content": "earlier question about joins"},
        {"role": "assistant", "content": "earlier socratic reply"},
    ]

    def _run(self, monkeypatch, *, guardrail_id="gr-1", disabled=False):
        import streaming
        monkeypatch.setattr(streaming, "USE_CONVERSE_STREAMING", True)
        if disabled:
            monkeypatch.setattr(streaming, "STREAM_GUARDRAIL_DISABLED", True)
        captured: dict = {}
        client = _fake_converse_client(captured)
        stream_response(
            bedrock_client=client,
            model_id="anthropic.claude-3-5-sonnet",
            system_prompt="SYSTEM_PROMPT_TEXT",
            user_message="INNER JOIN returns only matching rows",
            chat_history=self.HISTORY,
            appsync_url="",
            session_id="sess-1",
            model_kwargs={"max_tokens": 100, "guardrail_id": guardrail_id, "guardrail_version": "2"},
        )
        return captured

    def test_current_user_message_is_wrapped_in_guardcontent(self, monkeypatch):
        captured = self._run(monkeypatch)
        last = captured["messages"][-1]
        assert last["role"] == "user"
        assert last["content"] == [
            {"guardContent": {"text": {"text": "INNER JOIN returns only matching rows"}}}
        ]

    def test_history_turns_are_not_guarded(self, monkeypatch):
        # Only the final message carries guardContent; prior turns stay plain text
        # so the guardrail skips them on input (they were guarded on their turns).
        captured = self._run(monkeypatch)
        history_msgs = captured["messages"][:-1]
        assert len(history_msgs) == 2
        for msg in history_msgs:
            assert msg["content"][0].get("text") is not None
            assert "guardContent" not in msg["content"][0]

    def test_system_prompt_is_not_guarded(self, monkeypatch):
        # System prompt goes in the `system` field as plain text (developer-trusted,
        # never wrapped in guardContent) so it is not assessed on input.
        captured = self._run(monkeypatch)
        assert captured["system"] == [{"text": "SYSTEM_PROMPT_TEXT"}]

    def test_guardrail_config_still_attached(self, monkeypatch):
        captured = self._run(monkeypatch)
        cfg = captured["guardrailConfig"]
        assert cfg["guardrailIdentifier"] == "gr-1"
        assert cfg["streamProcessingMode"] == "async"
        assert cfg["trace"] == "enabled"

    def test_no_guardcontent_when_guardrail_absent(self, monkeypatch):
        # No guardrail id -> behavior preserved: plain text message, no guardContent,
        # no guardrailConfig. (guardContent only makes sense with a guardrail.)
        captured = self._run(monkeypatch, guardrail_id="")
        assert captured["messages"][-1]["content"] == [
            {"text": "INNER JOIN returns only matching rows"}
        ]
        assert "guardrailConfig" not in captured

    def test_no_guardcontent_when_stream_guardrail_disabled(self, monkeypatch):
        # The DEV-ONLY STREAM_GUARDRAIL_DISABLED diagnostic must stay byte-for-byte
        # unchanged: plain text message, guardrail detached.
        captured = self._run(monkeypatch, disabled=True)
        assert captured["messages"][-1]["content"] == [
            {"text": "INNER JOIN returns only matching rows"}
        ]
        assert "guardrailConfig" not in captured
