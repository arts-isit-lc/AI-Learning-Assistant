"""Unit tests for the feature-flag parser (Phase 0b)."""
from __future__ import annotations

import pytest

from .flags import parse_flag


class TestParseFlag:
    @pytest.mark.parametrize("raw", ["1", "true", "TRUE", "True", "yes", "on", " on ", "On"])
    def test_truthy_values_enable(self, raw):
        assert parse_flag(raw, default=False) is True

    @pytest.mark.parametrize("raw", ["0", "false", "no", "off", "", "nope", "2"])
    def test_non_truthy_values_disable(self, raw):
        assert parse_flag(raw, default=True) is False

    def test_unset_uses_default_true(self):
        assert parse_flag(None, default=True) is True

    def test_unset_uses_default_false(self):
        assert parse_flag(None, default=False) is False

    def test_default_off_means_deploy_is_noop(self):
        # The safety contract: an unset flag preserves pre-optimization behavior.
        assert parse_flag(None, default=False) is False
