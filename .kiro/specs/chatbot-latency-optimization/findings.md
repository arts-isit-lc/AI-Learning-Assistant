# Chatbot Latency Optimization — Findings, Hypotheses & Evaluation Plan

- Date: 2026-07-02 (revised same day across two review rounds)
- Scope: `chatbot_v2` request flow (structured-learning chatbot) + the `multimodal_rag_v2` retrieval path it calls.
- Framing (evolved): this began as a latency task, but the evidence has turned it into validating a **multimodal-RAG architecture split — perception as an ingestion concern, interpretation as a runtime concern**. If confirmed across hard question types, that is a more significant result than the latency win alone, and it narrows the likely production shape to two outcomes: (1) rich ingestion + runtime reasoning + rare fallback, or (2) a stored-perception → confidence-check → live-perception hybrid.
- Status: async-guardrail fix shipped to dev; Step 0 harness built + a **directional 5-figure pilot run** (result below — encouraging but not decision-grade). The figure-architecture changes remain hypotheses pending a full Step 0 run. See "Status & progress" for exactly what is built vs planned.
- Readiness: this document is ready for architecture review. Only **Step 0 (the evaluation)** is being built; every architecture change below is contingent on its outcome. Do not build richer ingestion, schema changes, corpus reprocessing, or escalation removal before Step 0 decides.
- Method: CloudWatch (dev, account `…0264`, `ca-central-1`) via the `latency_breakdown` / `stream_latency` / retrieval-function logs; code review of the streaming, reasoning, and enrichment paths.

> Measured vs inferred: numbers labeled "measured" come from dev CloudWatch this date. Items labeled "estimate/inferred" are reasoned from model-class behavior + our measured rates and are NOT A/B'd in this system.

---

## Status & progress

What is actually built vs planned. Markers: **[DONE]** · **[PENDING]** (contingent on the Step 0 result).

- **[DONE] Async-guardrail migration** — shipped to dev (`USE_CONVERSE_STREAMING`, dev-on/prod-off); prod OFF pending a dev validation pass. Independent of the figure work.
- **Step 0 — the evaluation** (this is "Stage 1" of the roadmap; the only thing being built now):
  - **[DONE] Phase 1 — evaluation harness + dataset scaffolding.** In `multimodal_rag_v2/eval_harness/`: `figure_dataset.py` (schema + loader) + `figure_eval_set.json` (3 seed *templates*, not real data), `scoring.py` (metrics + injected judge), `runner.py`, `report.py`, and tests (25 pass). **Framework only** — it runs on fake arms/judge and produces no real result yet.
  - **[PILOT DONE — directional] Phase 2/3 — offline experiment + pilot run.** Built a runnable offline harness (`experiment.py` + `run_step0.py`: arms A/B/C/D as Bedrock perception+answer on real dev IR-bucket images, model-bootstrapped reference facts, Sonnet text-judge) and ran a 5-figure pilot (result below). NOT a decision yet — needs scale-up + SME-reviewed facts + a de-biased judge.
  - **[PENDING] Phase 2b — v2 iteration (next, decision-grade).** ~20–30 figures × 5 question categories (incl. label-lookup, relationships, chart-reading, comparison), CIs + a failure taxonomy, a new hybrid arm E (+ escalation frequency), and a de-biased judge with a human-reviewed calibration sample. The decision comes from THIS, not a bigger unchanged run. See "Step 0 — v2 iteration".
- **[PENDING — only if Step 0 validates] Stage 3 — production architecture:** richer ingestion prompt + perception schema, `ENRICHMENT_VERSION` bump + corpus backfill, retrieval injects the stored analysis, flagged removal of the runtime vision call.
- **[PENDING] Stage 4 — re-measure & optimize:** multi-field embeddings, response-length tuning (#2), progressive-UX.

Naming note: "Phase 1–3" are the sub-steps of Step 0; "Stage 1–4" are the higher-level roadmap below (Stage 1 = Step 0). Everything from Stage 3 down is a hypothesis, not committed work.

---

## TL;DR

1. The original dominant cost was **generation TTFT** from the guardrail in **synchronous** stream mode. **Shipped (dev):** ConverseStream with the guardrail in `async` mode (`USE_CONVERSE_STREAMING`, dev-on/prod-off). Measured TTFT **~8s → ~1.5s**.
2. **New bottleneck:** on figure turns, retrieval is ~4–7s, almost entirely a **runtime Claude 3 Haiku vision "escalation" call** (~5.5s median, uncached).
3. **Working hypothesis (after review):** the latency likely exists because we perform **perception at query time** when it may belong at **ingestion**. Hypothesis to validate: producing a rich, structured image understanding once at ingestion and injecting it at retrieval can replace the runtime vision call without losing answer quality. Conditional argument: *if* the vision analysis can be made query-independent, then it becomes a pure function of the image, and computing it once at ingestion is architecturally preferable to memoizing it at runtime (no cache, warm-up, or invalidation). The current escalation prompt is query-aware, so making perception query-independent is a prerequisite, not a given. This hypothesis should be validated via Step 0 before implementation.
4. **Gate everything on a measurement first:** A/B answer quality of *escalation* vs *ingestion-description-only*. If the description is ~as good, deleting escalation becomes the strongest outcome.

---

## Current latency profile (post async-guardrail, `converse` mode)

Measured on a substantive multi-turn request (dev):

| Phase | Time | Notes |
|---|---|---|
| state / history load (DynamoDB) | ~10 ms | negligible |
| eval (Claude 3 Haiku) | ~1.3–2.6 s | runs in PARALLEL with retrieval (`PARALLEL_EVAL_RETRIEVAL`), hidden under it |
| retrieval (RAG Lambda round-trip) | ~4–7 s | dominated by image escalation; ~1.6 s on opening/non-figure turns |
| generation (Sonnet stream) | ~4–11 s | TTFT ~1.5 s + output streaming at ~40 tok/s |
| persist | ~30–90 ms | negligible |
| **total** | **~14–16 s** | first visible token at ~5–6 s on figure turns |

TTFT (perceived responsiveness) is now good (~1.5 s). The remaining pain is (a) ~4–7 s of retrieval *before* the first token, and (b) ~9 s of output streaming *after* it (progressive, less painful).

---

## Shipped: ConverseStream async-guardrail migration (DONE — dev)

- Root cause: guardrails default to **synchronous** stream processing (buffer + scan before the first token). Async mode is only reachable via **ConverseStream** (`guardrailConfig.streamProcessingMode="async"`); `InvokeModelWithResponseStream` has no top-level stream-mode param and Claude rejects the `amazon-bedrock-guardrailConfig` body key.
- A/B (measured): TTFT **guardrail ON avg ~8.1 s / median 7.8 s (n=12)** vs **OFF avg ~1.3 s / median 1.1 s (n=3)**; ON-TTFT didn't track input size → overhead, not prefill.
- Fix: `chatbot_v2/src/streaming.py` refactored around a normalized event iterator (`_iter_invoke_events` / `_iter_converse_events`) behind `USE_CONVERSE_STREAMING`. Interventions handled via `stopReason="guardrail_intervened"`. Guardrail has no PII masking, so async's masking limitation doesn't apply.
- State: dev = ON, prod = OFF pending validation. Committed on `dev` (`17386b4`, `2fac502`). Post-deploy measured TTFT ~1.3–1.7 s.

---

## Where the time goes: figure perception is done twice (code-grounded)

1. **Enrichment (ingestion, once per image):** `multimodal_rag_v2/enrichment/vision_service.py` runs Haiku vision with `VISION_PROMPT` → stores `image_type`, `image_description` (1–3 sentences), `topics`, `labels`, `keywords`; `embedding_text = "{type}: {description}"`. **Short.**
2. **Escalation (query time, ~5.5 s, uncached):** `multimodal_rag_v2/reasoning/image_escalation.py` runs a **second** Haiku vision call (`"Analyze this image in the context of: {query}"`, ~1000–1500 chars). Measured `escalation_latency_ms` ≈ `llm_latency_ms` = 3.9–7.2 s (median ~5.5 s); S3 fetch + vector/BM25 are negligible.

How the escalation output reaches the answer (`reasoning/reasoning_engine.py`):
- For a figure reference, `_find_image_by_figure_ref_in_db` resolves the exact figure and the engine **returns the vision analysis directly** as the answer (bypassing the reasoning LLM).
- Otherwise `_format_escalation_section` **prepends** the analysis into the context ("Visual Analysis of Referenced Figure").
- `RAG_RETURN_PASSAGES` is on, so the reasoning-layer Haiku generation is already skipped and the chatbot's Sonnet does the final generation. So the remaining duplication is **perception (vision), not generation**.

No OCR anywhere: ingestion extracts native text from PDF/PPTX/HTML, but figures are only "understood" by the Haiku vision description. Text inside diagrams (labels, axes, legends) — often exactly what students ask about — is captured only if that short description mentions it.

---

## Revised direction (hypotheses — pending Step 0)

**Framing: perception vs interpretation.** These are distinct steps that need not share a model invocation:
- **Perception** — read the pixels into facts: transcription of visible text, labels, axes, arrows, objects, equations, relationships. Depends only on the image.
- **Interpretation** — use those facts plus the student's question to produce an answer. Depends on the query.

The hypotheses below rest on this split: perception could move to ingestion (image-only, computed once), while interpretation stays at runtime (Sonnet, query-specific). Step 0 tests whether that split holds without losing answer quality — it is not assumed.

### Step 0 — Measure necessity first (hard gate, and the only near-term build)

The whole project reduces to one research question: **does richer *stored* perception replace *live* perception?** Yes → delete escalation. No → keep it. Partially → hybrid (scope to the cases that need it). Everything else is contingent on this answer, so Step 0 is built and run in isolation, entirely offline, before any production code.

Comparison arms (blind-scored on ~100 real figure questions with references):
- **A:** current runtime escalation.
- **B:** ingestion `image_description` only (no runtime vision).
- **C:** a *richer* ingestion analysis only (prototype the enriched perception prompt offline).
- **D:** richer ingestion analysis **+ the downstream Sonnet prompt revised** to use it — isolates whether any gap is the *stored information* vs *how the model is instructed to use it* (sometimes the fix is the prompt, not a richer description).
- **E (hybrid):** stored (rich) perception, escalating to live perception ONLY when stored confidence is low — tests the likely production design. Record escalation frequency: escalating ~3% of the time means the fallback is essentially free; ~60% means the architecture changes.

Metrics per arm (latency is not the only axis — the hypothesis likely improves most of these):
- answer correctness, hallucination rate, citations/sources actually used, retrieval precision (right figure surfaced), end-to-end latency, token usage, and Bedrock cost.

Staged so nothing touches production:
- **[DONE] Phase 1 — harness + dataset scaffolding.** Schema/loader, scoring, runner, report + tests in `multimodal_rag_v2/eval_harness/`. Framework only (fake arms/judge); the seed dataset holds 3 templates, not the real ~100.
- **[PENDING] Phase 2 — real data + offline arm prototypes.** Populate ~100 real figure questions (SME-labeled facts), wire arms A/B/C/D + the LLM-judge, and generate richer descriptions (+ a revised Sonnet prompt) offline. Do NOT modify ingestion, migrate schemas, or reprocess the corpus.
- **[PENDING] Phase 3 — run and decide.** Score A/B/C/D on the metrics above; decide delete / replace / hybrid / keep from data before writing any production code.

### Step 0 — preliminary pilot result (2026-07-02, DIRECTIONAL ONLY)

A 5-figure offline pilot (`run_step0.py`, real dev images + Bedrock; Haiku perception held constant with the prompt varied per arm; Sonnet answer + Sonnet text-judge; model-bootstrapped reference facts, avg 8.6/figure):

| metric | A live escalation | B short desc | C rich desc | D rich + revised prompt |
|---|---|---|---|---|
| correctness (higher=better) | 0.84 | 0.84 | 0.90 | 0.94 |
| hallucination (lower=better) | 0.10 | 0.08 | 0.08 | 0.06 |

Directional read: rich, query-independent *stored* perception (C/D) **matched or beat** the live, query-aware escalation (A) on both axes; even the current short description (B) tied A. D (richer description + a revised answer prompt) was best — consistent with "the downstream prompt matters as much as the stored info." This supports the hypothesis that perception can move to ingestion.

This is NOT a decision. Caveats:
- **n=5**, one broad "what does this figure show" question per figure — no statistical weight, and narrow/specific questions (where query-aware escalation might win) are untested.
- **Offline proxy** — no production retrieval/injection; it tests perception quality only.
- **Same-model bias:** reference facts and the judge are both Sonnet, which can favor the comprehensive C/D descriptions. A rigorous run needs a judge that isn't the GT generator (or human scoring).
- Latency/cost are omitted here because B/C/D perception ran on-the-fly in the proxy (in prod it's precomputed at ingestion → ~0 runtime); the Phase-1 CloudWatch numbers already establish the latency win.

The next step is a targeted v2 iteration (below) that *attacks* the hypothesis on hard question types — NOT a bigger version of this same broad-question run.

### Step 0 — v2 iteration (next; attack the hypothesis, don't just scale it)

Rather than 100 random figures, deliberately probe where live, query-aware perception *should* win if it has any edge. ~20–30 figures × 5 question categories:

| Category | Question shape | Stresses |
|---|---|---|
| High-level description | "what does this show" (pilot covered) | summary |
| Label lookup | "which label / axis / legend says X" | OCR / transcription |
| Relationship reasoning | "which arrow / what follows X" | flows, structure |
| Numerical / chart interpretation | "value at X", "the trend" | chart reading |
| Cross-reference / comparison | "compare Figure 4 and Figure 6" | multi-figure |

Design upgrades from the pilot:
- **Statistics, not point estimates:** mean + std dev + 95% CI per arm (and per category), so 0.94 vs 0.90 is interpretable.
- **Failure taxonomy** (the biggest addition): the judge classifies each miss — wrong figure, OCR error, missed relationship, hallucinated object, missed equation, prompt misunderstanding, retrieval failure — so we learn *which subsystem* to fix, not just the aggregate score.
- **Arm E (hybrid)** added (see arms) + its live-escalation frequency.
- **De-bias the judge:** use a different model than the fact generator (e.g., Haiku judge vs Sonnet-generated facts — same family, so partial), and **human-review 10–20%** to calibrate. (Full independence needs a non-Anthropic model, unavailable here, or human scoring.)

Decision rule: if rich stored perception (esp. D/E) still matches or beats A across the *hard* categories, move to production as a **feature-flagged hybrid (arm E)** — not an outright removal of runtime vision. If it fails specific categories, that pinpoints exactly what ingestion must capture (e.g., transcription for label-lookup).

### Primary hypothesis — evaluate replacing runtime perception with richer ingestion

_Pursue only if Step 0 shows richer ingestion matches escalation quality:_

- Enrich the enrichment vision pass (`vision_service.py` `VISION_PROMPT`) to produce a **rich, structured** analysis once per image (see "Perception schema" below): detailed description, objects, labels/axes/legends, relationships, **transcribed visible text**, equations, and concepts. Store as **structured JSON** plus a rendered prose form for prompt injection.
- Bump `ENRICHMENT_VERSION` and **re-process the corpus** (one-time cost — see Risks). Images change rarely, so ingestion is a reasonable place to spend compute.
- Retrieval injects the stored analysis into context — the injection mechanics already exist (`_format_escalation_section`). **Keep** the precise figure-reference lookup (`_find_image_by_figure_ref_in_db`); just have it read the stored analysis instead of invoking vision.
- Remove the runtime vision call; keep the code path behind a flag as a targeted fallback (see below).
- Expected latency if validated: figure-turn retrieval ~5.5 s → DB read (~ms), with no cache, warm-up, or invalidation.

### Perception schema (define now, populate incrementally)

Define the stored-perception schema up front — even fields we don't populate immediately. Schema changes downstream (re-embed, re-store, migrate) are expensive; prompt changes are cheap. Prototype it in Step 0's offline arm so we validate against the real target shape, and version it (e.g. `perception_schema_version`) so it can evolve.

```json
{
  "schema_version": "perception-v1",
  "image_type": "diagram | chart | graph | photo | screenshot | table | illustration | equation",
  "summary": "3-6 sentence overview of what the image shows",
  "ocr": ["verbatim visible text: labels, axis names, legends, callouts, annotations"],
  "objects": ["salient objects/entities depicted"],
  "relationships": ["how objects relate: arrows, flows, hierarchy, causality"],
  "equations": ["transcribed formulae (LaTeX-ish), if any"],
  "charts": [{ "type": "", "axes": [], "series": [], "notable_values": [] }],
  "concepts": ["course concepts the image illustrates"],
  "warnings": ["low-confidence or ambiguous regions the model is unsure about"]
}
```

Populate `image_type`/`summary`/`concepts` first (roughly what enrichment produces today), then `ocr`/`objects`/`relationships`/`equations`/`charts` as the richer prompt lands. `warnings` supports graceful degradation and a possible "escalate live only when the model flagged uncertainty" hybrid.

### Secondary — capture figure text at ingestion (transcription in the vision pass)

Have the enrichment vision pass **transcribe visible text** (labels, axis names, legends, callouts) as part of its existing call, avoiding the operational complexity of introducing a dedicated OCR engine. Educational figures are often text-heavy, so this may answer many figure questions on its own. Whether in-vision transcription is sufficient (vs a dedicated OCR step) is itself a measurement, not an assumption.

### Retrieval quality — multi-field embeddings (phase 2)

Embed multiple facets per image (caption, description, transcribed text, concepts) instead of a single `embedding_text`. Improves recall so the right figure surfaces without re-analysis, and de-risks removing the runtime call. Bigger change (`enrichment/retrieval_unit_builder.py`, `production_ranker`) — stage after the ingestion enrichment lands.

### Perceived latency — progressive retrieval / placeholder

Stream an immediate ack ("Reviewing the course materials…") and/or begin streaming text while any remaining image work loads, so perceived latency drops toward zero. UX/orchestration change; complements the above.

### Fallback — cache only if measurement shows residual need

If, after richer ingestion, a measured subset of queries **still** benefits from live, query-specific vision, add a narrow cache **for those cases only** — as a targeted optimization, not a dependency. If we cache, cache **structured facts (the perception schema above), not a prose paragraph**, so downstream prompts pick what they need.

---

## Risks / nuances

- **Re-ingestion cost:** richer ingestion requires an `ENRICHMENT_VERSION` bump + backfill of the existing corpus (compute + an operational run; see the engineering-log note that version bumps trigger reprocessing). One-time and appropriate, but not free.
- **Retrieval coupling:** eliminating runtime vision leans harder on retrieval surfacing the correct figure. Mitigate by keeping the exact figure-reference DB lookup and by multi-field embeddings (phase 2). Step 0's A/B should specifically test whether stored-analysis retrieval matches escalation on figure-reference precision.
- **Structured JSON must be rendered:** don't dump raw JSON into the prompt — render a clean prose/section form (or select fields) for the reasoning context to avoid token bloat and LLM confusion.
- **Eval coupling:** once retrieval is fast, eval (Haiku, ~1.3–2.6 s, currently hidden in parallel) becomes the next pre-token long pole.

---

## Options ranked (revised)

| Option | Latency | Quality | Complexity | Notes |
|---|---|---|---|---|
| Richer ingestion → replace escalation | ★★★★★ | ★★★★★ | Medium | Primary hypothesis. Needs `ENRICHMENT_VERSION` bump + backfill. |
| Rich ingestion + structured JSON (+ transcription) | ★★★★★ | ★★★★★ | Medium-High | Best long-term if validated; folds in transcription + the perception schema. |
| Multi-field embeddings | ★★★★ | ★★★★★ | High | Phase 2; improves recall + de-risks removal. |
| Cache current escalation | ★★★★ | ★★★ | Low-Med | Demoted to targeted fallback only. |
| Reuse current (short) enrichment description | ★★★★★ | ★★ | Very Low | Fast but low quality; a Step-0 comparison arm, not a destination. |
| Switch escalation to Sonnet | ★★ | ★★★★ | Low | Slower (~9–14 s est), not a latency lever. Only sensible paired with the primary. |

Leading hypothesis (pending Step 0): **avoid a runtime cache unless measurement proves it's needed**, and evaluate moving image *perception* into ingestion so runtime does retrieval + interpretation only. If validated, that yields a simpler architecture, one fewer runtime model call, and no cache lifecycle. The measurement decides — this table ranks candidates, not a settled plan.

---

## Other (non-figure) latency levers

- **#2 Output streaming (~9 s):** Sonnet at ~40 tok/s × ~290–390 tokens. Nudge concision + tune `RESPONSE_MAX_TOKENS`, or use Haiku for light modes (greet/hint). Post-first-token, so less painful. Quality tradeoff.
- **Not worth it:** provisioned concurrency on retrieval (cold start only ~750 ms, infrequent) and prompt caching (input only ~250–1100 tokens).

---

## Implementation roadmap (staged — effort proportional to evidence)

Build **Stage 1 only** right now. Everything after is contingent on Stage 1's result.

1. **Stage 1 — Step 0 evaluation (the only near-term build).** Phases 1–3 above — **Phase 1 (harness) done; Phases 2–3 pending.** Build the harness + dataset, prototype arms C/D fully offline, run A/B/C/D on the metrics. Low-risk; touches no production code or data.
2. **Stage 2 — review results.** If richer stored perception matches/exceeds live escalation, commit to the change. If it only helps some scenarios, identify exactly which and scope a hybrid to those. If it doesn't, keep escalation (and we've avoided unnecessary work).
3. **Stage 3 — production architecture (only if Stage 1 validates).** Enrichment prompt + perception schema, `ENRICHMENT_VERSION` bump + corpus backfill, retrieval injects the stored analysis (keep the exact figure-ref lookup), feature-flagged removal of the runtime vision call.
4. **Stage 4 — re-measure & optimize.** With runtime perception gone/minimized, decide whether multi-field embeddings, response-length tuning (#2), or the progressive-UX change are worth it.

Independent track: validate the shipped async-guardrail change in dev (run turns + a blocked-topic prompt), then decide on flipping prod.

---

## Appendix — data provenance

- Log groups: `/aws/lambda/AILA-MultimodalRagStack-chatbotV2Function` (handler + stream timings), `/aws/lambda/AILA-MultimodalRagStack-ragRetrievalFunction` (retrieval + escalation timings).
- Handler: Logs Insights on `event="latency_breakdown"` and `event="stream_latency"` (incl. `streaming_mode`). Escalation: `filter-log-events` on `$.llm_latency_ms` / `$.escalation_latency_ms`.
- Guardrail A/B via the `STREAM_GUARDRAIL_DISABLED` dev diagnostic (prod-gated).
- Key code: `enrichment/vision_service.py` (`VISION_PROMPT`), `reasoning/image_escalation.py` (`_invoke_vision_llm`, `_find_image_by_figure_ref_in_db`), `reasoning/reasoning_engine.py` (`_format_escalation_section`, direct-return path), `flags.py` (`RAG_RETURN_PASSAGES`, `STRICT_IMAGE_ESCALATION`), `cache/` (existing DynamoDB cache pattern).
- Access requires a live SSO session (`vincent.adm-dev2`, `ca-central-1`); pull scoped windows only — logs may hold PII.
