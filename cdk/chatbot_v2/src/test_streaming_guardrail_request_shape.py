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
