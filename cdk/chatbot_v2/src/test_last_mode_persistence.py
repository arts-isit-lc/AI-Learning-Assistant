"""Tests for the persisted `last_mode` field on SessionState.

`last_mode` records the Socratic response mode select_mode() chose this session
(e.g. "hint_nudge" / "hint_scaffold"), persisted only so the course-progress
debug view can surface hint escalation that is otherwise transient. state_machine
has no psycopg2 dependency, so it imports directly.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from state_machine import (  # noqa: E402
    create_default_state,
    deserialize_state,
    serialize_state,
)


class TestLastModePersistence:
    def test_default_is_empty(self):
        s = create_default_state("sess-1")
        assert s.last_mode == ""

    def test_roundtrip_preserves_last_mode(self):
        s = create_default_state("sess-1")
        s.last_mode = "hint_scaffold"
        restored = deserialize_state(serialize_state(s))
        assert restored.last_mode == "hint_scaffold"

    def test_serialize_includes_last_mode(self):
        s = create_default_state("sess-1")
        s.last_mode = "hint_nudge"
        assert serialize_state(s)["last_mode"] == "hint_nudge"

    def test_deserialize_legacy_item_without_last_mode_uses_default(self):
        # A session persisted before this field existed has no key — must not
        # KeyError and must default to "".
        legacy = {"session_id": "old", "stage": "comprehension"}
        restored = deserialize_state(legacy)
        assert restored.last_mode == ""
        assert restored.session_id == "old"
