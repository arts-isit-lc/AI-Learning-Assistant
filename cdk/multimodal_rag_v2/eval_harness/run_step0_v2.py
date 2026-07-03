"""CLI: run the Step 0 v2 offline evaluation against dev (S3 + Bedrock).

Usage (from cdk/, with dev credentials in the environment):
    AWS_PROFILE=... PYTHONPATH=. python3 -m multimodal_rag_v2.eval_harness.run_step0_v2 --n 6

Per figure: auto-generate one question per hard category (Sonnet vision),
bootstrap reference facts (Sonnet vision), and compute query-agnostic perception
ONCE (short + rich, Haiku). Then run arms A/B/C/D/E — reusing the per-figure
perception so only A (and E's escalation) re-perceive per question — grade with a
HAIKU judge (different model from the Sonnet fact-generator), and print the
per-category matrix (the primary output) plus arm-E escalation/agreement stats.

Still an OFFLINE PROXY with model-bootstrapped, unreviewed questions/facts —
directional, pending SME question review + judge calibration (see findings.md).
Pure logic is covered by test_experiment*.py; this entrypoint is validated by
running it.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import boto3

from .experiment import (
    ANSWER_SYSTEM_BASELINE,
    ANSWER_SYSTEM_REVISED,
    FACTS_PROMPT,
    detect_media_type,
    parse_facts_response,
    perception_prompt_a,
    perception_prompt_b,
    perception_prompt_rich,
)
from .experiment_v2 import (
    build_answer_arm,
    build_hybrid_arm_e,
    build_question_gen_prompt,
    make_text_judge_v2,
    parse_question_gen_response,
)
from .figure_dataset import FigureEvalItem
from .report import escalation_stats, format_category_matrix, format_report, summarize
from .run_step0 import HAIKU, SONNET, DEFAULT_BUCKET, _bedrock_text, _bedrock_vision, _sample_image_keys
from .runner import ArmRun
from .scoring import score_item


def _precompute_figure(br, raw: bytes, media_type: str) -> dict:
    """Per-figure, query-independent precompute: category questions, reference
    facts, and short+rich perception (Haiku). Failures degrade gracefully."""
    try:
        q_text, _ = _bedrock_vision(br, SONNET, raw, media_type, build_question_gen_prompt())
        questions = parse_question_gen_response(q_text)
    except Exception:
        questions = {}
    try:
        f_text, _ = _bedrock_vision(br, SONNET, raw, media_type, FACTS_PROMPT)
        facts = parse_facts_response(f_text)
    except Exception:
        facts = []
    if not facts:
        facts = ["(reference facts unavailable)"]
    short_text, _ = _bedrock_vision(br, HAIKU, raw, media_type, perception_prompt_b(None))
    rich_text, _ = _bedrock_vision(br, HAIKU, raw, media_type, perception_prompt_rich(None))
    return {"questions": questions, "facts": facts, "short": short_text, "rich": rich_text}


def _run_arm_concurrent(name, arm, dataset, judge, workers: int) -> ArmRun:
    """Run one arm over the dataset with bounded concurrency (arm(item) + judge
    are independent per item; boto3 clients are thread-safe). Log-and-continue."""
    scored, errors = [], []

    def work(item):
        return score_item(item, arm(item), judge)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        fut_to_item = {ex.submit(work, it): it for it in dataset}
        for fut in fut_to_item:
            it = fut_to_item[fut]
            try:
                scored.append(fut.result())
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{it.query!r}: {type(exc).__name__}: {exc}")
    return ArmRun(arm_name=name, scored=scored, errors=errors)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Step 0 v2 offline evaluation")
    parser.add_argument("--n", type=int, default=6, help="distinct figures (default 6)")
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--region", default="ca-central-1")
    parser.add_argument("--workers", type=int, default=4, help="concurrent Bedrock calls per arm")
    args = parser.parse_args(argv)

    session = boto3.Session(region_name=args.region)
    s3 = session.client("s3")
    br = session.client("bedrock-runtime")

    keys = _sample_image_keys(s3, args.bucket, args.n)
    if not keys:
        print(f"No images in s3://{args.bucket}", file=sys.stderr)
        return 1
    image_cache = {k: (lambda b: (b, detect_media_type(b)))(s3.get_object(Bucket=args.bucket, Key=k)["Body"].read()) for k in keys}
    print(f"Sampled {len(keys)} figures; precomputing questions/facts/perception...")

    # Precompute per figure concurrently (query-independent work).
    precomp: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=min(args.workers, len(keys))) as ex:
        futs = {ex.submit(_precompute_figure, br, *image_cache[k]): k for k in keys}
        for fut in futs:
            precomp[futs[fut]] = fut.result()

    # Build the dataset: one item per (figure, generated category question).
    dataset: list[FigureEvalItem] = []
    for key in keys:
        pf = precomp[key]
        for category, question in pf["questions"].items():
            dataset.append(FigureEvalItem(query=question, figure_ref="", image_s3_key=key,
                                          expected_figure_id="", ground_truth_facts=pf["facts"], category=category))
    if not dataset:
        print("No questions generated — aborting.", file=sys.stderr)
        return 1
    print(f"{len(dataset)} questions across {len(keys)} figures "
          f"(categories: {sorted({i.category for i in dataset})})")

    answer_op = lambda system, user: _bedrock_text(br, SONNET, system, user)

    def a_provider(item):  # live, query-aware (proxy for current escalation)
        raw, mt = image_cache[item.image_s3_key]
        text, call = _bedrock_vision(br, HAIKU, raw, mt, perception_prompt_a(item))
        return text, [call]

    b_provider = lambda item: (precomp[item.image_s3_key]["short"], [])
    rich_provider = lambda item: (precomp[item.image_s3_key]["rich"], [])

    arms = {
        "A_live": build_answer_arm(a_provider, ANSWER_SYSTEM_BASELINE, answer_op),
        "B_short": build_answer_arm(b_provider, ANSWER_SYSTEM_BASELINE, answer_op),
        "C_rich": build_answer_arm(rich_provider, ANSWER_SYSTEM_BASELINE, answer_op),
        "D_rich_prompt": build_answer_arm(rich_provider, ANSWER_SYSTEM_REVISED, answer_op),
        "E_hybrid": build_hybrid_arm_e(rich_provider, a_provider, answer_op),
    }
    # HAIKU judge on Sonnet-generated references (de-biased vs same-model judging).
    judge = make_text_judge_v2(lambda prompt: _bedrock_text(br, HAIKU, "", prompt)[0])

    runs = [_run_arm_concurrent(name, arm, dataset, judge, args.workers) for name, arm in arms.items()]

    print("\n=== Step 0 v2 (PROXY; auto/unreviewed Qs + bootstrapped facts; Haiku judge) ===")
    print("Primary: correctness by category. Directional only — SME review + judge calibration pending.\n")
    print("Correctness by category:")
    print(format_category_matrix(runs, lambda si: si.correctness, "correctness"))
    print("\nHallucination by category:")
    print(format_category_matrix(runs, lambda si: si.hallucination, "hallucination"))
    print("\nOverall (aggregate across categories):")
    print(format_report([summarize(r) for r in runs]))
    print("\nArm E escalation / agreement:")
    for r in runs:
        if r.arm_name.startswith("E"):
            print(f"  {escalation_stats(r)}")
    print("\nFailure categories (non-none):")
    for r in runs:
        counts = Counter(si.failure_category for si in r.scored if si.failure_category and si.failure_category != "none")
        print(f"  {r.arm_name}: {dict(counts)}")
    for r in runs:
        if r.errors:
            print(f"\n[{r.arm_name}] {len(r.errors)} error(s), e.g. {r.errors[:2]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
