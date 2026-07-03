"""Step 0 offline experiment: arm builders, judge, and reference-fact prompts.

This is the OFFLINE PROXY of the A/B/C/D comparison (see
.kiro/specs/chatbot-latency-optimization/findings.md). Each arm produces figure
"perception" directly from the image via a Bedrock vision call with a different
prompt, then answers with Sonnet — it does NOT run the production retrieval
pipeline, so it isolates the *perception-quality* question (does a rich,
query-independent description let the answerer do as well as a live,
query-aware vision call?), which is the main uncertainty.

Everything here is client-agnostic: the Bedrock/S3 operations are injected as
callables (`ArmOps`, judge `invoke`), so prompt-building, response parsing, and
arm assembly are unit-testable without AWS. The real boto3 wiring lives in
run_step0.py.

Caveats baked into interpretation (not code): arms are a proxy (no retrieval);
reference facts are model-bootstrapped (SME-reviewable, not authoritative);
runtime latency for B/C/D is NOT representative here because their perception
would be precomputed at ingestion in production.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from .figure_dataset import FigureEvalItem
from .scoring import ArmOutput, BedrockCall, JudgeFn, JudgeScore

# ─── Perception prompts (one per arm) ─────────────────────────────────────────

# Arm A — proxy for the current runtime escalation: query-AWARE vision prompt,
# mirroring reasoning/image_escalation.py::_invoke_vision_llm.
def perception_prompt_a(item: FigureEvalItem) -> str:
    return (
        f"Analyze this image in the context of the following question: {item.query}\n\n"
        "Provide a detailed description of what this image shows and how it relates to the "
        "question. Include any relevant labels, data points, or concepts visible in the image."
    )


# Arm B — proxy for the current ingestion description: short, query-INDEPENDENT,
# mirroring enrichment/vision_service.py's 1-3 sentence image_description.
def perception_prompt_b(item: FigureEvalItem) -> str:
    return "Describe this image in 1-3 sentences: its type and what it shows. Be concise."


# Arms C & D — the proposed rich, query-INDEPENDENT perception (the perception
# schema): the same description feeds both; D differs only in the answer prompt.
def perception_prompt_rich(item: FigureEvalItem) -> str:
    return (
        "Produce a complete, query-independent description of this image for later question "
        "answering. Include: a detailed summary; ALL visible text transcribed verbatim (labels, "
        "axis names, legends, callouts, annotations); objects depicted; relationships (arrows, "
        "flows, hierarchy); any equations; and the concepts illustrated. Describe only what is "
        "visible — do NOT answer any question."
    )


# ─── Answer prompts ───────────────────────────────────────────────────────────

# A/B/C share the baseline answer prompt; D gets a revised prompt that tells the
# model how to exploit the structured description (isolates "stored info" vs
# "how the model is instructed to use it").
ANSWER_SYSTEM_BASELINE = (
    "You are a course tutor. Use the provided figure description to answer the student's question "
    "accurately and concisely. If the description does not contain the answer, say you cannot "
    "determine it from the figure. Do not invent details that are not in the description."
)

ANSWER_SYSTEM_REVISED = (
    "You are a course tutor answering a question about a figure. You are given a structured "
    "description of the figure (summary, transcribed text/labels, objects, relationships, "
    "equations, concepts). Ground every claim in that description and quote specific labels or "
    "values when relevant. If the needed detail is absent from the description, say so explicitly "
    "rather than guessing. Answer concisely and directly."
)


def build_answer_user_prompt(query: str, perception_text: str) -> str:
    return f"Figure description:\n{perception_text}\n\nStudent question: {query}\n\nAnswer:"


# ─── Reference-fact (ground-truth bootstrap) + judge prompts ──────────────────

FACTS_PROMPT = (
    "You are building an answer key for questions about this figure. List the key factual claims "
    "that are VISIBLE in the figure as a JSON array of short strings — include labels, axis names, "
    "data points/values, relationships, and what the figure depicts. State only what is visible; be "
    "exhaustive but do not speculate. Return ONLY the JSON array."
)


def build_judge_prompt(query: str, answer: str, facts: list[str]) -> str:
    facts_block = "\n".join(f"- {f}" for f in facts) if facts else "(no reference facts provided)"
    return (
        "You are grading a tutor's answer about a figure against a reference answer key.\n\n"
        f"Reference facts (ground truth about the figure):\n{facts_block}\n\n"
        f"Question: {query}\n"
        f"Answer to grade: {answer}\n\n"
        "Return ONLY JSON with these fields:\n"
        '{"correctness": <0..1 fraction of RELEVANT reference facts the answer conveys correctly>, '
        '"hallucination": <0..1 degree to which the answer states things NOT supported by the '
        'reference facts>, "rationale": "<one sentence>"}'
    )


# ─── Response parsing ─────────────────────────────────────────────────────────

def _clamp01(value: Any) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def extract_json(text: str) -> Any:
    """Parse JSON from a Claude text response, tolerating ```json fences and
    surrounding prose (grabs the first {...} or [...] block)."""
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.split("\n")
        stripped = "\n".join(lines[1:-1]).strip() if len(lines) >= 3 else stripped.strip("`")
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    # Fallback: first balanced-looking object/array by bracket search.
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        start = stripped.find(open_ch)
        end = stripped.rfind(close_ch)
        if start != -1 and end > start:
            return json.loads(stripped[start : end + 1])
    raise ValueError("no JSON found in response")


def parse_facts_response(text: str) -> list[str]:
    obj = extract_json(text)
    if not isinstance(obj, list):
        raise ValueError("facts response was not a JSON array")
    return [str(x).strip() for x in obj if str(x).strip()]


def parse_judge_response(text: str) -> JudgeScore:
    obj = extract_json(text)
    return JudgeScore(
        correctness=_clamp01(obj.get("correctness")),
        hallucination=_clamp01(obj.get("hallucination")),
        rationale=str(obj.get("rationale", "")),
    )


def detect_media_type(image_bytes: bytes) -> str:
    """Bedrock-supported media type from magic bytes (defaults to image/png)."""
    if image_bytes[:8].startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_bytes[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if image_bytes[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


# ─── Arm assembly (injected ops) ──────────────────────────────────────────────

@dataclass
class ArmOps:
    """Injected side-effecting operations, so build_arm stays testable.

    fetch_image: image_s3_key -> (bytes, media_type)
    perceive:    (image_bytes, media_type, prompt) -> (analysis_text, BedrockCall)
    answer:      (system_prompt, user_prompt) -> (answer_text, BedrockCall)
    """

    fetch_image: Callable[[str], tuple[bytes, str]]
    perceive: Callable[[bytes, str, str], tuple[str, BedrockCall]]
    answer: Callable[[str, str], tuple[str, BedrockCall]]


def build_arm(
    perception_prompt_fn: Callable[[FigureEvalItem], str],
    answer_system_prompt: str,
    ops: ArmOps,
    *,
    clock: Callable[[], float] | None = None,
) -> Callable[[FigureEvalItem], ArmOutput]:
    """Assemble an arm: fetch image -> perceive (per-arm prompt) -> answer.

    Returns an Arm callable (FigureEvalItem -> ArmOutput) with both Bedrock calls
    recorded for token/cost accounting. `source_ids` is left empty: the offline
    proxy has no retrieval step, so retrieval precision is not exercised here.
    """
    import time

    now = clock or time.perf_counter

    def arm(item: FigureEvalItem) -> ArmOutput:
        t0 = now()
        image_bytes, media_type = ops.fetch_image(item.image_s3_key)
        perception_text, perceive_call = ops.perceive(
            image_bytes, media_type, perception_prompt_fn(item)
        )
        answer_text, answer_call = ops.answer(
            answer_system_prompt, build_answer_user_prompt(item.query, perception_text)
        )
        return ArmOutput(
            query=item.query,
            answer=answer_text,
            source_ids=[],
            latency_ms=round((now() - t0) * 1000, 2),
            calls=[perceive_call, answer_call],
        )

    return arm


def make_text_judge(invoke: Callable[[str], str]) -> JudgeFn:
    """Wrap a text-completion `invoke(prompt) -> str` into a JudgeFn.

    An unparseable judge response scores 0/0 with a rationale, so one bad grade
    never aborts a run (matches the harness's log-and-continue posture).
    """

    def judge(query: str, answer: str, facts: list[str]) -> JudgeScore:
        try:
            return parse_judge_response(invoke(build_judge_prompt(query, answer, facts)))
        except Exception as exc:  # noqa: BLE001
            return JudgeScore(correctness=0.0, hallucination=0.0, rationale=f"judge parse failed: {exc}")

    return judge
