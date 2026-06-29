"""Tests for RAG_RETURN_PASSAGES (Phase 2 #1 — eliminate double generation).

Flag ON: retrieval returns the formatted passages and skips the reasoning LLM
(the chatbot's Sonnet pass then generates once from these passages).
Flag OFF: unchanged — the reasoning LLM generates the answer.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

from ..models.data_models import ElementType, RankedResult, StructuredContext
from . import reasoning_engine as re_mod
from .reasoning_engine import ReasoningEngine


class _Body:
    def __init__(self, payload: dict) -> None:
        self._p = json.dumps(payload).encode()

    def read(self) -> bytes:
        return self._p


def _ctx() -> StructuredContext:
    rr = RankedResult(
        retrieval_id="r1",
        parent_element_id="p1",
        content="Photosynthesis converts light to energy.",
        element_type=ElementType.TEXT,
        score=0.9,
        cross_encoder_score=0.9,
        metadata_boost=0.0,
        metadata={"provenance_page_num": 1, "provenance_position_index": 0},
        image_s3_key=None,
        sibling_ids=[],
    )
    return StructuredContext(
        text_passages=[rr],
        image_descriptions=[],
        formula_results=[],
        table_results=[],
        token_count=20,
    )


class TestPassagesMode:
    def test_flag_on_returns_passages_and_skips_llm(self, monkeypatch):
        monkeypatch.setattr(re_mod, "RAG_RETURN_PASSAGES", True)
        client = MagicMock()
        engine = ReasoningEngine(bedrock_client=client)
        spy = MagicMock(return_value="SHOULD NOT BE CALLED")
        monkeypatch.setattr(engine, "_invoke_llm", spy)

        result = engine.generate_answer(query="explain photosynthesis", context=_ctx())

        spy.assert_not_called()
        client.invoke_model.assert_not_called()  # no generation Bedrock call at all
        assert "Photosynthesis converts light to energy." in result.answer
        assert result.sources == ["r1"]

    def test_flag_off_invokes_llm_as_before(self, monkeypatch):
        monkeypatch.setattr(re_mod, "RAG_RETURN_PASSAGES", False)
        client = MagicMock()
        client.invoke_model.return_value = {
            "body": _Body(
                {
                    "content": [{"type": "text", "text": "Generated answer"}],
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                }
            )
        }
        engine = ReasoningEngine(bedrock_client=client)

        result = engine.generate_answer(query="explain photosynthesis", context=_ctx())

        assert result.answer == "Generated answer"
        client.invoke_model.assert_called_once()
