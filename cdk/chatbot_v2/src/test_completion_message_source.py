"""Tests for the persisted `completion_message_source` field on SessionState.

`completion_message_source` records the provenance of the delivered completion
message ("generated" | "guardrail_retry" | "blocked_fallback"), kept alongside
the `completion_message_sent` loop guard so the Option-C outcomes are
distinguishable for debugging. state_machine has no psycopg2 dependency, so it
imports directly.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from state_machine import (  # noqa: E402
    create_default_state,
    deserialize_state,
    serialize_state,
)


class TestCompletionMessageSourcePersistence:
    def test_default_is_empty(self):
        s = create_default_state("sess-1")
        assert s.completion_message_source == ""

    def test_roundtrip_preserves_source(self):
        for source in ("generated", "guardrail_retry", "blocked_fallback"):
            s = create_default_state("sess-1")
            s.completion_message_source = source
            restored = deserialize_state(serialize_state(s))
            assert restored.completion_message_source == source

    def test_serialize_includes_source(self):
        s = create_default_state("sess-1")
        s.completion_message_source = "guardrail_retry"
        assert serialize_state(s)["completion_message_source"] == "guardrail_retry"

    def test_deserialize_legacy_item_without_source_uses_default(self):
        # A session persisted before this field existed has no key — must not
        # KeyError and must default to "" (backward compatible).
        legacy = {"session_id": "old", "stage": "comprehension", "completion_message_sent": True}
        restored = deserialize_state(legacy)
        assert restored.completion_message_source == ""
        # The existing loop-guard flag still deserializes alongside it.
        assert restored.completion_message_sent is True
        assert restored.session_id == "old"
