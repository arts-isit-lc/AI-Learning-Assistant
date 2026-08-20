"""Tests for the persisted `completion_pending` field on SessionState.

`completion_pending` is the one-turn deferral flag for the completion
acknowledgement: the turn that first meets the metrics gate keeps its normal
instructional mode and latches this flag; the NEXT turn fires the "complete"
message. It must survive serialization (it lives across turns) and default to
False for sessions persisted before the field existed. state_machine has no
psycopg2 dependency, so it imports directly.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from state_machine import (  # noqa: E402
    create_default_state,
    deserialize_state,
    serialize_state,
)


class TestCompletionPendingPersistence:
    def test_default_is_false(self):
        s = create_default_state("sess-1")
        assert s.completion_pending is False

    def test_roundtrip_preserves_pending(self):
        for pending in (True, False):
            s = create_default_state("sess-1")
            s.completion_pending = pending
            restored = deserialize_state(serialize_state(s))
            assert restored.completion_pending is pending

    def test_serialize_includes_pending(self):
        s = create_default_state("sess-1")
        s.completion_pending = True
        assert serialize_state(s)["completion_pending"] is True

    def test_deserialize_legacy_item_without_pending_uses_default(self):
        # A session persisted before this field existed has no key — must not
        # KeyError and must default to False (backward compatible).
        legacy = {"session_id": "old", "stage": "comprehension", "module_complete": True}
        restored = deserialize_state(legacy)
        assert restored.completion_pending is False
        assert restored.module_complete is True
        assert restored.session_id == "old"
