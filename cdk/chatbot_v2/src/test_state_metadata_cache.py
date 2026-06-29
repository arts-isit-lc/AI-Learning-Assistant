"""Tests for cached module metadata in session state (Phase 1 #10).

state_machine has no psycopg2 dependency, so it imports directly.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from state_machine import (  # noqa: E402
    create_default_state,
    deserialize_state,
    serialize_state,
)


class TestModuleMetadataCache:
    def test_defaults_are_empty(self):
        s = create_default_state("sess-1")
        assert s.module_name == ""
        assert s.allowed_file_ids == []

    def test_roundtrip_preserves_cached_metadata(self):
        s = create_default_state("sess-1")
        s.module_name = "Intro to Algorithms"
        s.allowed_file_ids = ["f1", "f2", "f3"]
        restored = deserialize_state(serialize_state(s))
        assert restored.module_name == "Intro to Algorithms"
        assert restored.allowed_file_ids == ["f1", "f2", "f3"]

    def test_deserialize_legacy_item_without_fields_uses_defaults(self):
        # A session persisted before #10 has neither key — must not KeyError.
        legacy = {"session_id": "old", "stage": "comprehension"}
        restored = deserialize_state(legacy)
        assert restored.module_name == ""
        assert restored.allowed_file_ids == []
        assert restored.session_id == "old"

    def test_serialize_includes_new_fields(self):
        s = create_default_state("sess-1")
        s.module_name = "M"
        s.allowed_file_ids = ["x"]
        out = serialize_state(s)
        assert out["module_name"] == "M"
        assert out["allowed_file_ids"] == ["x"]
