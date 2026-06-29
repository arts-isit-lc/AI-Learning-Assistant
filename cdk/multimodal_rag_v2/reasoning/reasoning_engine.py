"""ReasoningEngine orchestrates the full reasoning flow.

Responsibilities:
- Query analysis → context building → escalation → answer generation
- Inject escalation results into context after sibling expansion, before final prompt formatting
- Handle LLM failure: return graceful fallback response
- Return ReasoningResult with answer, sources, escalation_used, image_analyses
"""

from __future__ import annotations

import json
import time
from typing import Any

from aws_lambda_powertools import Logger

from ..models.data_models import (
    ImageAnalysis,
    QueryIntent,
    RankedResult,
    ReasoningResult,
    StructuredContext,
)
from ..flags import RAG_RETURN_PASSAGES, STRICT_IMAGE_ESCALATION
from ..pricing import estimate_cost_usd
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

        # Store query_intent for use in formatting
        self._last_query_intent = query_intent

        # If escalation succeeded with a direct figure lookup, return the vision
        # analysis directly as the answer — bypasses the reasoning LLM which tends
        # to hallucinate "figure not found" despite having the analysis in context.
        if (
            escalation_result.escalation_used
            and escalation_result.image_analyses
            and query_intent is not None
            and hasattr(query_intent, "figure_reference")
            and query_intent.figure_reference is not None
        ):
            figure_ref = f"{query_intent.figure_reference.ref_type.title()} {query_intent.figure_reference.number}"
            vision_analysis = escalation_result.image_analyses[0].analysis
            answer = (
                f"Based on my visual analysis of {figure_ref}, here is what I can see:\n\n"
                f"{vision_analysis}"
            )
            sources = self._extract_sources(context)
            logger.info(
                "Returning vision analysis directly (bypassing reasoning LLM)",
                extra={"figure_ref": figure_ref, "answer_length": len(answer)},
            )
            return ReasoningResult(
                answer=answer,
                sources=sources,
                escalation_used=True,
                image_analyses=escalation_result.image_analyses,
            )

        # Step 2: Format context for prompt
        formatted_context = self._format_context_with_escalation(
            context=context,
            escalation_result=escalation_result,
        )

        # Step 3: Invoke Bedrock LLM — add system guidance when escalation was used
        effective_system_prompt = system_prompt
        if escalation_result.escalation_used and not system_prompt:
            effective_system_prompt = (
                "You are a helpful learning assistant. Answer the student's question based on the provided context. "
                "IMPORTANT: If a 'Visual Analysis of Referenced Figure' section is present in the context, "
                "it contains a detailed analysis of an image the student is asking about. "
                "Use that visual analysis to answer their question directly and specifically. "
                "Do NOT say the figure is not found if a visual analysis for it exists in the context."
            )

        if RAG_RETURN_PASSAGES:
            # #1 (eliminate double generation): skip the reasoning LLM call and
            # return the already-built formatted context as the "answer". The
            # downstream consumer (chatbot's Sonnet pass) generates the final
            # answer once from these passages, so we don't pay for a Haiku
            # generation that only becomes context for another generation.
            # Escalation/vision ran above, so its analysis is in the passages.
            logger.info(
                "RAG_RETURN_PASSAGES enabled: returning formatted passages, "
                "skipping reasoning LLM generation",
                extra={
                    "event": "passages_mode",
                    "passages_length": len(formatted_context),
                    "escalation_used": escalation_result.escalation_used,
                },
            )
            return ReasoningResult(
                answer=formatted_context,
                sources=self._extract_sources(context),
                escalation_used=escalation_result.escalation_used,
                image_analyses=escalation_result.image_analyses,
            )

        answer = self._invoke_llm(
            query=query,
            formatted_context=formatted_context,
            chat_history=chat_history,
            system_prompt=effective_system_prompt,
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
        if query_intent is None or self.image_escalation is None:
            return EscalationResult(escalation_used=False, image_analyses=[])

        # Escalate if explicitly required OR if the query needs image content.
        should_escalate = (
            query_intent.requires_escalation or query_intent.requires_image
        )
        if STRICT_IMAGE_ESCALATION:
            # Stricter gate (#9): only escalate on an explicit escalation flag
            # or a concrete figure reference — not on bare keyword matches
            # (figure/graph/chart/image/...), which over-trigger costly vision
            # calls. Reduces unnecessary Bedrock vision + S3 fetches.
            has_figure_ref = (
                getattr(query_intent, "figure_reference", None) is not None
            )
            should_escalate = query_intent.requires_escalation or has_figure_ref

        if should_escalate:
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

        # Inject escalation results if available — PREPEND so it's prioritized by the LLM
        if escalation_result.escalation_used and escalation_result.image_analyses:
            escalation_section = self._format_escalation_section(
                escalation_result.image_analyses,
                query_intent=getattr(self, '_last_query_intent', None),
            )
            formatted = f"{escalation_section}\n\n{formatted}"
            logger.info(
                "Escalation analysis injected into context",
                extra={
                    "base_context_length": len(formatted) - len(escalation_section) - 2,
                    "escalation_section_length": len(escalation_section),
                    "total_formatted_length": len(formatted),
                    "image_analyses_count": len(escalation_result.image_analyses),
                },
            )
        else:
            logger.info(
                "No escalation results to inject",
                extra={
                    "escalation_used": escalation_result.escalation_used,
                    "image_analyses_count": len(escalation_result.image_analyses) if escalation_result.image_analyses else 0,
                },
            )

        return formatted

    def _format_escalation_section(
        self, image_analyses: list[ImageAnalysis], query_intent=None
    ) -> str:
        """Format image analyses into a prompt section.

        Args:
            image_analyses: List of ImageAnalysis results.
            query_intent: Optional query intent with figure reference for labeling.

        Returns:
            Formatted escalation section string.
        """
        # Determine the figure label from query intent
        figure_label = ""
        if query_intent and hasattr(query_intent, "figure_reference") and query_intent.figure_reference:
            ref = query_intent.figure_reference
            figure_label = f"{ref.ref_type.title()} {ref.number}"

        sections: list[str] = ["## Visual Analysis of Referenced Figure"]
        for i, analysis in enumerate(image_analyses, 1):
            if figure_label:
                header = f"### {figure_label} (Visual Analysis)"
            else:
                header = f"### Image {i}"
            sections.append(
                f"\n{header}\n"
                f"The following is a detailed visual analysis of {figure_label or 'the referenced image'}:\n\n"
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

            # Log a preview of what's being sent to the LLM
            logger.info(
                "Invoking reasoning LLM",
                extra={
                    "formatted_context_length": len(formatted_context),
                    "context_preview": formatted_context[:300],
                    "has_system_prompt": bool(system_prompt),
                },
            )

            body = {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 4096,
                "messages": messages,
            }

            if system_prompt:
                body["system"] = system_prompt

            _t0 = time.perf_counter()
            response = self.bedrock_client.invoke_model(
                modelId=self.model_id,
                contentType="application/json",
                accept="application/json",
                body=json.dumps(body),
            )
            _latency_ms = round((time.perf_counter() - _t0) * 1000, 2)

            response_body = json.loads(response["body"].read())
            answer = response_body["content"][0]["text"]

            _usage = response_body.get("usage", {})
            _in_tok = _usage.get("input_tokens", 0)
            _out_tok = _usage.get("output_tokens", 0)
            logger.info(
                "LLM answer generated",
                extra={
                    "event": "bedrock_call",
                    "call": "reasoning",
                    "model_id": self.model_id,
                    "input_tokens": _in_tok,
                    "output_tokens": _out_tok,
                    "est_cost_usd": round(
                        estimate_cost_usd(self.model_id, _in_tok, _out_tok), 6
                    ),
                    "latency_ms": _latency_ms,
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
            f"CRITICAL: If a 'Visual Analysis of Referenced Figure' section appears in the context below, "
            f"it contains a detailed description from directly examining the actual image. "
            f"This IS the figure the student is asking about — use it to answer their question with specific details "
            f"about colors, labels, axes, data, and any visible elements.\n\n"
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
