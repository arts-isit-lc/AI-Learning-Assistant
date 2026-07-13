"""CLI: focused label-lookup study (Track B) — does better ingestion
transcription close the label-lookup gap the v2 pilot found?

Usage (from cdk/, with dev credentials in the environment):
    AWS_PROFILE=... PYTHONPATH=. python3 -m multimodal_rag_v2.eval_harness.run_label_study --n 6 --questions 8

Per figure: generate N label-lookup Q+A pairs (Sonnet vision; the exact expected
text becomes the ground truth), and precompute two query-agnostic perceptions
(Haiku): the CURRENT rich prompt and the sharpened TRANSCRIPTION-forced prompt.
Arms compared on label-lookup only:
  A_live            live query-aware perception (ceiling)
  C_rich_current    current rich stored perception (the ~0.73 failer)
  C_transcription   transcription-forced stored perception (the fix candidate)
  D_transcription   transcription-forced + revised answer prompt
Grade with a Haiku judge. If C/D_transcription approaches A_live, better
ingestion transcription closes the gap and no label escalation is needed.

Offline proxy; model-bootstrapped, unreviewed Q+A; directional (see findings.md).
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor

import boto3

from .experiment import (
    ANSWER_SYSTEM_BASELINE,
    ANSWER_SYSTEM_REVISED,
    detect_media_type,
    perception_prompt_a,
    perception_prompt_rich,
)
from .experiment_v2 import (
    PERCEPTION_PROMPT_TRANSCRIPTION,
    build_answer_arm,
    build_label_question_gen_prompt,
    make_text_judge_v2,
    parse_label_questions,
)
from .figure_dataset import FigureEvalItem
from .report import export_calibration_sample, format_report, summarize
from .run_step0 import HAIKU, SONNET, DEFAULT_BUCKET, _bedrock_text, _bedrock_vision, _sample_image_keys
from .run_step0_v2 import _run_arm_concurrent


def _precompute_label_figure(br, raw: bytes, media_type: str, n_questions: int) -> dict:
    try:
        q_text, _ = _bedrock_vision(br, SONNET, raw, media_type, build_label_question_gen_prompt(n_questions))
        pairs = parse_label_questions(q_text)
    except Exception:
        pairs = []
    rich, _ = _bedrock_vision(br, HAIKU, raw, media_type, perception_prompt_rich(None))
    trans, _ = _bedrock_vision(br, HAIKU, raw, media_type, PERCEPTION_PROMPT_TRANSCRIPTION)
    return {"pairs": pairs, "rich": rich, "transcription": trans}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Step 0 Track B: label-lookup study")
    parser.add_argument("--n", type=int, default=6, help="distinct figures (default 6)")
    parser.add_argument("--questions", type=int, default=8, help="label Qs per figure (default 8)")
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--region", default="ca-central-1")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--export-calibration", default=None)
    parser.add_argument("--calibration-fraction", type=float, default=0.15)
    args = parser.parse_args(argv)

    session = boto3.Session(region_name=args.region)
    s3 = session.client("s3")
    br = session.client("bedrock-runtime")

    keys = _sample_image_keys(s3, args.bucket, args.n)
    if not keys:
        print(f"No images in s3://{args.bucket}", file=sys.stderr)
        return 1
    image_cache = {k: (lambda b: (b, detect_media_type(b)))(s3.get_object(Bucket=args.bucket, Key=k)["Body"].read()) for k in keys}
    print(f"Sampled {len(keys)} figures; generating label questions + perception...")

    precomp: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=min(args.workers, len(keys))) as ex:
        futs = {ex.submit(_precompute_label_figure, br, *image_cache[k], args.questions): k for k in keys}
        for fut in futs:
            precomp[futs[fut]] = fut.result()

    dataset: list[FigureEvalItem] = []
    for key in keys:
        for question, expected in precomp[key]["pairs"]:
            dataset.append(FigureEvalItem(query=question, figure_ref="", image_s3_key=key,
                                          expected_figure_id="", ground_truth_facts=[expected],
                                          category="label_lookup"))
    if not dataset:
        print("No label questions generated — aborting.", file=sys.stderr)
        return 1
    print(f"{len(dataset)} label-lookup questions across {len(keys)} figures")

    def answer_op(system, user):
        return _bedrock_text(br, SONNET, system, user)

    def a_provider(item):
        raw, mt = image_cache[item.image_s3_key]
        text, call = _bedrock_vision(br, HAIKU, raw, mt, perception_prompt_a(item))
        return text, [call]

    def c_current(item):
        return (precomp[item.image_s3_key]["rich"], [])

    def c_trans(item):
        return (precomp[item.image_s3_key]["transcription"], [])

    arms = {
        "A_live": build_answer_arm(a_provider, ANSWER_SYSTEM_BASELINE, answer_op),
        "C_rich_current": build_answer_arm(c_current, ANSWER_SYSTEM_BASELINE, answer_op),
        "C_transcription": build_answer_arm(c_trans, ANSWER_SYSTEM_BASELINE, answer_op),
        "D_transcription": build_answer_arm(c_trans, ANSWER_SYSTEM_REVISED, answer_op),
    }
    judge = make_text_judge_v2(lambda prompt: _bedrock_text(br, HAIKU, "", prompt)[0])

    runs = [_run_arm_concurrent(name, arm, dataset, judge, args.workers) for name, arm in arms.items()]

    print("\n=== Step 0 Track B: label-lookup study (PROXY; Haiku judge; directional) ===")
    print("Question: does transcription-forced stored perception (C/D) close the gap to live (A)?\n")
    print(format_report([summarize(r) for r in runs]))
    for r in runs:
        if r.errors:
            print(f"\n[{r.arm_name}] {len(r.errors)} error(s), e.g. {r.errors[:2]}")

    if args.export_calibration:
        k = export_calibration_sample(runs, args.export_calibration, fraction=args.calibration_fraction)
        print(f"\nWrote {k} calibration rows -> {args.export_calibration}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
