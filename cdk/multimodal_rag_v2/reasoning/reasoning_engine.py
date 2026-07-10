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
    ResolutionConfidence,
    StructuredComparison,
    StructuredContext,
    TableComparisonFacts,
    VisionAnalysis,
)
from ..flags import RAG_RETURN_PASSAGES, STRICT_IMAGE_ESCALATION
from ..pricing import estimate_cost_usd
from .context_builder import ContextBuilder
from .image_escalation import EscalationResult, ImageEscalation

logger = Logger(service="multimodal-rag-reasoning")

# Default model for answer generation (Claude Haiku 4.5 via Geo-US CRIS)
DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

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
        comparison_engine: Any = None,
    ) -> None:
        """Initialize ReasoningEngine with dependencies.

        Args:
            bedrock_client: Boto3 Bedrock Runtime client for LLM invocation.
            context_builder: ContextBuilder for formatting context into prompts.
            image_escalation: ImageEscalation for vision LLM analysis of images.
            model_id: Bedrock model ID for answer generation.
            comparison_engine: ComparisonEngine for deterministic structured
                (table-native) comparison. When None, the comparison path is
                skipped and behavior is unchanged.
        """
        self.bedrock_client = bedrock_client
        self.context_builder = context_builder or ContextBuilder()
        self.image_escalation = image_escalation
        self.model_id = model_id
        self.comparison_engine = comparison_engine

    def generate_answer(
        self,
        query: str,
        context: StructuredContext,
        chat_history: list[dict] | None = None,
        system_prompt: str = "",
        ranked_results: list[RankedResult] | None = None,
        query_intent: QueryIntent | None = None,
        scope_filter: dict | None = None,
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
            scope_filter: Optional file/module scope (same dict the retrieval
                search used) so escalation DB lookups stay within scope.

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
                scope_filter=scope_filter,
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
        scope_filter: dict | None = None,
    ) -> ReasoningResult:
        """Internal implementation of answer generation.

        Separated from generate_answer so the outer method can wrap all
        exceptions in a fallback response.
        """
        # Step 0: Structured comparison (table-native) — deterministic, no Bedrock
        # call. Takes precedence over image escalation for a table-comparison
        # query (which ALSO sets requires_image/requires_multi_image). If nothing
        # resolves we fall through to normal escalation (today's behavior).
        structured_comparison = self._handle_structured_comparison(
            ranked_results=ranked_results or [],
            query_intent=query_intent,
            scope_filter=scope_filter,
        )

        # Step 1: Image escalation — skipped when a structured comparison resolved
        # (the comparison replaces the vision path for this query).
        if structured_comparison is not None:
            escalation_result = EscalationResult(escalation_used=False, image_analyses=[])
        else:
            escalation_result = self._handle_escalation(
                query=query,
                ranked_results=ranked_results or [],
                query_intent=query_intent,
                scope_filter=scope_filter,
            )

        # Store query_intent for use in formatting
        self._last_query_intent = query_intent

        # If escalation succeeded with a direct figure lookup, return the vision
        # analysis directly as the answer — bypasses the reasoning LLM which tends
        # to hallucinate "figure not found" despite having the analysis in context.
        if (
            escalation_result.escalation_used
            and escalation_result.image_analyses
            and escalation_result.vision_analysis is None  # not the multi-image path
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
            structured_comparison=structured_comparison,
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
                vision_analysis=escalation_result.vision_analysis,
                structured_comparison=structured_comparison,
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
            vision_analysis=escalation_result.vision_analysis,
            structured_comparison=structured_comparison,
        )

    def _handle_escalation(
        self,
        query: str,
        ranked_results: list[RankedResult],
        query_intent: QueryIntent | None,
        scope_filter: dict | None = None,
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
                    ranked_results, query, query_intent=query_intent,
                    scope_filter=scope_filter,
                )
            except Exception:
                logger.exception("Image escalation failed, proceeding without")
                return EscalationResult(escalation_used=False, image_analyses=[])

        return EscalationResult(escalation_used=False, image_analyses=[])

    def _handle_structured_comparison(
        self,
        ranked_results: list[RankedResult],
        query_intent: QueryIntent | None,
        scope_filter: dict | None = None,
    ) -> StructuredComparison | None:
        """Run the deterministic structured (table) comparison if requested.

        Returns a StructuredComparison when the query is a table comparison and
        at least one referent resolved; otherwise None (caller falls back to the
        normal escalation path). Never raises.
        """
        if query_intent is None or self.comparison_engine is None:
            return None
        if not getattr(query_intent, "requires_table_comparison", False):
            return None
        try:
            return self.comparison_engine.compare(
                query_intent, ranked_results, scope_filter
            )
        except Exception:
            logger.exception("Structured comparison failed, proceeding without")
            return None

    def _format_context_with_escalation(
        self,
        context: StructuredContext,
        escalation_result: EscalationResult,
        structured_comparison: StructuredComparison | None = None,
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

        # Structured comparison (table-native) takes precedence and PREPENDS its
        # deterministic facts. For a comparison query the escalation result is
        # empty (the vision path was skipped), so the escalation branches below
        # do not fire.
        if structured_comparison is not None:
            comparison_section = self._format_comparison_section(
                structured_comparison,
                query_intent=getattr(self, "_last_query_intent", None),
            )
            formatted = f"{comparison_section}\n\n{formatted}"
            logger.info(
                "Structured comparison injected into context",
                extra={
                    "comparison_type": structured_comparison.comparison_type.value,
                    "intent": structured_comparison.intent.value,
                    "referents_resolved": len(structured_comparison.referents),
                    "comparison_section_length": len(comparison_section),
                },
            )
            return formatted

        # Inject escalation results if available — PREPEND so it's prioritized by the LLM.
        # Multi-image (MULTI) takes precedence: one comparison/description over >= 2
        # figures. The SINGLE-image section is unchanged.
        if escalation_result.vision_analysis is not None:
            escalation_section = self._format_multi_image_section(
                escalation_result.vision_analysis,
                query_intent=getattr(self, "_last_query_intent", None),
            )
            formatted = f"{escalation_section}\n\n{formatted}"
            logger.info(
                "Multi-image analysis injected into context",
                extra={
                    "escalation_section_length": len(escalation_section),
                    "prompt_intent": escalation_result.vision_analysis.prompt_intent,
                    "figures_resolved": len(escalation_result.vision_analysis.reference_mapping),
                },
            )
        elif escalation_result.escalation_used and escalation_result.image_analyses:
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

    def _format_multi_image_section(
        self, vision_analysis: VisionAnalysis, query_intent=None
    ) -> str:
        """Format a MULTI vision analysis into a prompt section (T5).

        Labels every resolved figure, uses a comparison vs. analysis heading, notes
        any requested figure that could not be located, and adds a hedge when a
        figure was resolved with LOW confidence — so the final answer can qualify
        itself rather than confidently discussing the wrong image.
        """
        mapping = vision_analysis.reference_mapping
        resolved_labels = [rr.reference for rr in mapping]
        is_compare = vision_analysis.prompt_intent == "compare"

        heading = "Visual Comparison of " if is_compare else "Visual Analysis of "
        lines: list[str] = [f"## {heading}{self._join_labels(resolved_labels)}", ""]

        if query_intent is not None:
            requested = [
                f"{r.ref_type.title()} {r.number}"
                for r in (getattr(query_intent, "figure_references", None) or [])
            ]
            missing = [label for label in requested if label not in resolved_labels]
            if missing:
                lines.append(
                    f"Note: {self._join_labels(missing)} could not be located in the "
                    f"available course materials, so the analysis below covers only "
                    f"{self._join_labels(resolved_labels)}."
                )
                lines.append("")

        if any(rr.confidence == ResolutionConfidence.LOW for rr in mapping):
            lines.append(
                "Note: one or more of these figures could not be identified with certainty "
                "(multiple figures in scope share that number). If the wrong figure appears, "
                "invite the student to confirm which figure they meant."
            )
            lines.append("")

        lines.append(vision_analysis.analysis)
        return "\n".join(lines)

    @staticmethod
    def _join_labels(labels: list[str]) -> str:
        """Join figure labels into a readable phrase ("A", "A and B", "A, B and C")."""
        if not labels:
            return "the referenced figures"
        if len(labels) == 1:
            return labels[0]
        return ", ".join(labels[:-1]) + " and " + labels[-1]

    def _format_comparison_section(
        self, structured_comparison: StructuredComparison, query_intent=None
    ) -> str:
        """Format a StructuredComparison into a grounding section (table-native).

        Renders the deterministic facts as ground truth, labels each referent,
        notes any requested table that could not be located, and hedges when a
        referent resolved with LOW confidence. The final generator writes the
        prose from THIS — it must not recompute or invent cells.
        """
        sc = structured_comparison
        labels = [r.reference for r in sc.referents]
        lines: list[str] = [f"## Structured comparison of {self._join_labels(labels)}", ""]

        if query_intent is not None:
            requested = [
                f"{r.ref_type.title()} {r.number}"
                for r in (getattr(query_intent, "figure_references", None) or [])
                if r.ref_type == "table"
            ]
            missing = [label for label in requested if label not in labels]
            if missing:
                lines.append(
                    f"Note: {self._join_labels(missing)} could not be located in the "
                    f"available course materials, so the comparison below covers only "
                    f"{self._join_labels(labels)}."
                )
                lines.append("")

        if any(r.confidence == ResolutionConfidence.LOW for r in sc.referents):
            lines.append(
                "Note: one or more of these tables could not be identified with certainty "
                "(multiple tables in scope share that number). If the wrong table appears, "
                "invite the student to confirm which one they meant."
            )
            lines.append("")

        lines.append(
            "Verified facts (computed deterministically — treat as ground truth; "
            "do not recompute or invent cells):"
        )
        facts = sc.facts
        if isinstance(facts, TableComparisonFacts):
            for shape in facts.per_referent:
                cols = ", ".join(shape.columns) if shape.columns else "no columns detected"
                lines.append(
                    f"- {shape.label}: {shape.n_rows} rows x {shape.n_cols} columns [{cols}]"
                )
            lines.append(
                f"- Shared columns: "
                f"{', '.join(facts.shared_columns) if facts.shared_columns else 'none'}"
            )
            for label, cols in facts.unique_columns.items():
                if cols:
                    lines.append(f"- Only in {label}: {', '.join(cols)}")
            ra = facts.row_alignment
            if ra is not None:
                unaligned = ", ".join(f"{k}: {v}" for k, v in ra.unaligned_by_label.items())
                lines.append(
                    f"- Row alignment on {', '.join(ra.key_columns)}: "
                    f"{ra.aligned_rows} shared key(s); {len(ra.differing_cells)} differing cell(s)"
                    + (f"; unaligned rows -> {unaligned}" if unaligned else "")
                )
                for d in ra.differing_cells[:10]:
                    vals = "; ".join(f"{lbl}={val}" for lbl, val in d["values_by_label"].items())
                    lines.append(f"    - {d['column']} @ {ra.key_columns[0]}={d['key']}: {vals}")
            else:
                lines.append(
                    "- Row-level alignment: not available (no shared key column); "
                    "compared on schema/shape only."
                )

        lines.append("")
        lines.append(
            "Both tables are shown to the student below. Write a direct comparison grounded "
            "ONLY in these facts and the table data. Do NOT invent cells or columns. If a "
            "table is missing or low-confidence, say so rather than guessing."
        )
        return "\n".join(lines)

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
