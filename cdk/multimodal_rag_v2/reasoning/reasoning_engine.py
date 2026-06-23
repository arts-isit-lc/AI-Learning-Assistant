"""ReasoningEngine orchestrates the full reasoning flow.

Responsibilities:
- Query analysis → context building → escalation → answer generation
- Inject escalation results into context after sibling expansion, before final prompt formatting
- Handle LLM failure: return graceful fallback response
- Return ReasoningResult with answer, sources, escalation_used, image_analyses
"""

from __future__ import annotations

import json
from typing import Any

from aws_lambda_powertools import Logger

from ..models.data_models import (
    ImageAnalysis,
    QueryIntent,
    RankedResult,
    ReasoningResult,
    StructuredContext,
)
from .context_builder import ContextBuilder
from .image_escalation import EscalationResult, ImageEscalation

logger = Logger(service="multimodal-rag-reasoning")

# Default model for answer generation
DEFAULT_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

# Fallback response when LLM is unavailable
FALLBACK_ANSWER = (
    "I'm sorry, the service is temporarily unavailable. Please try again."
)


class ReasoningEngine:
    """Generates answers from multimodal context with optional image escalation.

    Orchestrates the full reasoning flow:
    1. If query_intent.requires_escalation and image_escalation is available:
       - Call image_escalation.escalate(ranked_results, query)
       - Inject results into context
    2. Format context for prompt using context_builder.format_for_prompt()
    3. Invoke Bedrock LLM with formatted prompt + query
    4. Parse answer from LLM response
    5. Extract sources from context (retrieval_ids)
    6. Return ReasoningResult(answer, sources, escalation_used, image_analyses)

    Error handling (Req 12.4):
    - On ANY LLM failure: return graceful fallback response
    - NEVER raise unhandled exceptions
    """

    def __init__(
        self,
        bedrock_client: Any = None,
        context_builder: ContextBuilder | None = None,
        image_escalation: ImageEscalation | None = None,
        model_id: str = DEFAULT_MODEL_ID,
    ) -> None:
        """Initialize ReasoningEngine with dependencies.

        Args:
            bedrock_client: Boto3 Bedrock Runtime client for LLM invocation.
            context_builder: ContextBuilder for formatting context into prompts.
            image_escalation: ImageEscalation for vision LLM analysis of images.
            model_id: Bedrock model ID for answer generation.
        """
        self.bedrock_client = bedrock_client
        self.context_builder = context_builder or ContextBuilder()
        self.image_escalation = image_escalation
        self.model_id = model_id

    def generate_answer(
        self,
        query: str,
        context: StructuredContext,
        chat_history: list[dict] | None = None,
        system_prompt: str = "",
        ranked_results: list[RankedResult] | None = None,
        query_intent: QueryIntent | None = None,
    ) -> ReasoningResult:
        """Generate an answer using the assembled context.

        Orchestrates escalation, prompt formatting, LLM invocation, and
        result assembly. Never raises unhandled exceptions.

        Args:
            query: The user's original query.
            context: Structured context from ContextBuilder.
            chat_history: Optional conversation history for multi-turn.
            system_prompt: Optional system prompt for the LLM.
            ranked_results: Optional ranked results for escalation.
            query_intent: Optional query intent for escalation decisions.

        Returns:
            ReasoningResult with answer, sources, and escalation info.
        """
        try:
            return self._generate_answer_internal(
                query=query,
                context=context,
                chat_history=chat_history,
                system_prompt=system_prompt,
                ranked_results=ranked_results,
                query_intent=query_intent,
            )
        except Exception:
            logger.exception("Unhandled error in reasoning engine")
            return ReasoningResult(
                answer=FALLBACK_ANSWER,
                sources=[],
                escalation_used=False,
                image_analyses=[],
            )

    def _generate_answer_internal(
        self,
        query: str,
        context: StructuredContext,
        chat_history: list[dict] | None = None,
        system_prompt: str = "",
        ranked_results: list[RankedResult] | None = None,
        query_intent: QueryIntent | None = None,
    ) -> ReasoningResult:
        """Internal implementation of answer generation.

        Separated from generate_answer so the outer method can wrap all
        exceptions in a fallback response.
        """
        # Step 1: Image escalation (if required and available)
        escalation_result = self._handle_escalation(
            query=query,
            ranked_results=ranked_results or [],
            query_intent=query_intent,
        )

        # Step 2: Format context for prompt
        formatted_context = self._format_context_with_escalation(
            context=context,
            escalation_result=escalation_result,
        )

        # Step 3: Invoke Bedrock LLM
        answer = self._invoke_llm(
            query=query,
            formatted_context=formatted_context,
            chat_history=chat_history,
            system_prompt=system_prompt,
        )

        # Step 4: On LLM failure (fallback answer), return graceful fallback
        if answer == FALLBACK_ANSWER:
            return ReasoningResult(
                answer=FALLBACK_ANSWER,
                sources=[],
                escalation_used=False,
                image_analyses=[],
            )

        # Step 5: Extract sources from context
        sources = self._extract_sources(context)

        # Step 6: Return ReasoningResult
        return ReasoningResult(
            answer=answer,
            sources=sources,
            escalation_used=escalation_result.escalation_used,
            image_analyses=escalation_result.image_analyses,
        )

    def _handle_escalation(
        self,
        query: str,
        ranked_results: list[RankedResult],
        query_intent: QueryIntent | None,
    ) -> EscalationResult:
        """Handle image escalation if required by query intent.

        Args:
            query: The user's original query.
            ranked_results: Ranked results from retrieval layer.
            query_intent: Query intent with escalation flag.

        Returns:
            EscalationResult (escalation_used=False if not triggered or fails).
        """
        if (
            query_intent is not None
            and (query_intent.requires_escalation or query_intent.requires_image)
            and self.image_escalation is not None
        ):
            # Escalate if explicitly required OR if query needs image content
            try:
                return self.image_escalation.escalate(
                    ranked_results, query, query_intent=query_intent
                )
            except Exception:
                logger.exception("Image escalation failed, proceeding without")
                return EscalationResult(escalation_used=False, image_analyses=[])

        return EscalationResult(escalation_used=False, image_analyses=[])

    def _format_context_with_escalation(
        self,
        context: StructuredContext,
        escalation_result: EscalationResult,
    ) -> str:
        """Format context for prompt, injecting escalation results.

        Escalation analysis is injected after sibling expansion
        (already done in context) but before final prompt formatting.

        Args:
            context: Structured context already assembled.
            escalation_result: Results from image escalation (may be empty).

        Returns:
            Formatted prompt context string.
        """
        # Format the base context
        formatted = self.context_builder.format_for_prompt(context)

        # Inject escalation results if available
        if escalation_result.escalation_used and escalation_result.image_analyses:
            escalation_section = self._format_escalation_section(
                escalation_result.image_analyses
            )
            formatted = f"{formatted}\n\n{escalation_section}"

        return formatted

    def _format_escalation_section(
        self, image_analyses: list[ImageAnalysis]
    ) -> str:
        """Format image analyses into a prompt section.

        Args:
            image_analyses: List of ImageAnalysis results.

        Returns:
            Formatted escalation section string.
        """
        sections: list[str] = ["## Image Analysis"]
        for i, analysis in enumerate(image_analyses, 1):
            sections.append(
                f"\n### Image {i} ({analysis.image_s3_key})\n"
                f"Confidence: {analysis.confidence:.2f}\n"
                f"{analysis.analysis}"
            )
        return "\n".join(sections)

    def _invoke_llm(
        self,
        query: str,
        formatted_context: str,
        chat_history: list[dict] | None = None,
        system_prompt: str = "",
    ) -> str:
        """Invoke Bedrock LLM for answer generation.

        On failure, returns FALLBACK_ANSWER.

        Args:
            query: The user's original query.
            formatted_context: Formatted context string.
            chat_history: Optional conversation history.
            system_prompt: Optional system prompt.

        Returns:
            Generated answer string, or fallback on failure.
        """
        if self.bedrock_client is None:
            logger.warning("No bedrock_client configured, returning fallback")
            return FALLBACK_ANSWER

        try:
            messages = self._build_messages(
                query=query,
                formatted_context=formatted_context,
                chat_history=chat_history,
            )

            body = {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 4096,
                "messages": messages,
            }

            if system_prompt:
                body["system"] = system_prompt

            response = self.bedrock_client.invoke_model(
                modelId=self.model_id,
                contentType="application/json",
                accept="application/json",
                body=json.dumps(body),
            )

            response_body = json.loads(response["body"].read())
            answer = response_body["content"][0]["text"]

            logger.info(
                "LLM answer generated",
                extra={
                    "model_id": self.model_id,
                    "input_tokens": response_body.get("usage", {}).get(
                        "input_tokens", 0
                    ),
                    "output_tokens": response_body.get("usage", {}).get(
                        "output_tokens", 0
                    ),
                },
            )

            return answer

        except Exception:
            logger.exception(
                "LLM invocation failed", extra={"model_id": self.model_id}
            )
            return FALLBACK_ANSWER

    def _build_messages(
        self,
        query: str,
        formatted_context: str,
        chat_history: list[dict] | None = None,
    ) -> list[dict]:
        """Build the messages array for the Bedrock API call.

        Includes chat history if provided, followed by the current query
        with context.

        Args:
            query: The user's current query.
            formatted_context: Formatted context string.
            chat_history: Optional prior conversation turns.

        Returns:
            List of message dicts for the Bedrock API.
        """
        messages: list[dict] = []

        # Include chat history if provided
        if chat_history:
            for turn in chat_history:
                role = turn.get("role", "user")
                content = turn.get("content", "")
                if role in ("user", "assistant") and content:
                    messages.append({"role": role, "content": content})

        # Build the current user message with context
        user_message = (
            f"Use the following context to answer the question.\n\n"
            f"--- CONTEXT ---\n{formatted_context}\n--- END CONTEXT ---\n\n"
            f"Question: {query}"
        )

        messages.append({"role": "user", "content": user_message})

        return messages

    def _extract_sources(self, context: StructuredContext) -> list[str]:
        """Extract all retrieval_ids from the structured context.

        Collects retrieval_ids from all context elements (text, image,
        formula, table passages).

        Args:
            context: Structured context with categorized results.

        Returns:
            List of unique retrieval_ids.
        """
        sources: list[str] = []
        seen: set[str] = set()

        all_results = (
            context.text_passages
            + context.image_descriptions
            + context.formula_results
            + context.table_results
        )

        for result in all_results:
            if result.retrieval_id and result.retrieval_id not in seen:
                seen.add(result.retrieval_id)
                sources.append(result.retrieval_id)

        return sources
