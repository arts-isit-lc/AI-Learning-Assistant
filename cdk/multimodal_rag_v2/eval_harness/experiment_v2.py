"""Step 0 v2 experiment additions (see findings.md "Step 0 — v2 iteration").

Adds, on top of experiment.py:
- a failure taxonomy + a judge that classifies each miss,
- auto question generation across hard categories,
- a reuse-friendly answer-arm builder (perception is provided, so query-agnostic
  perception can be computed once per figure and reused),
- a deliberately SIMPLE hybrid arm E: the answer self-reports uncertainty; if it
  flags uncertainty we escalate to live perception and re-answer, recording
  whether escalation actually changed the answer. This is NOT a confidence
  estimator — the self-report is an inspectable signal, kept separate so a poor
  E result doesn't confound "stored perception failed" with "the heuristic failed".

All pure/injected — no Bedrock/S3. run_step0_v2.py wires the real clients.
"""
from __future__ import annotations

import re
import time
from typing import Callable

from .experiment import (
    ANSWER_SYSTEM_REVISED,
    _clamp01,
    build_answer_user_prompt,
    extract_json,
)
from .figure_dataset import FigureEvalItem
from .scoring import ArmOutput, BedrockCall, JudgeFn, JudgeScore

# ─── Question categories (attack the hypothesis on hard types) ────────────────
# NOTE: in this single-image offline proxy "comparison" is intra-figure (compare
# two elements WITHIN one figure). True cross-figure comparison needs the
# multi-image / full-pipeline setup and is out of scope for the proxy.
QUESTION_CATEGORIES: list[tuple[str, str]] = [
    ("overview", "a broad 'what does this figure show' question"),
    ("label_lookup", "a question requiring reading a SPECIFIC label, axis name, or legend entry"),
    ("relationship", "a question about a relationship shown (an arrow, a flow, what follows what, a hierarchy)"),
    ("chart", "a question requiring reading a value, a trend, or a comparison from the chart/graph"),
    ("comparison", "a question comparing two elements WITHIN this figure"),
]
CATEGORY_NAMES = [name for name, _ in QUESTION_CATEGORIES]

# ─── Track B: transcription-forced perception + label-lookup questions ────────
# Sharper than perception_prompt_rich: leads with EXHAUSTIVE verbatim
# transcription (the v2 pilot's failure mode was hallucinated labels, so we force
# a complete text dump and forbid guessing). Query-independent.
PERCEPTION_PROMPT_TRANSCRIPTION = (
    "Transcribe and describe this figure for later question answering.\n"
    "First, under a heading 'TRANSCRIPTION:', list EVERY piece of visible text EXACTLY as written — "
    "title, axis labels and units, tick values, legend entries, data labels, callouts, annotations, "
    "and any text inside the figure — one item per line. Transcribe verbatim; if a piece of text is "
    "unreadable, write '[illegible]' rather than guessing.\n"
    "Then, under 'DESCRIPTION:', give a summary, the objects, relationships, any equations, and the "
    "concepts illustrated. Do NOT answer any question."
)


def build_label_question_gen_prompt(n: int) -> str:
    return (
        f"Look at this figure. Generate {n} DISTINCT questions that each require reading a SPECIFIC "
        "piece of text from the figure — an axis label, a legend entry, a tick value, a data label, "
        "or an annotation — and each having a short, unambiguous answer readable directly from the "
        'figure. Return ONLY a JSON array of objects: [{"question": "...", "answer": "..."}]. '
        "The answer must be the exact text as it appears in the figure."
    )


def parse_label_questions(text: str) -> list[tuple[str, str]]:
    """Parse [{question, answer}, ...] into (question, expected_answer) pairs."""
    obj = extract_json(text)
    if not isinstance(obj, list):
        raise ValueError("label-question response was not a JSON array")
    out: list[tuple[str, str]] = []
    for entry in obj:
        if not isinstance(entry, dict):
            continue
        q = str(entry.get("question", "")).strip()
        a = str(entry.get("answer", "")).strip()
        if q and a:
            out.append((q, a))
    return out


# ─── Failure taxonomy ─────────────────────────────────────────────────────────
FAILURE_CATEGORIES = [
    "none",
    "wrong_figure",
    "ocr_error",
    "missed_relationship",
    "hallucinated_object",
    "missed_equation",
    "prompt_misunderstanding",
    "retrieval_failure",
    "other",
]


# ─── Auto question generation ─────────────────────────────────────────────────
def build_question_gen_prompt() -> str:
    cats = "\n".join(f'- "{name}": {desc}' for name, desc in QUESTION_CATEGORIES)
    return (
        "Look at this figure. Generate ONE natural student question for EACH category below, "
        "each answerable from THIS figure alone. Return ONLY a JSON object mapping category name "
        f"to the question string.\n\nCategories:\n{cats}"
    )


def parse_question_gen_response(text: str) -> dict[str, str]:
    obj = extract_json(text)
    if not isinstance(obj, dict):
        raise ValueError("question-gen response was not a JSON object")
    out = {str(k): str(v).strip() for k, v in obj.items() if str(v).strip()}
    return {k: v for k, v in out.items() if k in CATEGORY_NAMES}


# ─── Judge with failure taxonomy ──────────────────────────────────────────────
def build_judge_prompt_v2(query: str, answer: str, facts: list[str]) -> str:
    facts_block = "\n".join(f"- {f}" for f in facts) if facts else "(no reference facts provided)"
    cats = ", ".join(FAILURE_CATEGORIES)
    return (
        "You are grading a tutor's answer about a figure against a reference answer key.\n\n"
        f"Reference facts (ground truth about the figure):\n{facts_block}\n\n"
        f"Question: {query}\n"
        f"Answer to grade: {answer}\n\n"
        "Return ONLY JSON with these fields:\n"
        '{"correctness": <0..1 fraction of RELEVANT reference facts the answer conveys correctly>, '
        '"hallucination": <0..1 degree to which the answer states things NOT supported by the facts>, '
        f'"failure_category": <one of: {cats}; use "none" if the answer is fully correct>, '
        '"rationale": "<one sentence>"}'
    )


def parse_judge_response_v2(text: str) -> JudgeScore:
    obj = extract_json(text)
    fc = str(obj.get("failure_category", "")).strip().lower()
    if fc and fc not in FAILURE_CATEGORIES:
        fc = "other"
    return JudgeScore(
        correctness=_clamp01(obj.get("correctness")),
        hallucination=_clamp01(obj.get("hallucination")),
        rationale=str(obj.get("rationale", "")),
        failure_category=fc,
    )


def make_text_judge_v2(invoke: Callable[[str], str]) -> JudgeFn:
    def judge(query: str, answer: str, facts: list[str]) -> JudgeScore:
        try:
            return parse_judge_response_v2(invoke(build_judge_prompt_v2(query, answer, facts)))
        except Exception as exc:  # noqa: BLE001
            return JudgeScore(0.0, 0.0, f"judge parse failed: {exc}", "other")

    return judge


# ─── Uncertainty self-report (for arm E) ──────────────────────────────────────
ANSWER_SYSTEM_UNCERTAINTY = ANSWER_SYSTEM_REVISED + (
    "\n\nAfter your answer, on a final separate line write exactly: "
    "'UNCERTAINTY: yes' or 'UNCERTAINTY: no', followed by ' - <brief reason>'. "
    "Say 'yes' ONLY if the figure description was insufficient to answer confidently."
)

_UNCERTAINTY_RE = re.compile(r"(?im)^\s*UNCERTAINTY:\s*(yes|no)\b(.*)$")


def parse_uncertainty(answer_text: str) -> tuple[str, bool, str]:
    """Split the trailing 'UNCERTAINTY: yes|no - reason' marker from the answer.

    Returns (clean_answer, is_uncertain, reason). If no marker, (text, False, "").
    """
    match = _UNCERTAINTY_RE.search(answer_text)
    if not match:
        return answer_text.strip(), False, ""
    is_uncertain = match.group(1).lower() == "yes"
    reason = match.group(2).lstrip(" -–—:").strip()
    clean = answer_text[: match.start()].strip()
    return clean, is_uncertain, reason


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


# ─── Reuse-friendly arm builders ──────────────────────────────────────────────
# A perception provider yields (perception_text, calls_made). For query-agnostic
# arms (B/C/D) it returns a precomputed string and NO calls; for the live arm (A)
# it performs a query-aware vision call per item.
PerceptionProvider = Callable[[FigureEvalItem], tuple[str, list[BedrockCall]]]
AnswerOp = Callable[[str, str], tuple[str, BedrockCall]]


def build_answer_arm(
    perception_provider: PerceptionProvider,
    answer_system: str,
    answer_op: AnswerOp,
    *,
    clock: Callable[[], float] | None = None,
) -> Callable[[FigureEvalItem], ArmOutput]:
    now = clock or time.perf_counter

    def arm(item: FigureEvalItem) -> ArmOutput:
        t0 = now()
        perception_text, pcalls = perception_provider(item)
        answer_text, acall = answer_op(answer_system, build_answer_user_prompt(item.query, perception_text))
        return ArmOutput(
            query=item.query, answer=answer_text, source_ids=[],
            latency_ms=round((now() - t0) * 1000, 2), calls=[*pcalls, acall],
        )

    return arm


def build_hybrid_arm_e(
    stored_provider: PerceptionProvider,
    live_provider: PerceptionProvider,
    answer_op: AnswerOp,
    *,
    clock: Callable[[], float] | None = None,
) -> Callable[[FigureEvalItem], ArmOutput]:
    """Arm E: answer from stored perception with a self-reported uncertainty flag;
    if uncertain, escalate to live perception and re-answer. Records `escalated`
    and whether the escalation `answer_changed` (agreement-rate signal)."""
    now = clock or time.perf_counter

    def arm(item: FigureEvalItem) -> ArmOutput:
        t0 = now()
        stored_text, pcalls = stored_provider(item)
        raw, a1 = answer_op(ANSWER_SYSTEM_UNCERTAINTY, build_answer_user_prompt(item.query, stored_text))
        stored_answer, uncertain, _reason = parse_uncertainty(raw)
        calls = [*pcalls, a1]

        if not uncertain:
            return ArmOutput(query=item.query, answer=stored_answer, source_ids=[],
                             latency_ms=round((now() - t0) * 1000, 2), calls=calls,
                             escalated=False, answer_changed=False)

        live_text, lpcalls = live_provider(item)
        raw2, a2 = answer_op(ANSWER_SYSTEM_REVISED, build_answer_user_prompt(item.query, live_text))
        live_answer, _u2, _r2 = parse_uncertainty(raw2)
        calls += [*lpcalls, a2]
        return ArmOutput(query=item.query, answer=live_answer, source_ids=[],
                         latency_ms=round((now() - t0) * 1000, 2), calls=calls,
                         escalated=True, answer_changed=_normalize(live_answer) != _normalize(stored_answer))

    return arm
