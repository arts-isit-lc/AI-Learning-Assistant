"""Tests for chatbot_v2 _get_appsync_url (chatbot-v2-integration AppSync wiring).

main.py imports psycopg2 at module load and isn't installed locally, so a bare
fake is injected into sys.modules before importing main (same pattern as
test_allowed_file_ids.py). The AppSync URL is resolved either directly from the
APPSYNC_API_URL env var or, when only APPSYNC_API_URL_PARAM is set, from SSM.
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# Fake psycopg2 so `import psycopg2` in main.py resolves (driver not installed locally).
sys.modules.setdefault("psycopg2", SimpleNamespace(connect=lambda *a, **k: None))
sys.path.insert(0, os.path.dirname(__file__))

import main  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    # _get_appsync_url caches in a module global; reset env + cache before each test.
    monkeypatch.setattr(main, "_appsync_url", None)
    monkeypatch.setattr(main, "APPSYNC_API_URL", "")
    monkeypatch.setattr(main, "APPSYNC_API_URL_PARAM", "")


def _ssm_returning(value):
    client = MagicMock()
    client.get_parameter.return_value = {"Parameter": {"Value": value}}
    return client


def test_direct_env_url_takes_precedence(monkeypatch):
    monkeypatch.setattr(main, "APPSYNC_API_URL", "https://direct.example/graphql")
    ssm = MagicMock()
    monkeypatch.setattr(main, "_ssm_client", ssm)
    assert main._get_appsync_url() == "https://direct.example/graphql"
    ssm.get_parameter.assert_not_called()


def test_resolves_from_ssm_param(monkeypatch):
    monkeypatch.setattr(main, "APPSYNC_API_URL_PARAM", "/AILA/dev/AppSyncApiUrl")
    monkeypatch.setattr(main, "_ssm_client", _ssm_returning("https://ssm.example/graphql"))
    assert main._get_appsync_url() == "https://ssm.example/graphql"


def test_caches_after_first_resolution(monkeypatch):
    monkeypatch.setattr(main, "APPSYNC_API_URL_PARAM", "/AILA/dev/AppSyncApiUrl")
    ssm = _ssm_returning("https://ssm.example/graphql")
    monkeypatch.setattr(main, "_ssm_client", ssm)
    main._get_appsync_url()
    main._get_appsync_url()
    assert ssm.get_parameter.call_count == 1


def test_no_config_returns_empty(monkeypatch):
    monkeypatch.setattr(main, "_ssm_client", MagicMock())
    assert main._get_appsync_url() == ""


def test_ssm_error_returns_empty(monkeypatch):
    # A failed SSM lookup must degrade to no streaming, not raise.
    monkeypatch.setattr(main, "APPSYNC_API_URL_PARAM", "/AILA/dev/AppSyncApiUrl")
    ssm = MagicMock()
    ssm.get_parameter.side_effect = RuntimeError("ssm down")
    monkeypatch.setattr(main, "_ssm_client", ssm)
    assert main._get_appsync_url() == ""


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
