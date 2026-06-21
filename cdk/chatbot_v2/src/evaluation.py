"""Evaluation data model for Chatbot V2.

Defines the EvaluationResult dataclass used to represent structured
assessment of student answers, including concept-level granularity.
"""

import json
import re
from dataclasses import dataclass, field

from aws_lambda_powertools import Logger

from constants.models import EVAL_MAX_TOKENS, EVAL_MODEL_ID

logger = Logger(service="chatbot-v2")


@dataclass
class EvaluationResult:
    """Structured result from the evaluation engine.

    Represents the assessment of a student's answer including correctness,
    confidence, and concept-level feedback for both demonstrated understanding
    and identified misunderstandings.

    Attributes:
        correct: Whether the answer is fully correct.
        partial: Whether the answer is partially correct.
        confidence: Confidence score from 0.0 to 1.0.
        concepts_demonstrated: Concepts the student showed understanding of.
        concepts_misunderstood: Concepts the student showed confusion about.
    """

    correct: bool = False
    partial: bool = True
    confidence: float = 0.5
    concepts_demonstrated: list[str] = field(default_factory=list)
    concepts_misunderstood: list[str] = field(default_factory=list)


DEFAULT_EVALUATION = EvaluationResult()
"""Default evaluation returned when the LLM call fails.

Used as a safe fallback that does not penalize the student — partial=True
with no demonstrated or misunderstood concepts means the interaction counts
but does not alter engagement score or concept progress.
"""


def parse_evaluation_response(response_text: str, module_concepts: list[str]) -> EvaluationResult:
    """Parse JSON evaluation response into EvaluationResult.

    Filters concepts not in the canonical module_concepts list.
    Returns DEFAULT_EVALUATION on any parse failure.

    Args:
        response_text: Raw JSON string from Claude 3 Haiku
        module_concepts: Canonical concept vocabulary for filtering

    Returns:
        EvaluationResult with only canonical concepts in demonstrated/misunderstood
    """
    try:
        # Strip markdown code fences if present (e.g. ```json ... ```)
        stripped = response_text.strip()
        fence_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", stripped, re.DOTALL)
        if fence_match:
            stripped = fence_match.group(1).strip()

        data = json.loads(stripped)

        correct = bool(data["correct"])
        partial = bool(data["partial"])
        confidence = float(data["confidence"])
        # Clamp confidence to [0.0, 1.0]
        confidence = max(0.0, min(1.0, confidence))

        raw_demonstrated = data["concepts_demonstrated"]
        raw_misunderstood = data["concepts_misunderstood"]

        # Filter to only canonical concepts
        concepts_demonstrated = [c for c in raw_demonstrated if c in module_concepts]
        concepts_misunderstood = [c for c in raw_misunderstood if c in module_concepts]

        return EvaluationResult(
            correct=correct,
            partial=partial,
            confidence=confidence,
            concepts_demonstrated=concepts_demonstrated,
            concepts_misunderstood=concepts_misunderstood,
        )
    except (json.JSONDecodeError, KeyError, TypeError, ValueError, AttributeError):
        return DEFAULT_EVALUATION


EVALUATION_PROMPT = """Evaluate this student answer against the learning objective.

Topic: {topic}
Stage: {stage}
Question asked: {last_ai_question}
Student answer: {student_answer}
Key concepts from retrieval: {concepts}
Module concept vocabulary: {module_concepts}

Return ONLY valid JSON:
{{
  "correct": true/false,
  "partial": true/false,
  "confidence": 0.0-1.0,
  "concepts_demonstrated": ["concept_a", "concept_b"],
  "concepts_misunderstood": ["concept_c"]
}}

Rules:
- concepts_demonstrated: concepts the student showed clear understanding of
- concepts_misunderstood: concepts the student showed confusion about
- A partially correct answer can have both demonstrated and misunderstood concepts
- IMPORTANT: concepts_demonstrated and concepts_misunderstood MUST only contain identifiers from the module concept vocabulary list above. Discard any concept not in that list.
"""


def evaluate_answer(
    bedrock_client,
    topic: str,
    stage: str,
    last_ai_question: str,
    student_answer: str,
    concepts: str,
    module_concepts: list[str],
) -> EvaluationResult:
    """Invoke Claude 3 Haiku for structured evaluation.

    Sends a structured prompt to the evaluation model asking it to assess the
    student's answer against the learning objective and canonical concept list.
    Returns DEFAULT_EVALUATION on any failure.

    Args:
        bedrock_client: Boto3 Bedrock Runtime client.
        topic: The current learning topic.
        stage: The current learning stage (e.g. prior_knowledge, comprehension).
        last_ai_question: The previous AI question the student is responding to.
        student_answer: The student's answer text.
        concepts: Key concepts from RAG retrieval context.
        module_concepts: Canonical concept vocabulary for the module.

    Returns:
        EvaluationResult with concepts filtered to canonical vocabulary.
    """
    try:
        prompt_text = EVALUATION_PROMPT.format(
            topic=topic,
            stage=stage,
            last_ai_question=last_ai_question,
            student_answer=student_answer,
            concepts=concepts,
            module_concepts=json.dumps(module_concepts),
        )

        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": EVAL_MAX_TOKENS,
            "messages": [{"role": "user", "content": prompt_text}],
        })

        response = bedrock_client.invoke_model(
            modelId=EVAL_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=body,
        )

        response_body = json.loads(response["body"].read())
        response_text = response_body["content"][0]["text"]

        return parse_evaluation_response(response_text, module_concepts)
    except Exception:
        logger.exception("Evaluation engine Bedrock call failed")
        return DEFAULT_EVALUATION
