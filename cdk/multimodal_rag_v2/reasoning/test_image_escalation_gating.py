"""Tests for STRICT_IMAGE_ESCALATION gating (Phase 2 #9).

Flag OFF preserves current behavior (escalate on bare keyword). Flag ON only
escalates on an explicit escalation flag or a concrete figure reference.
"""
from __future__ import annotations

from unittest.mock import MagicMock

from ..models.data_models import FigureReference, QueryIntent
from . import reasoning_engine as re_mod
from .image_escalation import EscalationResult, ImageEscalation
from .reasoning_engine import ReasoningEngine


def _engine_with_mock_escalation():
    mock_escalation = MagicMock(spec=ImageEscalation)
    mock_escalation.escalate.return_value = EscalationResult(
        escalation_used=True, image_analyses=[]
    )
    engine = ReasoningEngine(bedrock_client=MagicMock(), image_escalation=mock_escalation)
    return engine, mock_escalation


class TestImageEscalationGating:
    def test_flag_off_escalates_on_bare_keyword(self, monkeypatch):
        monkeypatch.setattr(re_mod, "STRICT_IMAGE_ESCALATION", False)
        engine, esc = _engine_with_mock_escalation()
        intent = QueryIntent(requires_image=True)  # bare keyword, no figure ref
        engine._handle_escalation("show the graph", [], intent)
        esc.escalate.assert_called_once()

    def test_flag_on_skips_bare_keyword(self, monkeypatch):
        monkeypatch.setattr(re_mod, "STRICT_IMAGE_ESCALATION", True)
        engine, esc = _engine_with_mock_escalation()
        intent = QueryIntent(requires_image=True)  # bare keyword only
        result = engine._handle_escalation("show the graph", [], intent)
        esc.escalate.assert_not_called()
        assert result.escalation_used is False

    def test_flag_on_still_escalates_on_requires_escalation(self, monkeypatch):
        monkeypatch.setattr(re_mod, "STRICT_IMAGE_ESCALATION", True)
        engine, esc = _engine_with_mock_escalation()
        intent = QueryIntent(requires_escalation=True)
        engine._handle_escalation("analyze this", [], intent)
        esc.escalate.assert_called_once()

    def test_flag_on_escalates_with_explicit_figure_reference(self, monkeypatch):
        monkeypatch.setattr(re_mod, "STRICT_IMAGE_ESCALATION", True)
        engine, esc = _engine_with_mock_escalation()
        intent = QueryIntent(
            requires_image=True,
            figure_reference=FigureReference(ref_type="figure", number="3"),
        )
        engine._handle_escalation("what does figure 3 show", [], intent)
        esc.escalate.assert_called_once()

    def test_no_escalation_when_component_missing(self, monkeypatch):
        monkeypatch.setattr(re_mod, "STRICT_IMAGE_ESCALATION", False)
        engine = ReasoningEngine(bedrock_client=MagicMock(), image_escalation=None)
        result = engine._handle_escalation(
            "show the graph", [], QueryIntent(requires_image=True)
        )
        assert result.escalation_used is False
