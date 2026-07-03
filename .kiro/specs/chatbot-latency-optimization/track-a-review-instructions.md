# Track A — Human Review Instructions (SME + judge calibration)

Track A is a **pre-release validation** (not research). Two review packages need human judgment; everything else is automated. This doc explains what to review and how to produce the packages. Keep SME time minimal — the packages are pre-filled; reviewers only add judgments.

Run from `cdk/` with dev credentials (`AWS_PROFILE=vincent.adm-dev2`). The harness is `multimodal_rag_v2/eval_harness/`.

## Package 1 — Question review (cheap generate-only pass)

Produce it:
```
AWS_PROFILE=vincent.adm-dev2 PYTHONPATH=. python3 -m multimodal_rag_v2.eval_harness.run_step0_v2 \
    --n 25 --generate-only --export-questions track-a-questions.json
```
This generates category questions for ~25 figures and writes `track-a-questions.json` (no arms/judge — cheap). Each row: `figure, category, question, reference` + blank `action`, `edited_question`, `notes`.

Reviewer (SME) fills, per row:
- `action`: `accept` | `edit` | `reject`.
- If `edit`: put the corrected wording in `edited_question`.
- `reject` if the question isn't answerable from the figure, is unnatural, or is pedagogically off.
- Also sanity-check `reference` — if the auto-generated reference is wrong, note it (the reference is what the judge grades against).

Useful signal: the **edit rate**. If ~95% of generated questions are accepted unchanged, auto-generation is trustworthy for future runs.

## Package 2 — Judge calibration (from a scored run)

Produce it (adds a sampled export to a normal run):
```
AWS_PROFILE=vincent.adm-dev2 PYTHONPATH=. python3 -m multimodal_rag_v2.eval_harness.run_step0_v2 \
    --n 25 --export-calibration track-a-calibration.json
```
`track-a-calibration.json` holds a random 10–20% of scored items: `question, answer, reference_facts, judge_correctness, judge_hallucination, judge_failure_category, judge_rationale` + blank `human_correctness`, `human_hallucination`, `human_agrees_with_judge`, `human_notes`.

Reviewer fills, per row:
- `human_correctness` / `human_hallucination` — your own score of the answer against the reference facts.
- `human_agrees_with_judge` — `true`/`false`.
- `human_notes` — especially where you disagree with the judge.

Goal: measure judge-vs-human agreement. If agreement is high, trust the Haiku judge's aggregate numbers. If it disagrees systematically (e.g., over-credits, mis-detects hallucination), re-tune the judge prompt or discount those categories before using the study for sign-off.

## What "done" looks like

- Questions curated (accept/edit/reject applied); edit rate recorded.
- Judge agreement measured on the 10–20% sample and deemed acceptable (or judge re-tuned).
- The full Track A study (per-category correctness/hallucination + arm-E stats) is then trustworthy input to the production success criteria in `production-design.md`.
