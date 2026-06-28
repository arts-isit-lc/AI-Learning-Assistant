"""Unit tests for ReasoningEngine."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from ..models.data_models import (
    ElementType,
    ImageAnalysis,
    QueryIntent,
    RankedResult,
    ReasoningResult,
    StructuredContext,
)
from .context_builder import ContextBuilder
from .image_escalation import EscalationResult, ImageEscalation
from .reasoning_engine import FALLBACK_ANSWER, ReasoningEngine


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_ranked_result(
    retrieval_id: str = "ret-1",
    content: str = "Some text content",
    element_type: ElementType = ElementType.TEXT,
    score: float = 0.85,
    image_s3_key: str | None = None,
) -> RankedResult:
    """Create a RankedResult for testing."""
    return RankedResult(
        retrieval_id=retrieval_id,
        parent_element_id="parent-1",
        content=content,
        element_type=element_type,
        score=score,
        cross_encoder_score=score,
        metadata_boost=0.0,
        metadata={"provenance_page_num": 1},
        image_s3_key=image_s3_key,
        sibling_ids=[],
    )


def _make_context(
    text_passages: list[RankedResult] | None = None,
    image_descriptions: list[RankedResult] | None = None,
) -> StructuredContext:
    """Create a StructuredContext for testing."""
    return StructuredContext(
        text_passages=text_passages or [_make_ranked_result()],
        image_descriptions=image_descriptions or [],
        formula_results=[],
        table_results=[],
        token_count=100,
    )


def _mock_bedrock_response(answer_text: str = "This is the answer.") -> MagicMock:
    """Create a mock Bedrock response."""
    response_body = {
        "content": [{"type": "text", "text": answer_text}],
        "usage": {"input_tokens": 50, "output_tokens": 20},
        "stop_reason": "end_turn",
    }
    mock_body = MagicMock()
    mock_body.read.return_value = json.dumps(response_body).encode()
    return {"body": mock_body}


# ---------------------------------------------------------------------------
# Tests: Basic answer generation
# ---------------------------------------------------------------------------


class TestGenerateAnswer:
    """Test the generate_answer method."""

    def test_generates_answer_with_bedrock(self):
        """Test successful answer generation via Bedrock."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response(
            "The answer is 42."
        )

        engine = ReasoningEngine(bedrock_client=mock_client)
        context = _make_context()

        result = engine.generate_answer(
            query="What is the answer?",
            context=context,
        )

        assert result.answer == "The answer is 42."
        assert isinstance(result, ReasoningResult)
        assert result.escalation_used is False
        assert result.image_analyses == []
        mock_client.invoke_model.assert_called_once()

    def test_returns_fallback_on_llm_failure(self):
        """Test graceful fallback when Bedrock invocation fails."""
        mock_client = MagicMock()
        mock_client.invoke_model.side_effect = Exception("Bedrock unavailable")

        engine = ReasoningEngine(bedrock_client=mock_client)
        context = _make_context()

        result = engine.generate_answer(
            query="What is the answer?",
            context=context,
        )

        assert result.answer == FALLBACK_ANSWER
        assert result.sources == []
        assert result.escalation_used is False

    def test_returns_fallback_when_no_bedrock_client(self):
        """Test fallback when no bedrock_client is provided."""
        engine = ReasoningEngine(bedrock_client=None)
        context = _make_context()

        result = engine.generate_answer(
            query="What is the answer?",
            context=context,
        )

        assert result.answer == FALLBACK_ANSWER
        assert result.escalation_used is False

    def test_never_raises_unhandled_exception(self):
        """Test that no exception propagates to caller (Req 12.4)."""
        mock_client = MagicMock()
        mock_client.invoke_model.side_effect = RuntimeError("Catastrophic failure")

        engine = ReasoningEngine(bedrock_client=mock_client)
        # Provide a context that could also cause issues
        context = _make_context()

        # Should never raise
        result = engine.generate_answer(
            query="Any query",
            context=context,
        )

        assert isinstance(result, ReasoningResult)
        assert result.answer == FALLBACK_ANSWER

    def test_includes_system_prompt(self):
        """Test that system_prompt is included in the Bedrock request."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        engine = ReasoningEngine(bedrock_client=mock_client)
        context = _make_context()

        engine.generate_answer(
            query="Question?",
            context=context,
            system_prompt="You are a helpful assistant.",
        )

        call_args = mock_client.invoke_model.call_args
        body = json.loads(call_args[1]["body"])
        assert body["system"] == "You are a helpful assistant."

    def test_includes_chat_history(self):
        """Test that chat_history is included in messages."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        engine = ReasoningEngine(bedrock_client=mock_client)
        context = _make_context()
        history = [
            {"role": "user", "content": "Previous question"},
            {"role": "assistant", "content": "Previous answer"},
        ]

        engine.generate_answer(
            query="Follow-up question?",
            context=context,
            chat_history=history,
        )

        call_args = mock_client.invoke_model.call_args
        body = json.loads(call_args[1]["body"])
        messages = body["messages"]
        # History + current query
        assert len(messages) == 3
        assert messages[0]["role"] == "user"
        assert messages[0]["content"] == "Previous question"
        assert messages[1]["role"] == "assistant"
        assert messages[1]["content"] == "Previous answer"
        assert "Follow-up question?" in messages[2]["content"]


# ---------------------------------------------------------------------------
# Tests: Source extraction
# ---------------------------------------------------------------------------


class TestSourceExtraction:
    """Test sources are correctly extracted from context."""

    def test_extracts_retrieval_ids_from_all_types(self):
        """Test sources include retrieval_ids from all context sections."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        engine = ReasoningEngine(bedrock_client=mock_client)

        context = StructuredContext(
            text_passages=[_make_ranked_result(retrieval_id="text-1")],
            image_descriptions=[
                _make_ranked_result(
                    retrieval_id="img-1", element_type=ElementType.IMAGE
                )
            ],
            formula_results=[
                _make_ranked_result(
                    retrieval_id="formula-1", element_type=ElementType.FORMULA
                )
            ],
            table_results=[
                _make_ranked_result(
                    retrieval_id="table-1", element_type=ElementType.TABLE
                )
            ],
            token_count=200,
        )

        result = engine.generate_answer(query="Q?", context=context)

        assert "text-1" in result.sources
        assert "img-1" in result.sources
        assert "formula-1" in result.sources
        assert "table-1" in result.sources
        assert len(result.sources) == 4

    def test_deduplicates_sources(self):
        """Test that duplicate retrieval_ids are deduplicated."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        engine = ReasoningEngine(bedrock_client=mock_client)

        context = StructuredContext(
            text_passages=[
                _make_ranked_result(retrieval_id="dup-1"),
                _make_ranked_result(retrieval_id="dup-1"),
                _make_ranked_result(retrieval_id="unique-1"),
            ],
            image_descriptions=[],
            formula_results=[],
            table_results=[],
            token_count=100,
        )

        result = engine.generate_answer(query="Q?", context=context)

        assert len(result.sources) == 2
        assert "dup-1" in result.sources
        assert "unique-1" in result.sources


# ---------------------------------------------------------------------------
# Tests: Image escalation
# ---------------------------------------------------------------------------


class TestImageEscalation:
    """Test escalation integration with ReasoningEngine."""

    def test_escalation_triggered_when_intent_requires_it(self):
        """Test escalation is triggered when query_intent.requires_escalation=True."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer with image")

        mock_escalation = MagicMock(spec=ImageEscalation)
        mock_escalation.escalate.return_value = EscalationResult(
            escalation_used=True,
            image_analyses=[
                ImageAnalysis(
                    image_s3_key="img/test.png",
                    analysis="This is a diagram showing...",
                    confidence=0.9,
                )
            ],
        )

        engine = ReasoningEngine(
            bedrock_client=mock_client,
            image_escalation=mock_escalation,
        )
        context = _make_context()
        ranked_results = [
            _make_ranked_result(image_s3_key="img/test.png", element_type=ElementType.IMAGE)
        ]
        intent = QueryIntent(requires_escalation=True)

        result = engine.generate_answer(
            query="Show me the diagram",
            context=context,
            ranked_results=ranked_results,
            query_intent=intent,
        )

        assert result.escalation_used is True
        assert len(result.image_analyses) == 1
        assert result.image_analyses[0].image_s3_key == "img/test.png"
        mock_escalation.escalate.assert_called_once_with(
            ranked_results, "Show me the diagram", query_intent=intent
        )

    def test_no_escalation_when_intent_does_not_require(self):
        """Test escalation is skipped when requires_escalation=False."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        mock_escalation = MagicMock(spec=ImageEscalation)

        engine = ReasoningEngine(
            bedrock_client=mock_client,
            image_escalation=mock_escalation,
        )
        context = _make_context()
        intent = QueryIntent(requires_escalation=False)

        result = engine.generate_answer(
            query="What is covered in lecture 3?",
            context=context,
            query_intent=intent,
        )

        assert result.escalation_used is False
        mock_escalation.escalate.assert_not_called()

    def test_no_escalation_when_image_escalation_not_available(self):
        """Test escalation is skipped when image_escalation is None."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        engine = ReasoningEngine(
            bedrock_client=mock_client,
            image_escalation=None,
        )
        context = _make_context()
        intent = QueryIntent(requires_escalation=True)

        result = engine.generate_answer(
            query="Show me the figure",
            context=context,
            query_intent=intent,
        )

        assert result.escalation_used is False

    def test_escalation_failure_returns_fallback_escalation(self):
        """Test escalation failure doesn't crash the engine."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer anyway")

        mock_escalation = MagicMock(spec=ImageEscalation)
        mock_escalation.escalate.side_effect = Exception("S3 unavailable")

        engine = ReasoningEngine(
            bedrock_client=mock_client,
            image_escalation=mock_escalation,
        )
        context = _make_context()
        intent = QueryIntent(requires_escalation=True)

        result = engine.generate_answer(
            query="Show me the diagram",
            context=context,
            ranked_results=[_make_ranked_result()],
            query_intent=intent,
        )

        # Should still produce an answer, just without escalation
        assert result.answer == "Answer anyway"
        assert result.escalation_used is False
        assert result.image_analyses == []

    def test_escalation_results_injected_into_prompt(self):
        """Test escalation analyses appear in the formatted prompt sent to LLM."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        mock_escalation = MagicMock(spec=ImageEscalation)
        mock_escalation.escalate.return_value = EscalationResult(
            escalation_used=True,
            image_analyses=[
                ImageAnalysis(
                    image_s3_key="img/diagram.png",
                    analysis="A flowchart showing process steps",
                    confidence=0.85,
                )
            ],
        )

        engine = ReasoningEngine(
            bedrock_client=mock_client,
            image_escalation=mock_escalation,
        )
        context = _make_context()
        intent = QueryIntent(requires_escalation=True)

        engine.generate_answer(
            query="Explain the diagram",
            context=context,
            ranked_results=[_make_ranked_result(image_s3_key="img/diagram.png")],
            query_intent=intent,
        )

        # Verify the LLM request includes escalation analysis
        call_args = mock_client.invoke_model.call_args
        body = json.loads(call_args[1]["body"])
        user_message = body["messages"][-1]["content"]
        assert "Visual Analysis of Referenced Figure" in user_message
        assert "A flowchart showing process steps" in user_message


# ---------------------------------------------------------------------------
# Tests: Context formatting
# ---------------------------------------------------------------------------


class TestContextFormatting:
    """Test context is properly formatted for the LLM."""

    def test_context_included_in_user_message(self):
        """Test that formatted context is included in the user message."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        engine = ReasoningEngine(bedrock_client=mock_client)
        context = _make_context(
            text_passages=[
                _make_ranked_result(content="Important course content here")
            ]
        )

        engine.generate_answer(query="What is important?", context=context)

        call_args = mock_client.invoke_model.call_args
        body = json.loads(call_args[1]["body"])
        user_message = body["messages"][-1]["content"]
        assert "Important course content here" in user_message
        assert "What is important?" in user_message

    def test_empty_context_still_generates(self):
        """Test that empty context doesn't crash the engine."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("No context answer")

        engine = ReasoningEngine(bedrock_client=mock_client)
        context = StructuredContext(
            text_passages=[],
            image_descriptions=[],
            formula_results=[],
            table_results=[],
            token_count=0,
        )

        result = engine.generate_answer(query="Q?", context=context)

        assert result.answer == "No context answer"
        assert result.sources == []


# ---------------------------------------------------------------------------
# Tests: Model configuration
# ---------------------------------------------------------------------------


class TestModelConfiguration:
    """Test model ID configuration."""

    def test_uses_default_model_id(self):
        """Test that the default model ID is used when not specified."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        engine = ReasoningEngine(bedrock_client=mock_client)
        context = _make_context()

        engine.generate_answer(query="Q?", context=context)

        call_args = mock_client.invoke_model.call_args
        assert call_args[1]["modelId"] == "anthropic.claude-3-haiku-20240307-v1:0"

    def test_uses_custom_model_id(self):
        """Test that a custom model ID is used when specified."""
        mock_client = MagicMock()
        mock_client.invoke_model.return_value = _mock_bedrock_response("Answer")

        engine = ReasoningEngine(
            bedrock_client=mock_client,
            model_id="anthropic.claude-3-sonnet-20240229-v1:0",
        )
        context = _make_context()

        engine.generate_answer(query="Q?", context=context)

        call_args = mock_client.invoke_model.call_args
        assert call_args[1]["modelId"] == "anthropic.claude-3-sonnet-20240229-v1:0"
