# Multi-Image Reasoning (incl. Figure Comparison) — Spec

**Status:** Proposed — not started. Model + residency **decided** (Claude Sonnet 4.5 via Geo-US CRIS; §4.3/§4.10). Awaiting go-ahead before implementation.
**Area:** `multimodal_rag_v2` (retrieval query analysis, reasoning/image escalation, retrieval handler response), `chatbot_v2` (figure selection + grounding), `cdk/lib` (env vars + one IAM grant). Frontend block rendering: verify only.
**Related:** builds on `cross-module-file-referencing` (scope filtering) and the single-image escalation path already in `reasoning/image_escalation.py` (now Claude Haiku 4.5). Model IDs live in `cdk/lib/constants/bedrock.ts`.
**Refined via** `planning-refinement.md` (5 iterations; final score ~9.4/10). Iter 3 reframed around *multi-image reasoning*; iter 4 pinned Sonnet 4.5 + grounded CDK/IAM; iter 5 phased the SINGLE migration, moved model IDs to injected env, hardened the prompt, and added resolution confidence + reference mapping. Residual risks in §13.

---

## 1. Problem Statement

A student asks: *"Compare figure 2.1 and figure 4.1 and tell me which one does a better job at demonstrating the algorithm."* The current pipeline cannot answer this. It silently answers about **figure 2.1 only**, drops figure 4.1, and returns a description rather than a comparative judgment. Three failures:

1. **Query analysis captures one reference.** `retrieval/query_analyzer.py` uses `_FIGURE_LOOKUP_PATTERN.search(query)` — `.search()` returns only the first match, so `"figure 2.1 and figure 4.1"` collapses to `figure 2.1`. `QueryIntent.figure_reference` is a single `FigureReference | None`.

2. **The vision model never sees two figures together.** `reasoning/image_escalation.py` has `_MAX_ESCALATION_IMAGES = 2`, but `_analyze_images` runs a **separate** vision call per image, and `_invoke_vision_llm` sends one image block per request. For a specific numbered reference, `_find_image_by_figure_ref_in_db` resolves a single image.

3. **No multi-image reasoning; final generator is text-only.** `reasoning/reasoning_engine.py` short-circuits figure-reference queries — returns `image_analyses[0].analysis` verbatim. The chatbot's final Sonnet 4.5 generation is text-only, and `figure_selection.py` `select_figures` attaches **only one** figure for a specific reference.

### What happens today (concrete trace)
`analyze()` extracts `figure 2.1` → escalation analyzes 2.1's image alone → reasoning returns "here is what I can see in Figure 2.1: …" verbatim → chatbot displays figure 2.1 only. Figure 4.1 is never retrieved, analyzed, or mentioned.

### Framing
The capability is **multi-image reasoning**; "comparison" is one prompt mode:

```
Query → extract references → resolve images (+confidence) → ONE multi-image vision call (prompt by intent) → grounding → final LLM
```

Comparison ("which is better") and description ("explain both") share every stage except the prompt. v1 ships two modes; more (summarize-all, diff-only, 3+ figures) are future work.

---

## 2. Goals / Non-Goals

**Goals**
- Parse **all** references in a query (bounded), not just the first.
- Distinguish **multi-image intent** (≥2 references) from **comparison intent** (verb-driven). Separate concepts.
- Resolve each referenced figure to an image (with a **resolution confidence**) and co-present them to a **single multimodal vision call**.
- Select the vision prompt by intent: **COMPARE** (evaluative, scope-limited) or **DESCRIBE_EACH**.
- Ground the final answer via the existing chatbot path; **display all** referenced figures (≤2); **hedge** when resolution is low-confidence.
- Degrade gracefully when one/neither figure resolves.

**Non-Goals (v1)**
- Migrating the SINGLE-image path onto `VisionAnalysis` (deferred — §4.2, §13). v1 leaves it untouched.
- >2 images per answer; prompt modes beyond COMPARE / DESCRIBE_EACH; multi-image for **generic** references ("compare the two diagrams"); cross-encoder changes; frontend redesign; auth/scope model changes.

---

## 3. Requirements

- **R1.** Extract every distinct reference into an ordered, de-duplicated list, bounded by `_MAX_PARSED_REFERENCES` (default 5).
- **R2.** `QueryIntent` exposes `figure_references` (list) while preserving singular `figure_reference` (= first / `None`) for existing consumers.
- **R3.** Two independent flags: `requires_multi_image` (≥2 distinct references) and `requires_comparison` (comparison language **and** multi-image). Comparison MUST NOT be inferred from count alone.
- **R4.** In multi-image mode, escalation resolves each referenced figure (reusing sibling-link + scoped DB-lookup), fetches up to `_MAX_ESCALATION_IMAGES` (2), and issues **one** multimodal vision call, returning a single `VisionAnalysis(mode=MULTI)`.
- **R5.** Prompt selected by intent: COMPARE when `requires_comparison`, else DESCRIBE_EACH (§4.5). The COMPARE prompt MUST scope judgment to visual-communication quality, not algorithm correctness.
- **R6.** The MULTI product is a new `VisionAnalysis` object; the **SINGLE path and its `image_analyses` output are unchanged in v1** (phased migration — §4.2).
- **R7.** Resolved images MUST be surfaced in the response `image_results` (deduped by `retrieval_id`) so the chatbot can display each — including DB-lookup-resolved figures. The wire `image_analyses` for a MULTI query is derived from the resolved images; for SINGLE it is unchanged.
- **R8.** Each resolved reference MUST carry a `resolution_confidence` (HIGH/MEDIUM/LOW) and be recorded in a `reference_mapping` (requested reference → chosen `retrieval_id`). On LOW confidence, grounding MUST instruct the final answer to hedge.
- **R9.** Reasoning MUST NOT short-circuit to a single analysis in multi-image mode; it injects a multi-image section (labeling every figure) into grounding.
- **R10.** `select_figures` attaches all resolved figures for a multi-image query (≤ `_MAX_FIGURES`).
- **R11.** When only one figure resolves, answer about the one found and note the other wasn't located; when none, match today's fallback.
- **R12.** Reference resolution is deterministic and scope-bounded (anchored regex + `scope_filter`); ordering and confidence per §4.6.
- **R13.** Model IDs (`VISION_MODEL_ID` Haiku 4.5, `COMPARISON_VISION_MODEL_ID` Sonnet 4.5) MUST be injected as Lambda env from `cdk/lib/constants/bedrock.ts`; Python holds only defensive defaults (§4.3).

---

## 4. Design

### 4.1 Query analysis — references + two intents (`retrieval/query_analyzer.py`, `models/data_models.py`)

```text
matches = _FIGURE_LOOKUP_PATTERN.finditer(query)                    # was .search()
refs = ordered_unique[(norm_type(m.group(1)), m.group(2)) for m in matches][:_MAX_PARSED_REFERENCES]
intent.figure_references = [FigureReference(t, n) for (t, n) in refs]
intent.figure_reference  = intent.figure_references[0] if refs else None    # back-compat
intent.requires_figure_lookup = bool(refs)
intent.requires_image = intent.requires_image or bool(refs)
intent.requires_multi_image = len(intent.figure_references) >= 2
intent.requires_comparison  = intent.requires_multi_image and _COMPARISON_PATTERN.search(query) is not None
```

`_COMPARISON_PATTERN`: `compare|comparison|versus|vs|difference(s) between|better|worse|best|which (one|is)|stronger|clearer`. `QueryIntent` gains `figure_references: list`, `requires_multi_image: bool`, `requires_comparison: bool` (singular `figure_reference` retained).

> **Why two flags.** "Explain 2.1 and 4.1" / "Summarize 2.1 and 4.1" are multi-image but **not** comparisons; a COMPARE prompt would mis-shape the answer. `requires_multi_image` decides *whether to co-analyze all images*; `requires_comparison` decides *which prompt*. **Graceful degradation:** both images are in the single call regardless of mode, so a missed verb still yields a usable answer.

### 4.2 Vision-analysis model — MULTI only in v1 (`models/data_models.py`)

**Decision (revised per review): phase it.** Add `VisionAnalysis` for the **MULTI** path only; leave the working SINGLE path and its `image_analyses` **untouched** in v1.

```text
class VisionMode(Enum):  SINGLE; MULTI          # SINGLE reserved for the later migration
class ResolutionConfidence(Enum):  HIGH; MEDIUM; LOW

@dataclass
class ResolvedReference:                # audit trail: what was asked → what we picked
    reference: str                      # "Figure 2.1"
    retrieval_id: str
    image_s3_key: str
    confidence: ResolutionConfidence

@dataclass
class VisionAnalysis:                    # MULTI-image product
    mode: VisionMode                     # MULTI in v1
    analysis: str
    confidence: float                    # vision-model confidence
    resolved_images: list[RankedResult]  # full objects for display + image_results union
    reference_mapping: list[ResolvedReference]
    prompt_intent: str                   # "compare" | "describe_each"

@dataclass
class EscalationResult:
    escalation_used: bool
    image_analyses: list[ImageAnalysis] = field(default_factory=list)   # SINGLE — UNCHANGED
    vision_analysis: VisionAnalysis | None = None                       # MULTI — NEW, additive
```

> **Why phased, not unified (asymmetric risk).** A comparison-mode bug affects only users trying the new feature; a single-image-mode bug breaks *every* figure explanation. So v1 minimizes regression surface: SINGLE output is byte-for-byte unchanged, MULTI is purely additive. `reference_mapping` is the debugging record for the predictable failure — "why did it compare the wrong two images?" Full unification onto `VisionAnalysis` is documented, deferred tech debt (§13).

### 4.3 Escalation — resolve + one multimodal call (`reasoning/image_escalation.py`)

Model IDs come from injected env (R13); Python keeps only defaults so tests/local run without env:

```text
VISION_MODEL_ID            = os.environ.get("VISION_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
COMPARISON_VISION_MODEL_ID = os.environ.get("COMPARISON_VISION_MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")
```

New multi-image branch in `escalate()`, before the single-reference strategies, when `requires_multi_image`:

```text
if query_intent and getattr(query_intent, "requires_multi_image", False):
    resolved = []                                   # list[(RankedResult, ResolvedReference)]
    for ref in query_intent.figure_references[:_MAX_ESCALATION_IMAGES]:
        img, conf = self._resolve_figure_image(ref, results, scope_filter)   # §4.6, scoped + deterministic
        if img: resolved.append((img, ResolvedReference(f"{ref.ref_type.title()} {ref.number}",
                                                        img.retrieval_id, img.image_s3_key, conf)))
    if len(resolved) >= 2:
        intent = "compare" if query_intent.requires_comparison else "describe_each"
        text, vconf = self._invoke_vision_llm_multi([r for r,_ in resolved], query, intent,
                                                    low_confidence=any(rr.confidence==LOW for _,rr in resolved))
        return EscalationResult(True, vision_analysis=VisionAnalysis(
            MULTI, text, vconf, [r for r,_ in resolved], [rr for _,rr in resolved], intent))
    if len(resolved) == 1:
        return self._single(resolved[0][0], query, note_missing=True)     # R11 graceful degrade (SINGLE path)
# else fall through to existing single-reference / score-based strategies (UNCHANGED)
```

- `_resolve_figure_image` extracts the **existing** two-step logic (`_find_sibling_linked_images` → `_find_image_by_figure_ref_in_db`) and returns `(RankedResult|None, ResolutionConfidence)`. Same anchored regex + scoping — no new matching rules (R12).
- `_invoke_vision_llm_multi` builds **one** Bedrock message **interleaving** a text label + image block per figure ("Image 1 — Figure 2.1:", image, …) then the mode prompt (§4.5), invoked with `COMPARISON_VISION_MODEL_ID` (Sonnet 4.5). Exactly **one** vision call. `_MAX_ESCALATION_IMAGES=2` retained (multimodal cost grows fast; 2 is the v1 boundary).
- **Model split:** MULTI comparison uses **Sonnet 4.5**; the untouched single-image path uses **Haiku 4.5** (`VISION_MODEL_ID`). Both via Geo-US CRIS (US+Canada, zero data retention — ADR-006), so this inherits the project's residency posture — no new decision. IAM/env wiring in §4.10.

### 4.4 Retrieval handler — additive wire adapter (`retrieval/handler.py`)

SINGLE responses are unchanged. Only the MULTI branch adds behavior:

```text
if escalation_result.vision_analysis:                      # MULTI
    va = escalation_result.vision_analysis
    image_results  = _build_image_results(dedupe_by_retrieval_id(final_results_images + va.resolved_images))  # R7
    image_analyses = [{"image_s3_key": r.image_s3_key} for r in va.resolved_images]  # derive wire shape for chatbot mapping
else:                                                       # SINGLE / none — UNCHANGED
    image_results  = _build_image_results(final_results_images)
    image_analyses = [{"image_s3_key": a.image_s3_key} for a in escalation_result.image_analyses]
```

Fixes the pre-existing gap where a DB-lookup-resolved figure (absent from `final_results`) had no displayable `retrieval_id`. Wire shape unchanged; only the MULTI case derives it.

### 4.5 Vision prompts (the heart of the feature)

Both send **all** images in one call, interleaved with labels. Only the instruction differs.

**COMPARE** (when `requires_comparison`):
```text
You are analyzing figures from course materials to answer a student's question.
You are shown multiple images, each labeled with its figure number (above each image).

The student asked: "<query>"

Compare the figures on how well they VISUALLY COMMUNICATE the subject. Structure your analysis:
1. Per figure: briefly, what it depicts (labels, axes, steps shown).
2. Similarities in how they present the subject.
3. Differences (level of detail, clarity, completeness, what each omits).
4. Strengths and weaknesses of EACH for the student's stated purpose.
5. A direct, justified answer to the student's question, based only on what is visible.

Constraints:
- Judge ONLY visual-communication quality (clarity, labeling, layout, completeness of what is shown),
  NOT the correctness of the underlying algorithm or concept.
- Do NOT assume information from the surrounding course that is not visible in the images.
- Do NOT infer an algorithm's correctness from how a figure looks.
- If the images do not contain enough information to judge, say so rather than guessing.
<if low_confidence>- Note that a referenced figure could not be identified with certainty and invite the student to confirm.</if>
```

**DESCRIBE_EACH** (multi-image, no comparison verb):
```text
... same header + query ...
Describe each figure in turn: what it depicts, key labels/axes/steps, and how it relates to the question.
Do NOT rank or judge the figures against each other unless the student asked. Ground claims in what is visible.
```

The resulting analysis is injected as grounding (§4.7); the chatbot's Sonnet 4.5 writes the final answer. Prompt wording is the primary quality lever, isolated here for tuning.

### 4.6 Reference resolution, ambiguity & confidence

A number can resolve to multiple in-scope units (e.g. the module's own "Figure 2.1" and a cross-module-referenced file's "Figure 2.1"). `_resolve_figure_image` returns the chosen image **and** a confidence:

| Situation | Confidence |
|---|---|
| Sibling-linked match (caption co-occurs with retrieved context) | HIGH |
| Single DB match in scope | HIGH |
| ≥2 candidates, same `module_id` | MEDIUM |
| ≥2 candidates across modules | LOW |

Ordering when >1 candidate: (a) same `module_id` as query context, then (b) retrieval rank; take the top deterministically. All lookups pass the same `scope_filter` (isolation from `cross-module-file-referencing` preserved). On any LOW (or overall-low) resolution, the grounding section (§4.7) instructs the final answer to hedge rather than confidently compare a possibly-wrong image. `reference_mapping` records every requested→chosen decision for debugging/observability.

### 4.7 Reasoning — multi-image grounding, no short-circuit (`reasoning/reasoning_engine.py`)

```text
va = escalation_result.vision_analysis
if va and query_intent.requires_multi_image:
    section = _format_multi_image_section(va)     # labels all figures (from reference_mapping);
                                                  # COMPARE vs DESCRIBE heading; prepends an
                                                  # ambiguity note if any ResolvedReference is LOW
    inject section into answer/passages → reaches chatbot Sonnet 4.5 as grounding
elif figure_reference set and image_analyses present:
    ... existing single-figure short-circuit (UNCHANGED) ...
```

Reasoning's own `_invoke_llm`/`_build_messages` stay text-only — the visual reasoning already happened in §4.3.

### 4.8 Chatbot — attach all figures (`chatbot_v2/src/figure_selection.py`)

When the query has ≥2 references (or escalation resolved ≥2 images), attach **all** resolved figures ≤ `_MAX_FIGURES` instead of collapsing to one. The existing key-matching loop over `image_results` already handles N images — only the single-figure cap for the multi-reference case is removed. `main.py` unchanged: grounding + `assemble_blocks` already take a list.

### 4.9 Edge cases

| Case | Behavior |
|---|---|
| One of two figures not found | Analyze the found one; note the other wasn't located (R11). |
| Neither found | Current text answer / "couldn't find". |
| >2 references | Resolve first 2 distinct; answer states only two were considered. |
| Same figure twice ("2.1 vs 2.1") | De-duped → 1 reference → not multi-image → existing single path. |
| Multi-image, no comparison verb | DESCRIBE_EACH; both figures shown. |
| Same number in ≥2 in-scope files | §4.6 deterministic pick + confidence (MEDIUM/LOW) + hedge. |
| Query stuffed with "figure" tokens | `_MAX_PARSED_REFERENCES` bounds lookups (abuse guard). |

### 4.10 Model + IAM + env wiring (CDK)

Follows the "Adding a Bedrock Model" checklist in `cdk-conventions`; the Claude 4.5 upgrade already did most of it.

- **Model def** — reuse `SONNET_45` / `HAIKU_45` in `cdk/lib/constants/bedrock.ts` (single source of truth). No new constant.
- **Env injection (R13)** — set `environment: { VISION_MODEL_ID: HAIKU_45.profileId, COMPARISON_VISION_MODEL_ID: SONNET_45.profileId }` on the retrieval/reasoning Lambda so Python is unaware of raw IDs and the model is swappable/kill-switchable without a code+image change.
- **Pricing** — Sonnet 4.5 rate already in `pricing.py`; `_normalize_model_id` strips the `us.` prefix before lookup. No change.
- **IAM (the one real delta)** — the retrieval role (`ragRetrievalPolicy` in `multimodal-rag-stack.ts`) grants `crisInvokeResources(HAIKU_45, …)` only; add `...crisInvokeResources(SONNET_45, this.region, this.account)` to the same `bedrock:InvokeModel` statement (inference-profile ARN + FM ARN per Geo-US destination Region). Explicit ARNs, least privilege, no wildcards (`iam-security-policy`).
- **Marketplace** — already present via Haiku 4.5 (Anthropic); confirm, don't duplicate.
- **Tests** — `SONNET_45` ARN assertions + env-var assertions in `cdk/test/iam-policies.test.ts` / stack test.

---

## 5. Data Flow (after change)

```
"compare fig 2.1 and 4.1 …"
  → QueryAnalyzer: figure_references=[2.1,4.1], requires_multi_image=True, requires_comparison=True
  → Escalation: resolve 2.1 + 4.1 (scoped, deterministic, +confidence) → ONE Sonnet-4.5 call (COMPARE prompt)
                → EscalationResult(vision_analysis=VisionAnalysis(MULTI, analysis,
                                   resolved=[2.1,4.1], reference_mapping=[{2.1→id,HIGH},{4.1→id,HIGH}]))
  → Handler: image_results ∪= resolved (deduped); wire image_analyses derived from resolved
  → Reasoning: inject "Visual Comparison of Figure 2.1 and 4.1" (+ hedge if any LOW); no short-circuit
  → Chatbot: select_figures attaches BOTH; Sonnet 4.5 writes evaluative answer from grounding
  → Response: evaluative text + 2 figure blocks
```

---

## 6. Tasks (phased — prove the reasoning path before touching IAM/deploy)

**Phase 1 — Data model + analysis**
- [ ] **T1.** `query_analyzer.py` + `QueryIntent`: `finditer` extraction, dedupe, parse cap; add `figure_references`, `requires_multi_image`, `requires_comparison` (+ `_COMPARISON_PATTERN`); retain singular `figure_reference`. Tests: 2-ref extraction; **"explain 2.1 and 4.1" → multi_image=True, comparison=False**; "compare …" → both True; dedupe; cap; single-ref back-compat.
- [ ] **T2.** `data_models.py`: add `VisionMode`, `ResolutionConfidence`, `ResolvedReference`, `VisionAnalysis` (MULTI); add `EscalationResult.vision_analysis` (**keep `image_analyses`**). Tests: construction/defaults; `reference_mapping` shape.

**Phase 2 — Retrieval resolution**
- [ ] **T7.** `_resolve_figure_image` + confidence ordering (§4.6) in `_find_image_by_figure_ref_in_db`; `reference_mapping`/candidate logging. Tests: same number in two in-scope files → deterministic pick, MEDIUM/LOW confidence; sibling-link → HIGH; >1 candidate logged.
- [ ] **T3.** `image_escalation.py`: multi-image branch; `_invoke_vision_llm_multi` (one interleaved message → Sonnet 4.5 via `COMPARISON_VISION_MODEL_ID`); model IDs from env with defaults (R13); MULTI emits `VisionAnalysis`; **single path untouched (still Haiku 4.5)**. Tests: **one call whose body has 2 image blocks and targets the Sonnet 4.5 profile**; COMPARE vs DESCRIBE_EACH selection; COMPARE prompt contains the scope-limiting constraints (§4.5); one-found degrade (R11); cap-at-2; env-override respected; **SINGLE-path regression**.

**Phase 3 — Grounding**
- [ ] **T5.** `reasoning_engine.py`: `_format_multi_image_section` (labels all figures from `reference_mapping`, COMPARE/DESCRIBE heading, LOW-confidence hedge); suppress short-circuit in multi-image mode; preserve single path. Tests: multi-image output isn't a single verbatim analysis, labels both figures; hedge appears when a reference is LOW; single path unchanged.
- [ ] **T4.** `retrieval/handler.py`: MULTI branch unions resolved into `image_results` + derives wire `image_analyses`; SINGLE branch unchanged. Tests: DB-lookup-resolved figure appears in `image_results`; SINGLE response byte-for-byte unchanged.

**Phase 4 — UI**
- [ ] **T6.** `figure_selection.py`: multi-reference detection; attach all resolved figures ≤ `_MAX_FIGURES`. Tests: 2-ref attaches both `retrieval_id`s; single-ref regression.
- [ ] **T9.** Frontend (verify): chat renderer shows multiple `figure` blocks; minimal fix only if needed (ESLint, no test framework).

**Phase 5 — Infrastructure**
- [ ] **T8.** CDK (`multimodal-rag-stack.ts`): inject `VISION_MODEL_ID` + `COMPARISON_VISION_MODEL_ID` env from `bedrock.ts`; add `crisInvokeResources(SONNET_45, …)` to the retrieval role (today `HAIKU_45` only); confirm Marketplace perms. Add `SONNET_45` ARN + env assertions to `iam-policies.test.ts` / stack test. (Model def + pricing already exist.)
- [ ] **T10.** Manual E2E (post-deploy): distinct Figure 2.1 & 4.1 → comparison (evaluative + both figures); "explain both" (descriptive); one-missing + none-missing; a cross-module duplicate number → confirm hedge.

## 7. Security / Trust Boundary
References are parsed from the query and used only in the existing anchored, `scope_filter`-bounded DB lookup — multi-reference loops the same safe lookup (R12). `_MAX_PARSED_REFERENCES` bounds per-query work. The one new IAM grant is `bedrock:InvokeModel` for `SONNET_45` on the retrieval role via `crisInvokeResources()` (explicit inference-profile + destination-Region FM ARNs, no wildcards — `iam-security-policy`), asserted in `iam-policies.test.ts`. Sonnet 4.5 confirmed `ACTIVE` in ca-central-1. Course/module/file isolation preserved.

## 8. Observability
Structured fields correlated by `query_id` (consistent with existing `bedrock_call` events), from which CloudWatch metrics/Insights derive:
- **Volume:** `multi_image_requests_total`, `comparison_requests_total` (COMPARE) vs describe_each, `sonnet_invocation_count`.
- **Resolution health:** references requested vs resolved, `multi_image_resolution_success_rate` (all resolved), **`multi_image_partial_resolution_rate`** (e.g. requested 2, resolved 1 — the ingestion/caption-coverage signal), `resolution_confidence` distribution, `reference_mapping` (requested→chosen `retrieval_id`).
- **Cost/latency:** single-call latency, avg input/output tokens, est. cost (via `pricing.py`).
Reasoning: multi-image section injected + hedge applied (bools). Chatbot: figures attached count + intent.

## 9. Acceptance Criteria
- **AC-R1/2/3:** `analyze("compare figure 2.1 and figure 4.1 …")` → `figure_references=[2.1,4.1]`, `requires_multi_image=True`, `requires_comparison=True`, `figure_reference==2.1`. `"explain figure 2.1 and figure 4.1"` → `requires_multi_image=True`, `requires_comparison=False`.
- **AC-R4/R6:** Multi-image mode makes exactly **one** vision call whose body has **two** image blocks and uses the Sonnet 4.5 profile; result is one `VisionAnalysis(MULTI)`; `EscalationResult.image_analyses` (SINGLE) is untouched for single/no-ref queries.
- **AC-R5:** COMPARE query uses the compare prompt including the visual-quality/no-correctness constraints; multi-image-without-verb uses DESCRIBE_EACH.
- **AC-R7:** A DB-lookup-resolved figure appears in `image_results` with a resolvable `retrieval_id`; the SINGLE-query wire response is unchanged.
- **AC-R8:** Two in-scope files with the same number → chosen deterministically, confidence MEDIUM/LOW, `reference_mapping` recorded; LOW triggers a hedge in the grounding.
- **AC-R9:** Multi-image reasoning output is not a single verbatim analysis and labels both figures.
- **AC-R10:** `select_figures` returns both `retrieval_id`s (≤ `_MAX_FIGURES`) for multi-image; single-reference returns one.
- **AC-R11:** Only 2.1 present → answer covers 2.1 and notes 4.1 wasn't found; neither → today's fallback.
- **AC-R13:** With `COMPARISON_VISION_MODEL_ID` set, the comparison call targets that id; unset → the Sonnet 4.5 default.

## 10. Test Strategy
pytest, colocated `test_*.py`, factories, `monkeypatch`, deterministic — mock Bedrock and S3 (no network/creds). Critical-path test: mock `invoke_model`, assert the serialized body carries **two** `image` blocks and the Sonnet 4.5 profile id (AC-R4). Plus: mode selection, COMPARE-prompt-constraints presence, confidence/`reference_mapping` + hedge, degrade/cap/none, **SINGLE-path regression (unchanged)**, `image_results` union, env-override. CDK `iam-policies.test.ts` ARN + env assertions (T8). Run: `cd cdk && python -m pytest multimodal_rag_v2/ chatbot_v2/ -v` and `cd cdk && npm test`.

## 11. Rollout
**Additive and wire-compatible.** The single-image path is **untouched** — for single/no-reference queries, `EscalationResult.image_analyses` and the response `image_analyses`/`image_results` are byte-for-byte unchanged (v1 does NOT migrate SINGLE to `VisionAnalysis`; deferred — §13). Only new ≥2-reference queries exercise the additive multi-image path (adds `vision_analysis`, derives its wire fields). No schema change, no migration. The retrieval role IAM grant + env vars (T8) are the only deploy-time delta, gated by the `predeploy` `npm test`. `COMPARISON_VISION_MODEL_ID` repoints to Haiku 4.5 as a kill-switch.

## 12. Refinement log
**Iter 3:** reframed to *multi-image reasoning* (comparison = one mode); split `requires_multi_image` vs `requires_comparison`; unified `VisionAnalysis`; prompt section; ambiguity resolution.
**Iter 4:** pinned Sonnet 4.5 (`SONNET_45` CRIS profile), single-image stays Haiku 4.5; residency resolved (Geo-US + zero-retention, ADR-006); grounded CDK/IAM.
**Iter 5 (this review):**
- **Phased the SINGLE→`VisionAnalysis` migration** — v1 keeps `image_analyses` untouched, adds `VisionAnalysis` for MULTI only (asymmetric-risk argument; §4.2).
- **Model IDs moved to injected Lambda env** from `bedrock.ts` (R13, §4.3/§4.10) — swappable/kill-switch without code+image change.
- **Hardened the COMPARE prompt** — judge visual-communication quality only, no correctness-from-appearance, no off-image assumptions (§4.5).
- **Added `resolution_confidence` + `reference_mapping`** (§4.2/§4.6) with a LOW-confidence hedge.
- **Expanded observability** with resolution-success/partial rates + token/cost metrics (§8).
- **Reordered tasks into 5 phases**; corrected rollout wording to "additive; single path unchanged."

## 13. Residual Risks / Open Items (honest notes)
- **Deferred SINGLE→`VisionAnalysis` migration** is intentional tech debt to protect the load-bearing single-image path; schedule as a follow-up once MULTI is proven.
- **Cost: Sonnet 4.5 ≈ 3× Haiku 4.5/token** ($3/$15 vs $1/$5 per 1M). Bounded — ≥2-reference comparison queries only, one call each; `COMPARISON_VISION_MODEL_ID` kill-switch. Model access + residency **resolved**.
- **Comparison-verb detection is fuzzy** → DESCRIBE_EACH fallback; both images are in the call regardless.
- **Cross-file duplicate figure numbers** can't be perfectly disambiguated; mitigated by deterministic pick + confidence + hedge (no longer a silent wrong answer).
- **Frontend rendering assumed, not verified** (T9).
- **>2 figures capped at 2** (v1); `MULTI` model accommodates raising it later.
- **Figure-level precision inherits ingestion limits** — page images are whole-page fallbacks; multi-figure pages are skipped as ambiguous during caption linking, so a reference may resolve to a page image rather than a tight crop (pre-existing).
