"""Tests for text_generation chat helpers.

chat.py imports heavy container-only deps (langchain_*) and a local
`constants.system_prompt`. Several sibling trees (lambda/lib, chatbot_v2/src)
also ship a top-level `constants` package, so under a full-repo pytest run the
name collides. To stay collection-order-independent we load chat.py by file
path with its import-time deps stubbed, then restore sys.modules so no other
tree's tests are affected. get_module_topics itself only needs `json` + a DB
connection, both of which survive the restore.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from unittest.mock import MagicMock

import pytest

_HEAVY_MODULES = [
    "langchain_aws",
    "langchain_core",
    "langchain_core.prompts",
    "langchain_core.runnables",
    "langchain_core.runnables.history",
    "langchain_classic",
    "langchain_classic.chains",
    "langchain_classic.chains.combine_documents",
    "langchain_community",
    "langchain_community.chat_message_histories",
    "constants",
    "constants.system_prompt",
]


def _load_chat_module():
    """Import the real chat.py under a unique name with import-time deps stubbed."""
    saved = {name: sys.modules.get(name) for name in _HEAVY_MODULES}
    try:
        for name in _HEAVY_MODULES:
            sys.modules[name] = MagicMock()
        sys.modules["constants.system_prompt"].SYSTEM_LEVEL_PROMPT = ""

        chat_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chat.py")
        spec = importlib.util.spec_from_file_location("tg_chat_under_test", chat_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        # Restore prior sys.modules state so sibling trees' `constants` packages
        # (lambda/lib, chatbot_v2) are unaffected by this test module.
        for name, prev in saved.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev


_chat = _load_chat_module()
get_module_topics = _chat.get_module_topics


def _conn_returning(value):
    """Build a fake DB connection whose cursor.fetchone() returns `value`."""
    conn = MagicMock()
    cur = MagicMock()
    cur.fetchone.return_value = value
    conn.cursor.return_value = cur
    return conn


class TestGetModuleTopics:
    def test_bare_array_is_injected(self):
        """Regression: generateTopics.js stores a bare array; it must inject."""
        conn = _conn_returning((["Sorting", "Graph Theory"],))
        result = get_module_topics("m1", conn)
        assert "Primary concepts covered by this module:" in result
        assert "- Sorting" in result
        assert "- Graph Theory" in result

    def test_json_string_array_is_injected(self):
        """Array stored as a JSON string (TEXT column) must also parse."""
        conn = _conn_returning(('["Sorting", "Searching"]',))
        result = get_module_topics("m1", conn)
        assert "- Sorting" in result
        assert "- Searching" in result

    def test_double_encoded_json_array_is_injected(self):
        """Double-encoded JSON string is unwrapped."""
        conn = _conn_returning(('"[\\"Recursion\\"]"',))
        result = get_module_topics("m1", conn)
        assert "- Recursion" in result

    def test_dict_shape_includes_objectives(self):
        """Legacy dict shape with learning_objectives still works."""
        conn = _conn_returning(({"topics": ["Trees"], "learning_objectives": ["Traverse a tree"]},))
        result = get_module_topics("m1", conn)
        assert "- Trees" in result
        assert "Key learning objectives:" in result
        assert "- Traverse a tree" in result

    def test_caps_topics_at_seven(self):
        conn = _conn_returning(([f"T{i}" for i in range(9)],))
        result = get_module_topics("m1", conn)
        assert "- T6" in result
        assert "- T7" not in result

    def test_no_row_returns_empty(self):
        assert get_module_topics("m1", _conn_returning(None)) == ""

    def test_null_topics_returns_empty(self):
        assert get_module_topics("m1", _conn_returning((None,))) == ""

    def test_empty_array_returns_empty(self):
        assert get_module_topics("m1", _conn_returning(([],))) == ""

    def test_db_error_returns_empty(self):
        """A DB failure must degrade gracefully to no injection, not raise."""
        conn = MagicMock()
        conn.cursor.side_effect = RuntimeError("connection lost")
        assert get_module_topics("m1", conn) == ""


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
