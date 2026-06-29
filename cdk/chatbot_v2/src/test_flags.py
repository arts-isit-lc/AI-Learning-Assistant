"""Unit tests for the chatbot_v2 feature-flag parser (Phase 0b)."""
from __future__ import annotations

import os
import sys

import pytest

# chatbot_v2/src uses flat imports; ensure this dir is importable when pytest
# is run from cdk/.
sys.path.insert(0, os.path.dirname(__file__))

from flags import parse_flag  # noqa: E402


class TestParseFlag:
    @pytest.mark.parametrize("raw", ["1", "true", "TRUE", "yes", "on", " on "])
    def test_truthy_values_enable(self, raw):
        assert parse_flag(raw, default=False) is True

    @pytest.mark.parametrize("raw", ["0", "false", "no", "off", "", "maybe"])
    def test_non_truthy_values_disable(self, raw):
        assert parse_flag(raw, default=True) is False

    def test_unset_uses_default(self):
        assert parse_flag(None, default=True) is True
        assert parse_flag(None, default=False) is False

    def test_non_string_coerced(self):
        assert parse_flag(1, default=False) is True
        assert parse_flag(0, default=True) is False
