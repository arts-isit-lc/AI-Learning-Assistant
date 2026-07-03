# Production Design (DRAFT) — Perception at Ingestion

- Status: **DESIGN ONLY — not for merge yet.** Drafted in parallel with Track A (the production validation study). Implementation begins only after Track A confirms under realistic conditions.
- Basis: evidence in `findings.md` (v2 pilot + Track B). Architecture is the leading design pending production validation; runtime vision becomes a rare/defensive fallback.
- Principle: **perception at ingestion, interpretation at runtime.** The remaining risk is representational (verbatim fidelity), addressed by transcription-forced perception.

> This is prose/pseudocode for review. No production code changes until Track A validates and the design is approved.

---

## Goal

Replace the per-query runtime vision "escalation" as the default figure-QA path with a **rich structured perception computed once at ingestion**, injected at retrieval, and interpreted at runtime by Sonnet. Keep runtime vision behind a flag as an exceptional recovery mechanism.

Expected effects (from the pilots): figure-turn retrieval ~5.5s → DB read; TTFT on figure turns ~6s → ~2s; fewer runtime Bedrock calls; equal-or-better answer quality with lower hallucination on labels.

---

## Components & changes (all `multimodal_rag_v2`, flag-gated)

1. **Ingestion enrichment — rich perception (`enrichment/vision_service.py`).**
   - Replace the short `VISION_PROMPT` (1–3 sentence description) with the validated transcription-forced, structured prompt (see `eval_harness/experiment_v2.PERCEPTION_PROMPT_TRANSCRIPTION` + the perception schema in `findings.md`). One Haiku vision call per image, as today — just a richer prompt + structured output.
   - Parse into the **perception schema** JSON: `summary, ocr[], objects[], relationships[], equations[], charts[], concepts[], warnings[]` (+ existing `image_type`). Populate `ocr`/`objects`/`relationships` from the new prompt; keep `image_type`/`summary`/`concepts` (≈ today).

2. **Data model (`models/data_models.py`) + builder (`enrichment/retrieval_unit_builder.py`).**
   - `EnrichedElement`: add a structured `perception` field (the schema) alongside the existing fields (additive; keep `image_description` for back-compat during migration).
   - Store the structured JSON on the retrieval unit, plus a **rendered prose form** for prompt injection (don't inject raw JSON — token bloat / LLM confusion; render selected fields).
   - `embedding_text`: consider enriching with transcription/labels (helps recall). Multi-field embeddings are a *separate, later* change (findings phase 2) — not required here.

3. **Retrieval / reasoning injection (`reasoning/reasoning_engine.py`, `image_escalation.py`).**
   - Inject the **stored** rendered perception into context — reuse the existing `_format_escalation_section` mechanics (they already prepend a "Visual Analysis" block).
   - **Keep the exact figure-reference lookup** (`_find_image_by_figure_ref_in_db`) — but have it return the *stored* perception instead of invoking live vision. This preserves figure-ref precision without the vision call (the retrieval-coupling risk noted in findings).

4. **Runtime vision → feature-flagged fallback (`flags.py`).**
   - New flag, e.g. `PERCEPTION_FROM_INGESTION` (default OFF = current live-escalation behavior). ON = inject stored perception; live vision only via the fallback.
   - Keep the escalation code path behind a `RUNTIME_VISION_FALLBACK` flag as a **rare/defensive** recovery mechanism (not the normal path). Routing is deliberately simple initially (e.g., only when stored perception is missing/low-confidence-flagged); a semantic (question-type) router is a later, separate piece — Track-B evidence says labels no longer need it.

## Migration (`ENRICHMENT_VERSION` bump + backfill)

- Bump `ENRICHMENT_VERSION` (`haiku-v5-...` → `haiku-v6-...`). This invalidates the DynamoDB enrichment cache and forces re-enrichment of images on next ingestion (per the engineering-log note).
- **Backfill:** re-run enrichment over the existing corpus so stored images get the rich perception. Options: (a) re-ingest affected files, or (b) a one-off backfill job that re-enriches image elements. Cost = one Haiku vision call per image (bounded; images change rarely). Sequence the backfill before flipping `PERCEPTION_FROM_INGESTION` on for reads.
- **Back-compat during migration:** reads must tolerate images enriched under the old version (no `perception`) — fall back to `image_description` (or the runtime-vision fallback) until backfill completes.

## Feature flags & rollout

- `PERCEPTION_FROM_INGESTION` (read path) + `RUNTIME_VISION_FALLBACK` (recovery). Both default OFF (no-op deploy), per the repo's flag contract.
- Rollout: bump version + backfill in dev → enable `PERCEPTION_FROM_INGESTION` in dev → measure (latency + a spot quality check) → enable in prod. Instantly revertible (flag off → live escalation).

## Testing strategy

- `enrichment/vision_service` tests: new prompt → parsed perception schema; malformed response → graceful fallback.
- `retrieval_unit_builder` tests: perception persisted + rendered form produced.
- `reasoning_engine` tests: stored perception injected; figure-ref lookup returns stored perception (no vision call) when the flag is on; fallback path still works when flag off or perception missing.
- CDK: `ENRICHMENT_VERSION` + new flag env vars; **no new IAM** (the chatbot/retrieval roles already grant `bedrock:InvokeModel*` + `ApplyGuardrail`; enrichment already has vision perms).
- Determinism per repo conventions (mock Bedrock/S3; factories).

## Risks & open questions

- **Re-ingestion cost/op:** backfill is a one-time compute + operational run; schedule it, don't block reads on it (back-compat above).
- **Rendered-JSON token size:** render selected fields, cap length; measure prompt size after injection.
- **Retrieval must surface the right figure:** preserved by the exact figure-ref lookup; multi-field embeddings (later) further de-risk.
- **Fallback routing:** kept trivial initially; a semantic router is a separate effort only if evidence later demands it.
- **Open:** does the richer perception meaningfully change `embedding_text`/recall? (defer to the multi-field-embeddings phase). Confirm Track A before implementing.

## Sequencing (relative to Track A)

1. Track A (production validation study) runs first / in parallel — SME-reviewed questions, calibrated judge.
2. This design is refined against Track A results (esp. any category that regresses).
3. Only then: implement behind flags → dev backfill + enable → measure → prod.

---

## Production success criteria (define before any merge)

Objective go/no-go for the rollout — checked against the Track A validation study + a dev canary. Written down now so the deployment can be judged objectively:

- **Latency:** P95 first-token latency on figure questions reduced by ≥ X s vs current production (target set from the ~4–6 s pre-token retrieval wait measured in findings).
- **Quality parity:** correctness not measurably worse than current production; **hallucination rate not increased** (Track B showed labels improve).
- **Fallback rate:** runtime-vision fallback invoked on **< 5–10 %** of figure requests; if higher, revisit routing / ingestion fidelity before rollout.
- **Migration:** corpus backfill completes successfully; reads degrade gracefully for not-yet-backfilled images.
- **Rollback:** the flag-off path (revert to live escalation) is **verified in dev** before enabling in prod.
- **Judge trust:** the calibrated judge agrees with human reviewers on the 10–20 % sample within an agreed tolerance (else re-calibrate before trusting the study).

Exact thresholds (the "X") are fixed with the team from the Track A baseline before enabling in prod.
