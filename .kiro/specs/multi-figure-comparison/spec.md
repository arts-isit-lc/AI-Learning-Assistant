# Multi-Image Reasoning (incl. Figure Comparison) — Spec

**Status:** Proposed — not started. Awaiting go-ahead before implementation.
**Area:** `multimodal_rag_v2` (retrieval query analysis, reasoning/image escalation, retrieval handler response), `chatbot_v2` (figure selection + grounding). Frontend block rendering: verify only.
**Related:** builds on `cross-module-file-referencing` (scope filtering) and the single-image escalation path already in `reasoning/image_escalation.py`.
**Refined via** `planning-refinement.md` (3 iterations; final score ~9.2/10). Iteration 3 reframed the feature around *multi-image reasoning* (comparison is one prompt mode) per review feedback. Residual risks in §13.

---

## 1. Problem Statement

A student asks: *"Compare figure 2.1 and figure 4.1 and tell me which one does a better job at demonstrating the algorithm."* The current pipeline cannot answer this. It silently answers about **figure 2.1 only**, drops figure 4.1 entirely, and returns a description rather than a comparative judgment. The failure occurs at three layers:

1. **Query analysis captures one reference.** `retrieval/query_analyzer.py` uses `self._FIGURE_LOOKUP_PATTERN.search(query)` — `.search()` returns only the first match, so `"figure 2.1 and figure 4.1"` collapses to `figure 2.1`. `QueryIntent.figure_reference` is a single `FigureReference | None`, so the multi-figure intent is structurally lost before retrieval runs.

2. **The vision model never sees two figures together.** `reasoning/image_escalation.py` has `_MAX_ESCALATION_IMAGES = 2`, but `_analyze_images` runs a **separate** vision call per image, and `_invoke_vision_llm` sends exactly one image block per request. Two images are analyzed in isolation. For a *specific* numbered reference, `_find_image_by_figure_ref_in_db` resolves a single image and escalation returns one analysis.

3. **No multi-image reasoning, and the final generator is text-only.** `reasoning/reasoning_engine.py` short-circuits figure-reference queries — it returns `image_analyses[0].analysis` verbatim and skips the reasoning LLM. The chatbot's final Sonnet generation (`chatbot_v2/src/main.py`) is text-only. `chatbot_v2/src/figure_selection.py` `select_figures` deliberately attaches **only one** figure for a specific reference. There is no path that reasons over two images at once.

### What happens today (concrete trace)
`analyze()` extracts `figure 2.1` → escalation analyzes 2.1's image alone → reasoning returns "here is what I can see in Figure 2.1: …" verbatim → chatbot displays figure 2.1 only. Figure 4.1 is never retrieved, analyzed, or mentioned.

### Framing
The underlying capability is **multi-image reasoning**, of which "comparison" is one mode. The pipeline is:

```
Query → extract references → resolve images → multi-image vision analysis (prompt selected by intent) → grounding → final LLM
```

Comparison ("which is better") and description ("explain both") share every stage except the prompt. This spec builds that seam and ships two prompt modes; more modes (summarize-all, diff-only, 3+ figures) are future work (§2, §13).

---

## 2. Goals / Non-Goals

**Goals**
- Parse **all** figure/table/algorithm references in a query (bounded), not just the first.
- Distinguish **multi-image intent** (≥2 references → look at all of them) from **comparison intent** (verb-driven → rank/judge them). These are separate concepts.
- Resolve each referenced figure to an image and co-present them to a **single multimodal vision call** so the model sees them together.
- Select the vision prompt by intent: **COMPARE** (evaluative) or **DESCRIBE_EACH** (non-judgmental).
- Produce a grounded answer via the existing chatbot generation path, and **display all** referenced figures (capped at 2).
- Degrade gracefully when only one (or neither) referenced figure resolves, and when a reference is ambiguous across files.

**Non-Goals (v1)**
- More than 2 images per answer (cap at 2 with a user-facing note; raising the cap is future work — the `MULTI` model already accommodates it).
- Prompt modes beyond COMPARE / DESCRIBE_EACH (e.g. summarize-all, difference-only). The mode seam is built so these are additive later.
- Multi-image reasoning for **generic** references with no figure numbers ("compare the two diagrams") — resolving *which* two images is unreliable, so that stays on today's score-based path. Future work.
- Cross-encoder changes; frontend redesign (verify multi-figure rendering only — ESLint-only, no test framework); changes to the authorization/scope model.

---

## 3. Requirements

- **R1.** Query analysis MUST extract every distinct reference into an ordered, de-duplicated list, bounded by `_MAX_PARSED_REFERENCES` (default 5).
- **R2.** `QueryIntent` MUST expose `figure_references` (list) while preserving the singular `figure_reference` (= first element or `None`) for backward compatibility with existing consumers.
- **R3.** `QueryIntent` MUST expose two independent flags: `requires_multi_image` (≥2 distinct references) and `requires_comparison` (comparison language present **and** multi-image). Comparison MUST NOT be inferred from reference count alone.
- **R4.** In multi-image mode, escalation MUST resolve each referenced figure to an image (reusing sibling-link + scoped DB-lookup), fetch up to `_MAX_ESCALATION_IMAGES` (2), and issue **one** multimodal vision call with all images, returning a single `VisionAnalysis(mode=MULTI)`.
- **R5.** The vision prompt MUST be selected by intent: COMPARE when `requires_comparison`, else DESCRIBE_EACH (§4.5).
- **R6.** Escalation output MUST use a single unified `VisionAnalysis` model for both single- and multi-image products (no overloaded optional fields; §4.2).
- **R7.** Resolved images MUST be surfaced in the retrieval response `image_results` (deduped by `retrieval_id`) so the chatbot can display each — including figures found via direct DB lookup rather than ranked results.
- **R8.** The reasoning engine MUST NOT short-circuit to a single analysis in multi-image mode; it MUST inject a multi-image section (labeling every figure) into the grounding that reaches final generation.
- **R9.** `chatbot_v2` `select_figures` MUST attach all resolved figures for a multi-image query (capped at `_MAX_FIGURES`).
- **R10.** When only one referenced figure resolves, the answer MUST cover the one found and explicitly note the other was not located; when none resolve, behavior MUST match today's fallback.
- **R11.** Reference resolution MUST be deterministic and scope-bounded: candidates ordered by (query-context module first, then retrieval rank), top candidate taken, ambiguity logged; all lookups reuse the anchored regex + `scope_filter` (§4.6).

---

## 4. Design

### 4.1 Query analysis — references + two intents (`retrieval/query_analyzer.py`, `models/data_models.py`)

Replace `.search()` with `finditer()`, de-dupe, cap, and set the two independent flags:

```text
matches = _FIGURE_LOOKUP_PATTERN.finditer(query)                    # was .search()
refs = ordered_unique[(norm_type(m.group(1)), m.group(2)) for m in matches][:_MAX_PARSED_REFERENCES]
intent.figure_references = [FigureReference(t, n) for (t, n) in refs]
intent.figure_reference  = intent.figure_references[0] if refs else None    # back-compat (unchanged consumers)
intent.requires_figure_lookup = bool(refs)
intent.requires_image = intent.requires_image or bool(refs)
intent.requires_multi_image = len(intent.figure_references) >= 2
intent.requires_comparison  = intent.requires_multi_image and _COMPARISON_PATTERN.search(query) is not None
```

`_COMPARISON_PATTERN` matches comparison language: `compare`, `comparison`, `versus`, `vs`, `difference(s) between`, `better|worse|best`, `which (one|is)`, `stronger|clearer`. Verb matching is imperfect; the design degrades gracefully (see note below), so we accept false negatives rather than over-invest.

`QueryIntent` additions (`figure_reference` singular retained):
```text
figure_references: list[FigureReference] = field(default_factory=list)
requires_multi_image: bool = False
requires_comparison: bool = False
```

> **Why two flags, not one.** "Explain figure 2.1 and figure 4.1" and "Summarize figures 2.1 and 4.1" are multi-image but **not** comparisons; forcing a COMPARE prompt on them yields a wrong-shaped answer. `requires_multi_image` decides *whether to look at all images in one call*; `requires_comparison` only decides *which prompt*. **Graceful degradation:** because both images are in the single vision call regardless of mode, a missed comparison verb still lets the DESCRIBE_EACH output (and the final LLM) produce a usable, if less pointed, comparison — a false negative is not catastrophic.

### 4.2 Unified vision-analysis model (`models/data_models.py`)

Replace the two ad-hoc fields from the earlier draft with one model used by **both** the single- and multi-image paths:

```text
class VisionMode(Enum):        # structural: how many images this analysis covers
    SINGLE
    MULTI

@dataclass
class VisionAnalysis:
    mode: VisionMode
    analysis: str
    confidence: float
    resolved_images: list[RankedResult]   # carries image_s3_key AND retrieval_id for display + union
    prompt_intent: str = "describe"        # "compare" | "describe_each" | "describe" (observability)

@dataclass
class EscalationResult:
    escalation_used: bool
    vision_analyses: list[VisionAnalysis] = field(default_factory=list)
```

- Single-image escalation (existing behavior) now emits `VisionAnalysis(SINGLE, …, resolved_images=[img])` — one per image, exactly as today, just wrapped. The score-based two-image fallback becomes two `SINGLE` entries.
- Multi-image escalation emits **one** `VisionAnalysis(MULTI, …, resolved_images=[img1, img2])`.
- `resolved_images` carrying `RankedResult`s (not bare keys) makes R7 (the `image_results` union) and display mapping fall out naturally.

> **Trade-off (called out).** Migrating the working single-image path onto `VisionAnalysis` adds regression surface to code that isn't broken. Mitigations: (a) the external retrieval **wire contract is preserved** — the handler still emits an `image_analyses`-shaped list plus `image_results`, derived from `vision_analyses` (§4.4), so `chatbot_v2` needs no contract change; (b) explicit single-path regression tests (T3). If we prefer zero churn on the single path in v1, the alternative is to keep `image_analyses` for SINGLE and add `vision_analyses` only for MULTI — cleaner-later vs safer-now. Recommendation: unify (this section).

### 4.3 Escalation — resolve + one multimodal call (`reasoning/image_escalation.py`)

Add a multi-image branch to `escalate()`, evaluated **before** the single-reference strategies when `query_intent.requires_multi_image`:

```text
if query_intent and getattr(query_intent, "requires_multi_image", False):
    resolved = []                                   # list[RankedResult], deterministic + scoped (§4.6)
    for ref in query_intent.figure_references[:_MAX_ESCALATION_IMAGES]:
        img = self._resolve_figure_image(ref, results, scope_filter)   # extraction of existing logic
        if img: resolved.append(img)
    if len(resolved) >= 2:
        intent = "compare" if query_intent.requires_comparison else "describe_each"
        text, conf = self._invoke_vision_llm_multi(resolved, query, intent)   # ONE call, N image blocks
        return EscalationResult(True, [VisionAnalysis(MULTI, text, conf, resolved, intent)])
    if len(resolved) == 1:
        return self._single(resolved[0], query, note_missing=True)     # R10 graceful degrade
# else fall through to existing single-reference / score-based strategies (now wrapped as SINGLE)
```

- `_resolve_figure_image(ref, results, scope_filter)` extracts the **existing** two-step logic: `_find_sibling_linked_images(results, ref.number)` first, then `_find_image_by_figure_ref_in_db(ref.ref_type, ref.number, scope_filter)`. Same anchored regex (`_build_reference_regex`), same scoping — no new matching rules (R11).
- `_invoke_vision_llm_multi(resolved, query, intent)` builds **one** Bedrock message that **interleaves** a text label and an image block per figure ("Image 1 — Figure 2.1:", image, "Image 2 — Figure 4.1:", image, …), then the mode prompt (§4.5). Claude 3 messages accept multiple image blocks, so this is a single request. Exactly **one** vision call in multi-image mode.
- Model: env-configurable `COMPARISON_VISION_MODEL_ID` (recommend a Claude 3.x Sonnet vision model for evaluative quality; existing Haiku `VISION_MODEL_ID` is an acceptable fallback). Exact id taken from existing generation config (§13 prereq).

### 4.4 Retrieval handler — union + wire-contract adapter (`retrieval/handler.py`)

Build the response from `vision_analyses` while keeping the existing wire shape:
```text
resolved = dedupe_by_retrieval_id(flatten(va.resolved_images for va in vision_analyses))
response["image_results"]   = _build_image_results(dedupe_by_retrieval_id(final_results_images + resolved))   # R7
response["image_analyses"]  = [{"image_s3_key": r.image_s3_key} for r in resolved]   # legacy shape, unchanged for chatbot
```
This fixes the pre-existing gap where a DB-lookup-resolved figure (absent from `final_results`) had no displayable `retrieval_id`. No response-contract shape change.

### 4.5 Vision prompts (the heart of the feature)

Both prompts send **all** images in one call, interleaved with labels. Only the instruction block differs.

**COMPARE** (when `requires_comparison`):
```text
You are analyzing figures from course materials to answer a student's question.
You are shown multiple images, each labeled with its figure number (above each image).

The student asked: "<query>"

Compare the figures. Structure your analysis:
1. Per figure: briefly, what it depicts (labels, axes, steps shown).
2. Similarities in how they present the subject.
3. Differences (level of detail, clarity, completeness, what each omits).
4. Strengths and weaknesses of EACH for the student's stated purpose.
5. A direct, justified answer to the student's question (e.g., which does a better job, and why).
Ground every claim in what is actually visible. If the images are insufficient to judge, say so.
```

**DESCRIBE_EACH** (multi-image, no comparison verb — e.g. "explain both"):
```text
You are analyzing figures from course materials to answer a student's question.
You are shown multiple images, each labeled with its figure number (above each image).

The student asked: "<query>"

Describe each figure in turn: what it depicts, its key labels/axes/steps, and how it relates
to the question. Do NOT rank or judge the figures against each other unless the student asked.
```

The resulting `VisionAnalysis.analysis` is injected as grounding (§4.7); the chatbot's Sonnet writes the final answer from it. Prompt wording is expected to iterate post-launch — it is the primary quality lever, so it is isolated here for easy tuning.

### 4.6 Reference resolution & ambiguity

A referenced number can resolve to multiple in-scope units (e.g. the querying module's own "Figure 2.1" and a cross-module-referenced file that also has a "Figure 2.1"). Resolution (`_resolve_figure_image`, and the ordering inside `_find_image_by_figure_ref_in_db`):

1. Prefer a **sibling-linked** match — a figure whose caption co-occurs with the query's retrieved context (strongest relevance signal).
2. Else DB lookup within `scope_filter`, ordering candidates by **(a)** same `module_id` as the query context, then **(b)** retrieval rank / recency; take the **top** deterministically.
3. Log `references_requested`, `candidates_per_reference`, and the chosen `retrieval_id` when >1 candidate existed, so ambiguous corpora are observable.

Scope isolation from `cross-module-file-referencing` is preserved — every lookup passes the same `scope_filter`, so a number is only ever matched within the student's allowed files. Cross-file duplicate numbers remain an inherent ambiguity (§13).

### 4.7 Reasoning — multi-image grounding, no short-circuit (`reasoning/reasoning_engine.py`)

```text
multi = next((va for va in vision_analyses if va.mode == MULTI), None)
if multi and query_intent.requires_multi_image:
    section = _format_multi_image_section(query_intent.figure_references, multi)   # labels all figures; COMPARE vs DESCRIBE heading
    inject section into answer/passages  → reaches chatbot Sonnet as grounding
elif figure_reference set and SINGLE analysis present:
    ... existing single-figure short-circuit (unchanged) ...
```
The reasoning engine's own `_invoke_llm`/`_build_messages` stay text-only and unchanged — the visual reasoning already happened in §4.3.

### 4.8 Chatbot — attach all figures (`chatbot_v2/src/figure_selection.py`, `src/main.py`)

`select_figures`: when the query has ≥2 references (or escalation resolved ≥2 images), attach **all** resolved figures up to `_MAX_FIGURES` instead of collapsing to one. The existing key-matching loop over `image_results` already handles N images — only the single-figure cap for the multi-reference case is removed. `main.py` is unchanged: `build_figure_grounding` + `assemble_blocks` already take a list; the multi-image analysis arrives via `rag_context` grounding.

### 4.9 Edge cases

| Case | Behavior |
|---|---|
| One of two figures not found | Analyze the found one; answer notes the other wasn't located (R10). |
| Neither found | Fall back to current text answer / "couldn't find". |
| >2 references | Resolve first 2 distinct; answer states only two were considered (bounded cost). |
| Same figure twice ("2.1 vs 2.1") | De-duped → 1 reference → not multi-image → existing single path. |
| Multi-image, no comparison verb ("explain 2.1 and 4.1") | DESCRIBE_EACH prompt; both figures shown. |
| Same number in two in-scope files | §4.6 deterministic resolution + logging. |
| Query stuffed with "figure" tokens | `_MAX_PARSED_REFERENCES` bounds lookups (abuse guard). |

---

## 5. Data Flow (after change)

```
"compare fig 2.1 and 4.1 …"
  → QueryAnalyzer: figure_references=[2.1,4.1], requires_multi_image=True, requires_comparison=True
  → Escalation: resolve 2.1 + 4.1 (scoped, deterministic) → ONE vision call (COMPARE prompt)
                → EscalationResult[ VisionAnalysis(MULTI, analysis, resolved=[2.1,4.1]) ]
  → Handler: image_results ∪= resolved (deduped); image_analyses (legacy shape) derived
  → Reasoning: inject "Visual Comparison of Figure 2.1 and 4.1" section (no short-circuit)
  → Chatbot: select_figures attaches BOTH; Sonnet writes evaluative answer from grounding
  → Response: evaluative text + 2 figure blocks
```

---

## 6. Tasks

- [ ] **T1.** `query_analyzer.py` + `data_models.py` (QueryIntent): `finditer` extraction, dedupe, parse cap; add `figure_references`, `requires_multi_image`, `requires_comparison` (+ `_COMPARISON_PATTERN`); retain singular `figure_reference`. Tests: 2-ref extraction; **"explain 2.1 and 4.1" → multi_image=True, comparison=False**; "compare …" → both True; dedupe; cap; single-ref back-compat.
- [ ] **T2.** `data_models.py`: add `VisionMode` enum + `VisionAnalysis`; change `EscalationResult` to `vision_analyses`. Tests: construction/defaults; enum values.
- [ ] **T3.** `image_escalation.py`: extract `_resolve_figure_image`; add multi-image branch; `_invoke_vision_llm_multi` (one interleaved message, mode-driven prompt from §4.5); wrap single path as `VisionAnalysis(SINGLE)`; `COMPARISON_VISION_MODEL_ID` env. Tests: **single call whose body has 2 image blocks**; COMPARE vs DESCRIBE_EACH prompt selection; one-found degrade (R10); cap-at-2; none-found fallback; **single-image path regression** (behavior unchanged).
- [ ] **T4.** `retrieval/handler.py`: derive `image_results` (union resolved, dedupe) + legacy `image_analyses` from `vision_analyses`. Tests: DB-lookup-resolved figure appears in `image_results` with a resolvable `retrieval_id`.
- [ ] **T5.** `reasoning_engine.py`: multi-image section (`_format_multi_image_section`, COMPARE/DESCRIBE heading, all labels); suppress short-circuit in multi-image mode; preserve single path. Tests: multi-image output is not a single verbatim analysis and labels both figures; single-figure path unchanged.
- [ ] **T6.** `chatbot_v2/src/figure_selection.py`: multi-reference detection (`findall`); attach all resolved figures ≤ `_MAX_FIGURES`. Tests: 2-ref query attaches both `retrieval_id`s; single-ref regression.
- [ ] **T7.** Ambiguity resolution ordering (§4.6) in `_find_image_by_figure_ref_in_db` + candidate logging. Tests: same number in two in-scope files resolves deterministically (own module preferred); >1 candidate is logged.
- [ ] **T8.** CDK: `COMPARISON_VISION_MODEL_ID` env var on the retrieval/reasoning Lambda + `Template.fromStack()` assertion; confirm Bedrock `InvokeModel` IAM already covers the chosen model (no new resource).
- [ ] **T9.** Frontend (verify): chat renderer shows multiple `figure` blocks in one turn; minimal fix only if needed (ESLint, no test framework).
- [ ] **T10.** Manual E2E: doc with distinct Figure 2.1 & 4.1 → comparison query (evaluative answer + both figures); "explain both" (descriptive, both figures); one-missing and none-missing degradations.

## 7. Security / Trust Boundary
References are parsed from the query and used only in the existing anchored, `scope_filter`-bounded DB lookup (`_build_reference_regex` + `_scope_predicate`) — multi-reference loops the same safe lookup (R11). `_MAX_PARSED_REFERENCES` bounds per-query work. No new Bedrock permission (same `InvokeModel`); the comparison model must be enabled for the account/region (§13). Course/module/file isolation from `cross-module-file-referencing` is preserved.

## 8. Observability
Escalation: `requires_multi_image`, `requires_comparison`, prompt intent, references requested/resolved, candidates-per-reference, resolved `retrieval_id`s, model id, single-call latency. Reasoning: multi-image section injected (bool). Chatbot: figures attached count + intent. A requested-vs-resolved gap flags ingestion/caption coverage; a high candidates-per-reference flags corpus ambiguity.

## 9. Acceptance Criteria
- **AC-R1/2/3:** `analyze("compare figure 2.1 and figure 4.1 …")` → `figure_references=[2.1,4.1]`, `requires_multi_image=True`, `requires_comparison=True`, `figure_reference==2.1`. `analyze("explain figure 2.1 and figure 4.1")` → `requires_multi_image=True`, `requires_comparison=False`.
- **AC-R4/6:** Multi-image mode makes exactly **one** vision call whose request body has **two** image blocks; result is one `VisionAnalysis(MULTI)` with two `resolved_images`.
- **AC-R5:** COMPARE query uses the compare prompt; multi-image-without-verb uses DESCRIBE_EACH.
- **AC-R7:** A figure resolved via direct DB lookup (not in ranked results) appears in `image_results` with a resolvable `retrieval_id`.
- **AC-R8:** Reasoning output for a multi-image query is not a single verbatim analysis and labels both figures.
- **AC-R9:** `select_figures` returns both `retrieval_id`s (≤ `_MAX_FIGURES`) for the multi-image query; single-reference returns one.
- **AC-R10:** With only 2.1 present, the answer covers 2.1 and notes 4.1 wasn't found; with neither, behavior matches today.
- **AC-R11:** With the same number in two in-scope files, resolution is deterministic (own module preferred) and the multi-candidate case is logged; no lookup runs without the anchored regex + `scope_filter`.

## 10. Test Strategy
pytest, colocated `test_*.py`, factories, `monkeypatch`, deterministic — mock Bedrock and S3 (no network/creds). Critical-path test: mock `bedrock_client.invoke_model` and assert the serialized body carries **two** `image` blocks for a multi-image query (AC-R4). Plus mode-selection, degrade/cap/none, single-path regression, `image_results` union, and ambiguity-ordering tests. CDK assertion for T8. Run: `cd cdk && python -m pytest multimodal_rag_v2/ chatbot_v2/ -v` and `cd cdk && npm test`.

## 11. Rollout
Additive, backward-compatible — no schema change, no migration. Behavior changes only for queries with ≥2 references (previously mishandled). `COMPARISON_VISION_MODEL_ID` default lets the feature fall back to the existing vision model if a Sonnet vision model isn't enabled; flip to Sonnet once model access is confirmed.

## 12. What changed from iteration 2 (review response)
- Reframed from "figure comparison" to **multi-image reasoning**; comparison is one prompt mode.
- Split `requires_multi_image` (structural) from `requires_comparison` (verb-driven) — fixes mislabeling "explain both" as a comparison (R3).
- Replaced overloaded `EscalationResult` optional fields with a unified `VisionAnalysis` (`SINGLE`/`MULTI`) model (R6, §4.2).
- Added a dedicated vision-prompt section with COMPARE and DESCRIBE_EACH templates (§4.5).
- Added explicit reference-ambiguity resolution (§4.6, R11).

## 13. Residual Risks / Open Items (honest notes)
- **Quality depends on the vision model.** Haiku is weaker at evaluative reasoning than Sonnet; Sonnet needs Bedrock model access (prereq before T3) and costs more. Bounded: fires only on ≥2-reference queries. Env-toggle with Haiku fallback.
- **Comparison-verb detection is fuzzy.** False negatives fall back to DESCRIBE_EACH; acceptable because both images are in the vision call regardless (§4.1 note).
- **Single-image path migration** to `VisionAnalysis` touches working code (regression-tested; wire contract preserved). Alternative low-churn modeling noted in §4.2.
- **Frontend rendering assumed, not verified** (T9).
- **>2 figures capped at 2** (v1) with a user-facing note; `MULTI` model already accommodates raising it.
- **Cross-file duplicate figure numbers** remain inherently ambiguous; §4.6 makes resolution deterministic + observable but cannot disambiguate intent perfectly.
- **Figure-level precision inherits ingestion limits** — page images are whole-page fallbacks and multi-figure pages are skipped as ambiguous during caption linking; a reference may resolve to a page image rather than a tight crop (pre-existing).
