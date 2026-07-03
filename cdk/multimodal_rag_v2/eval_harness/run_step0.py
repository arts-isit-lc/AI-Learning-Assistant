"""CLI: run the Step 0 offline A/B/C/D pilot against dev (S3 + Bedrock).

Usage (from cdk/, with dev credentials in the environment):
    AWS_PROFILE=vincent.adm-dev2 PYTHONPATH=. \\
        python3 -m multimodal_rag_v2.eval_harness.run_step0 --n 6

Samples real figure images from the IR bucket, bootstraps reference facts with
Sonnet vision, runs arms A/B/C/D (Haiku perception + Sonnet answer, model held
constant so only the PROMPT varies), grades each with a Sonnet text-judge, and
prints the comparison report.

This is an OFFLINE PROXY (no production retrieval pipeline) and the reference
facts are model-bootstrapped (SME-reviewable, not authoritative). Primary
signal: correctness / hallucination per arm. retrieval_precision is N/A here.
The pure logic is covered by test_experiment.py; this integration entrypoint is
validated by running it.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys

import boto3

from .experiment import (
    ANSWER_SYSTEM_BASELINE,
    ANSWER_SYSTEM_REVISED,
    FACTS_PROMPT,
    ArmOps,
    build_arm,
    detect_media_type,
    make_text_judge,
    parse_facts_response,
    perception_prompt_a,
    perception_prompt_b,
    perception_prompt_rich,
)
from .figure_dataset import FigureEvalItem
from .report import format_report, summarize
from .runner import run_arm
from .scoring import BedrockCall

HAIKU = "anthropic.claude-3-haiku-20240307-v1:0"
SONNET = "anthropic.claude-3-sonnet-20240229-v1:0"
DEFAULT_BUCKET = "aila-multimodalragstack-ir-bucket"
DEFAULT_QUESTION = (
    "What does this figure show? Include any labels, values, axes, and relationships visible."
)
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp")


def _bedrock_text(client, model_id: str, system: str, user: str, max_tokens: int = 1024):
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": user}]}
    if system:
        body["system"] = system
    resp = client.invoke_model(modelId=model_id, contentType="application/json",
                               accept="application/json", body=json.dumps(body))
    rb = json.loads(resp["body"].read())
    usage = rb.get("usage", {})
    return rb["content"][0]["text"], BedrockCall(model_id, usage.get("input_tokens", 0), usage.get("output_tokens", 0))


def _bedrock_vision(client, model_id: str, image_bytes: bytes, media_type: str, prompt: str, max_tokens: int = 1024):
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                {"type": "text", "text": prompt}]}]}
    resp = client.invoke_model(modelId=model_id, contentType="application/json",
                               accept="application/json", body=json.dumps(body))
    rb = json.loads(resp["body"].read())
    usage = rb.get("usage", {})
    return rb["content"][0]["text"], BedrockCall(model_id, usage.get("input_tokens", 0), usage.get("output_tokens", 0))


def _sample_image_keys(s3, bucket: str, n: int) -> list[str]:
    """Return up to n DISTINCT figure images (deduped by object basename, since
    the same figure is re-stored under multiple module/version prefixes)."""
    keys: list[str] = []
    seen: set[str] = set()
    token = None
    while True:
        kwargs = {"Bucket": bucket}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            key = obj["Key"]
            if key.lower().endswith(IMAGE_EXTS):
                basename = key.rsplit("/", 1)[-1]
                if basename not in seen:
                    seen.add(basename)
                    keys.append(key)
        token = resp.get("NextContinuationToken")
        if not token or len(keys) >= n:
            break
    return keys[:n]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Step 0 offline A/B/C/D pilot")
    parser.add_argument("--n", type=int, default=6, help="number of distinct figures (default 6)")
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--region", default="ca-central-1")
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    args = parser.parse_args(argv)

    session = boto3.Session(region_name=args.region)
    s3 = session.client("s3")
    br = session.client("bedrock-runtime")

    keys = _sample_image_keys(s3, args.bucket, args.n)
    if not keys:
        print(f"No images found in s3://{args.bucket}", file=sys.stderr)
        return 1
    print(f"Sampled {len(keys)} distinct figures from s3://{args.bucket}")

    # Prefetch bytes once (reused for fact bootstrap + all arms) to bound S3 GETs.
    image_cache: dict[str, tuple[bytes, str]] = {}
    for key in keys:
        raw = s3.get_object(Bucket=args.bucket, Key=key)["Body"].read()
        image_cache[key] = (raw, detect_media_type(raw))

    # Bootstrap reference facts per figure via Sonnet vision (the answer key).
    dataset: list[FigureEvalItem] = []
    for key in keys:
        raw, media_type = image_cache[key]
        try:
            facts_text, _ = _bedrock_vision(br, SONNET, raw, media_type, FACTS_PROMPT)
            facts = parse_facts_response(facts_text)
        except Exception as exc:  # noqa: BLE001
            print(f"  fact-bootstrap failed for {key}: {exc}", file=sys.stderr)
            facts = []
        if not facts:
            facts = ["(reference facts unavailable)"]
        dataset.append(FigureEvalItem(query=args.question, figure_ref="", image_s3_key=key,
                                      expected_figure_id="", ground_truth_facts=facts))
    print(f"Bootstrapped reference facts for {len(dataset)} figures "
          f"(avg {sum(len(i.ground_truth_facts) for i in dataset)/len(dataset):.1f} facts/figure)")

    def fetch_image(key: str):
        return image_cache[key]

    ops = ArmOps(
        fetch_image=fetch_image,
        perceive=lambda raw, mt, prompt: _bedrock_vision(br, HAIKU, raw, mt, prompt),
        answer=lambda system, user: _bedrock_text(br, SONNET, system, user),
    )
    judge = make_text_judge(lambda prompt: _bedrock_text(br, SONNET, "", prompt)[0])

    arms = {
        "A_live_escalation": build_arm(perception_prompt_a, ANSWER_SYSTEM_BASELINE, ops),
        "B_short_desc": build_arm(perception_prompt_b, ANSWER_SYSTEM_BASELINE, ops),
        "C_rich_desc": build_arm(perception_prompt_rich, ANSWER_SYSTEM_BASELINE, ops),
        "D_rich_plus_prompt": build_arm(perception_prompt_rich, ANSWER_SYSTEM_REVISED, ops),
    }

    runs = [run_arm(name, arm, dataset, judge) for name, arm in arms.items()]

    print("\n=== Step 0 offline pilot (PROXY; bootstrapped GT; small n) ===")
    print("Primary signal: correctness / hallucination. retrieval_prec is N/A (no retrieval in the proxy).")
    print("Latency/cost include on-the-fly perception for B/C/D, which would be PRECOMPUTED at ingestion in prod.\n")
    print(format_report([summarize(r) for r in runs]))
    for r in runs:
        if r.errors:
            print(f"\n[{r.arm_name}] {len(r.errors)} error(s): {r.errors[:3]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
