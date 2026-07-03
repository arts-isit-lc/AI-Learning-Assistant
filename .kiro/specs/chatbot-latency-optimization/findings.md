# Chatbot Latency Optimization — Findings, Hypotheses & Evaluation Plan

- Date: 2026-07-02 (revised same day across two review rounds)
- Scope: `chatbot_v2` request flow (structured-learning chatbot) + the `multimodal_rag_v2` retrieval path it calls.
- Framing (evolved): this began as a latency task; the evidence has turned it into a **multimodal-RAG architecture split — perception as an ingestion concern, interpretation as a runtime concern**. After the v2 + Track B pilots this is no longer a hypothesis but the **leading architecture, pending production validation**: runtime vision moves from the primary path to a **rare/defensive fallback**. The one remaining weakness (label-lookup) proved **representational, not architectural** — stored perception simply hadn't preserved enough verbatim text; the transcription-forced ingestion prompt closes it (Track B). The deeper result: **image perception is largely reusable across queries, provided the ingestion representation preserves sufficient fidelity — especially verbatim textual elements.**
- Key insight: **perception is not one capability — different perceptual information has different persistence.** *Persistent* (well-served by stored perception): relationships, objects, charts, concepts, equations. *Exacting* (the failure boundary): verbatim labels, tiny annotations, dense legends. This points to a **semantic (question-type) routing signal** for the fallback — e.g. label-lookup → check transcription / escalate — rather than a model self-confidence estimator.
- Status: async-guardrail fix shipped to dev; Step 0 harness built (v1 + v2) with two **directional offline pilots** run (results below — encouraging, not decision-grade). The figure-architecture changes remain hypotheses pending a scaled, SME-reviewed run. See "Status & progress".
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
  - **[PILOT DONE — directional] Phase 2b — v2 iteration.** Built the v2 harness (categories, failure taxonomy, CIs, hybrid arm E, Haiku judge) and ran a 6-figure × 5-category pilot (result below). Key read: status-quo short description is weak; rich perception + prompt (D/E) ≈ live escalation except on **label-lookup** (the failure boundary); E escalates only ~7%.
  - **[PENDING] Track A — production validation study.** Architecture decision largely made; this validates implementation assumptions under realistic conditions (SME-reviewed questions, calibrated judge, retrieval effects) to reduce deployment risk — not viability. ~20–30 figures × 5 categories. (Label-lookup already addressed by transcription — Track B.)
  - **[PENDING] Production implementation** (design drafted in `production-design.md`; parallel to Track A, not merged yet).
- **[PENDING — only if Step 0 validates] Stage 3 — production architecture:** richer ingestion prompt + perception schema, `ENRICHMENT_VERSION` bump + corpus backfill, retrieval injects the stored analysis, flagged removal of the runtime vision call.
- **[PENDING] Stage 4 — re-measure & optimize:** multi-field embeddings, response-length tuning (#2), progressive-UX.

Naming note: "Phase 1–3" are the sub-steps of Step 0; "Stage 1–4" are the higher-level roadmap below (Stage 1 = Step 0). Everything from Stage 3 down is a hypothesis, not committed work.

---

## Target architecture (leading — pending production validation)

```
                    INGESTION  (once per image)
  Image
    │
    ▼
  Rich perception ──► summary · verbatim OCR/labels · relationships · charts · equations · concepts
    │
    ▼
  Stored structured representation  (perception schema)

                    RUNTIME  (per question)
  Question
    │
    ▼
  Retrieve stored perception ──► Sonnet interpretation ──► Answer
    │
    └── (rare / defensive fallback, feature-flagged)
              ▼
        Runtime vision (live perception)
```

Perception is computed once at ingestion and reused across queries; interpretation stays at runtime; live vision is an exceptional recovery path, not part of the normal request.

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

Confirmed design (v2) — this evaluates a **decision boundary**, not just an architecture:
- **Primary output = per-category matrix** (category × arm), not an aggregate score — that's what reveals where live perception adds unique value.
- **Statistics:** mean + std dev + 95% CI per arm and per category.
- **Failure taxonomy** (biggest addition): the judge classifies each miss — wrong figure, OCR error, missed relationship, hallucinated object, missed equation, prompt misunderstanding, retrieval failure — so we learn *which subsystem* to fix.
- **Question authoring = auto-generate → SME review/edit** (accept / edit / reject), recording the edit rate (if ~95% survive unchanged, that is itself a useful result). A first pass runs with auto (unreviewed) questions for a directional read; SME review finalizes the set.
- **Judge = Haiku** (a different model) on **Sonnet-generated references**, + **human-review of 10–20%** to calibrate. Good enough to decide an architecture change (this is not a paper).
- **Arm E kept deliberately simple — NO confidence *estimator* yet.** Confidence estimation is a separate research problem; conflating it would confound "did stored perception work" with "did the confidence heuristic work." E = a stored-perception answer that ALSO self-reports "I am uncertain because…"; if it flags uncertainty, escalate to live perception and re-answer. The self-report is the inspectable signal.
- **Agreement rate:** for every escalation, record whether it actually *changed* the answer. If most escalations don't change it, that is strong evidence against runtime perception.
- **Cost:** compute query-independent perception (short + rich) **once per figure**, reuse across that figure's questions; only A re-perceives per question.

Scope discipline (does each piece reduce the decision's uncertainty?): category breakdown — yes; hybrid fallback — yes; uncertainty taxonomy — yes; a real confidence *estimator* — not yet.

Decision rule: if rich stored perception (esp. D/E) still matches or beats A across the *hard* categories, move to production as a **feature-flagged hybrid (arm E)** — not an outright removal of runtime vision. If it fails specific categories, that pinpoints exactly what ingestion must capture (e.g., transcription for label-lookup).

### Step 0 — v2 pilot result (2026-07-02, DIRECTIONAL)

6 figures × 5 auto-generated category questions (30 total); per-figure perception reused; **Haiku judge on Sonnet-generated facts**; arms A–E.

Correctness by category (primary output):

| category | A live | B short | C rich | D rich+prompt | E hybrid |
|---|---|---|---|---|---|
| overview | 0.99 | 0.87 | 0.99 | 0.97 | 0.98 |
| label_lookup | 0.92 | 0.75 | 0.75 | 0.73 | 0.67 |
| relationship | 0.99 | 0.33 | 0.82 | 0.92 | 1.00 |
| chart | 1.00 | 0.50 | 0.97 | 1.00 | 1.00 |
| comparison | 0.95 | 0.32 | 0.63 | 1.00 | 1.00 |
| **aggregate** | **0.97** | **0.55** | **0.83** | **0.92** | **0.93** |

Arm E escalated **6.7%** (2/30) and, when it did, changed the answer 100% of the time. Failure taxonomy: B's misses are overwhelmingly `missed_relationship` (×19 — the short description discards structure); that count falls 5→2→1 as perception richens (C→D→E). Label-lookup misses in C/D/E surface as `hallucinated_object` (hallucination D 0.20 / E 0.33) — the stored description lacks the exact label and the model invents one.

Directional reads:
- **Status quo (B, current short description) is inadequate** beyond overview — collapses on relationship (0.33), comparison (0.32), chart (0.50). Enriching ingestion is clearly warranted.
- **Rich perception + a good prompt (D) or the hybrid (E) reaches ~0.92–0.93**, close to live escalation (A 0.97) and *winning* on comparison/chart/relationship.
- **Failure boundary = label lookup.** Stored perception (C/D/E ≈ 0.67–0.75) trails live A (0.92) and hallucinates labels — verbatim transcription in the stored perception isn't precise enough. This is the concrete thing to fix at ingestion (or escalate on).
- **Hybrid (E) is promising:** ~D-level quality while invoking live vision only 6.7% of the time — but it *under-escalated on label-lookup* (its self-report didn't flag it). A hybrid is viable; the routing signal would need to cover label-lookup (a separate confidence problem, deliberately not built yet).
- Cost/latency reconfirm the win: A re-perceives per question (~2350 tok, ~6.3s median); B/C/D/E amortize perception (254–739 tok).

Caveats: n=6 (30 Qs), auto/unreviewed questions, model-bootstrapped facts, Haiku judge (de-biased but still an LLM, uncalibrated); A's live query-aware perception can inflate A; label-lookup reference facts may themselves be imperfect. Directional, not decision-grade.

What it changes: the architecture direction (rich perception at ingestion) looks right for most categories; the open question narrows to **label-lookup fidelity** — fixable with better ingestion transcription, or does it need targeted live-escalation? The scaled run + SME review + judge calibration should resolve exactly that.

### Step 0 — Track B: label-lookup study result (2026-07-02, DIRECTIONAL)

6 figures × dedicated label-lookup Q+A (40 questions; each reference = the exact expected label text); arms compared on label-lookup only; Haiku judge.

| metric | A live | C rich (current) | C transcription | D transcription |
|---|---|---|---|---|
| correctness | 0.975 | 0.950 | 0.950 | 0.975 |
| hallucination | 0.025 | 0.013 | 0.000 | 0.000 |

Reads:
- **On precise label questions, stored perception ≈ live.** All stored arms (0.95–0.975) match live A (0.975), and the transcription-forced prompt additionally drives label **hallucination to 0.00** (vs A 0.025, current-rich 0.013). So better ingestion transcription closes the label gap — **fix it at ingestion; a dedicated label-escalation path is not indicated on this evidence.**
- **Methodology caveat — do NOT compare directly to the v2 pilot's label 0.73.** Track B judges against *exact-answer* references from a dedicated label Q+A generator; the v2 pilot used a *single generic* label question graded against the *broad* fact list. Even current-rich scores 0.95 here, so the v2 pilot's low label number was partly a *measurement artifact* (generic question + broad-facts judging), not purely a perception failure. The "label-lookup failure boundary" is therefore softer than the v2 aggregate implied, and transcription removes what remained.
- Cost/latency reconfirm the win: A re-perceives per question (2177 tok, ~4.9 s median); the transcription arms amortize perception (396–465 tok).

Caveats: n=6 (40 Qs), auto-generated & unreviewed Q+A, uncalibrated Haiku judge, and the reference is the *generator's own* reading of the label (if the generator misread it, the reference is wrong) — SME spot-check needed. Directional.

Implication: transcription at ingestion looks sufficient for labels, strengthening the "rich perception at ingestion + runtime interpretation, rare/targeted fallback" architecture and reducing the case for a label-specific escalation. Track A (SME-reviewed questions + calibrated judge) should confirm.

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

## Roadmap (revised after the v2 pilot)

The architecture direction is largely validated; work now targets the label-lookup exception, in this order:

1. **[DONE] Step 0 evaluation harness (v1 + v2)** — built, tested (63 tests), two directional pilots run.
2. **[doing] Commit the harness + docs** — it is now a reusable project asset; don't leave it uncommitted.
3. **[doing] Judge calibration tooling** — export a 10–20% sample of scored items (question, answer, reference facts, judge verdict) for human review, so the Haiku judge can be calibrated; raises trust in every later run. Tooling added now; the sample is produced on the next run.
4. **[DONE — directional] Improve ingestion transcription + Track B label study.** A transcription-forced perception prompt (`experiment_v2.PERCEPTION_PROMPT_TRANSCRIPTION`) matched live perception on label-lookup (0.95–0.975) and drove hallucination to 0.00 (see "Track B result"). Evidence points to fixing labels at ingestion — no dedicated label-escalation indicated.
5. **Track A — production validation study (renamed from "decision-grade").** The architecture decision is largely made; this run now *validates implementation assumptions under realistic conditions* (SME-reviewed questions, calibrated judge, retrieval effects) to reduce deployment risk — not to decide viability. ~20–30 figures × 5 categories.
6. **Then production:** rich perception at ingestion → structured stored representation → runtime interpretation → **targeted** live-vision fallback only for cases that still need it (routing likely semantic / question-type). `ENRICHMENT_VERSION` bump + corpus backfill; keep the exact figure-ref lookup; flag the change.

Independent track: validate the shipped async-guardrail change in dev (run turns + a blocked-topic prompt), then decide on flipping prod.

---

## Appendix — data provenance

- Log groups: `/aws/lambda/AILA-MultimodalRagStack-chatbotV2Function` (handler + stream timings), `/aws/lambda/AILA-MultimodalRagStack-ragRetrievalFunction` (retrieval + escalation timings).
- Handler: Logs Insights on `event="latency_breakdown"` and `event="stream_latency"` (incl. `streaming_mode`). Escalation: `filter-log-events` on `$.llm_latency_ms` / `$.escalation_latency_ms`.
- Guardrail A/B via the `STREAM_GUARDRAIL_DISABLED` dev diagnostic (prod-gated).
- Key code: `enrichment/vision_service.py` (`VISION_PROMPT`), `reasoning/image_escalation.py` (`_invoke_vision_llm`, `_find_image_by_figure_ref_in_db`), `reasoning/reasoning_engine.py` (`_format_escalation_section`, direct-return path), `flags.py` (`RAG_RETURN_PASSAGES`, `STRICT_IMAGE_ESCALATION`), `cache/` (existing DynamoDB cache pattern).
- Access requires a live SSO session (`vincent.adm-dev2`, `ca-central-1`); pull scoped windows only — logs may hold PII.
