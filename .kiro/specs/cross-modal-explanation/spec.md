# Cross-Modal Explanation (Interpretation of a Reference + Image) — Spec

**Status:** Proposed — not started. Awaiting go-ahead before implementation. Sibling of the shipped **Cross-Modal Grounding** feature (`.kiro/specs/cross-modal-grounding/spec.md`): same resolve → normalize → one-vision-call → section → union → display pipeline, a **different prompt family**. Realizes the "new cross-modal prompt family" seam grounding's §14 reserved.
**Motivation (a real, observed failure):** *"can you analyze table 1.1 and figure 1.1 and tell me what the relationship is and also do a deeper dive?"* is **interpretation, not grounding** — no placement verb, so `requires_cross_modal_grounding` is `False` and it falls to the plain text path, where the model **hallucinated a figure it never saw** (invented curve colors/shapes) and **fabricated table values**. This feature routes exactly that query into one Sonnet 4.5 call shown the real image + real table, with a prompt that forbids inventing values/visuals.
**Scope split:** architecture generalizes the shipped grounding path into a **cross-modal-family-parameterized** path (one execution mode, many families); implementation adds **one family (EXPLANATION)** on the **existing single reference type (TABLE)**. No new model/IAM/Bedrock env.
**Area:** `multimodal_rag_v2` (query analysis; generalize `reasoning/image_escalation.py` + `reasoning/reasoning_engine.py`; `retrieval/handler.py`), `chatbot_v2` (reinforcement), `cdk/lib` (one feature-flag env var), `eval_harness/` (one behavioral faithfulness case). Frontend: none.
**Refined via** `planning-refinement.md` (3 review rounds; self-score ~9.25/10; §12). Residual risks in §13.

---

## 1. Problem Statement

Students routinely ask **relational** questions spanning a structured reference and an image: *"How does Table 3.2 relate to the graph in Figure 4?"*, *"Explain why the curve in Figure 1 looks like that using the data in Table 1"*, *"Analyze the table and the figure and tell me the relationship."* These are not placement ("map X onto the image") requests — they ask the model to **interpret** how two artifacts relate.

Cross-modal **grounding** (shipped) does not fire for them (its trigger needs a placement verb: `map|plot|overlay|mark|…`). So they take the plain text path, where the image is only a caption (or absent) and the table is text — the exact conditions under which the observed response **invented an entire figure** and **misreported the table's numbers**.

### Load-bearing facts (verified — shipped in cross-modal grounding)
- One Sonnet 4.5 vision call co-presenting a rendered reference + an image already exists (`image_escalation.escalate_cross_modal_grounding` / `_invoke_vision_llm_grounding`, `COMPARISON_VISION_MODEL_ID`). No new model/IAM/env.
- `GroundedArtifact` (pure) + `GroundingResolution` (retrieval record), `VisionAnalysis.resolved_artifacts`, the handler union, and chatbot display are in place.
- `render_artifact` and the table resolver (numbered ref → top-retrieved fallback) are reused unchanged.
- **The only things that differ between grounding and explanation are the trigger, the prompt, and the section heading.** Everything structural is identical.

---

## 2. Principles

Inherits grounding's principles (§2.1 fusion-in-one-call, §2.2 retrieval-primacy-squared, §2.5 vision layer is reference-agnostic, §2.6 normalization-before-specialization). Adds:

**2.7 Execution mode ≠ cross-modal family.** Grounding and explanation are the **same execution mode** (one reference + one image → one vision call) with **different prompts**. So there is ONE structural mode — `VisionMode.CROSS_MODAL` — and a separate, typed **`CrossModalFamily`** axis (GROUNDING, EXPLANATION; VERIFICATION, COMPARISON reserved). This prevents `VisionMode` from degrading into a prompt registry as families multiply, and makes the shared path a parameterization, not a fork. (This **migrates** grounding's shipped `VisionMode.CROSS_MODAL_GROUNDING` → `VisionMode.CROSS_MODAL` + `CrossModalFamily.GROUNDING`; grounding behavior is **functionally unchanged** and guarded by the grounding equivalence test — §4.4/§11. The mode value is internal to reasoning and never appears on the wire, so this is a safe refactor.)

**2.8 Faithfulness is enforced in the prompt (and validated by eval, not just unit tests).** The explanation prompt explicitly forbids inventing numbers, data points, axis labels, colors, or curve shapes not present, and requires the model to say when the relationship cannot be determined — directly targeting the observed failure. Unit tests assert the prompt carries these constraints; a **behavioral** faithfulness check (does the model actually obey?) belongs in the eval harness against a real model (§11), since a mocked Bedrock cannot verify obedience.

---

## 3. Goals / Non-Goals

**Goals**
- Detect a **cross-modal explanation** intent: a **relational cue** + a structured-reference signal + an image signal, with **no** placement verb (grounding owns those).
- Route it through the shared cross-modal path with an **EXPLANATION** prompt (Sonnet 4.5), co-presenting the real table + real image, producing a structured relationship analysis.
- Reuse resolution/union/display; hedge on low confidence; degrade gracefully (image-only → escalation; reference-only/neither → text).
- Generalize the shipped machinery while keeping grounding **functionally unchanged**.

**Non-Goals (v1)**
- Other families (VERIFICATION, cross-modal COMPARISON) — future entries on the `CrossModalFamily` axis.
- Non-table reference types (FORMULA/CODE) — inherited from grounding's roadmap.
- A generator-wide faithfulness guard for the *text* path (separate item; this only fixes the cross-modal path).
- Multiple references/images, multimodal embeddings, new model/IAM/residency.

---

## 4. Design (deltas over grounding; everything else reused)

### 4.1 Query analysis — a relational-cue-gated intent (`retrieval/query_analyzer.py`, `models/data_models.py`)

The trigger's weak point is precision: analytical words ("analyze", "explain") are everywhere, unlike grounding's rare placement verbs. So the third gate is a **relational cue**, not a bare analytical verb. To keep it maintainable (the cue set will grow), it is defined as **grouped constants behind a helper**, not one monolithic regex:

```text
# reasoning/query_analyzer.py — conceptual "relational cue", grouped for maintainability.
_RELATIONAL_VERBS      = { relate(s|d)?, relationship, correspond(s|ing)?, consistent, match(es)?,
                           align(s)? with, support(s)?, explain(s)?, illustrate(s)?, reflect(s)?,
                           compare(d)?, comparison, differ(s|ence)?, connection, connect(s)? }
_RELATIONAL_CONNECTIVES = { based on, in light of, versus, vs, using }        # "using" is the weakest — instrumented (§9)
_RELATIONAL_QUESTIONS   = { how (do|does|is|are), why (do|does|is|are), between … and }

def _relational_cue(query) -> str | None:      # returns the matched cue (for telemetry), else None
    # checks each group; adding a cue later is a one-line edit to a set, not a regex rewrite.

requires_cross_modal_explanation = (
    has_reference_signal                        # reused: requires_table / table ref / table-noun
    and has_image_signal                        # reused: requires_image / figure ref / image-noun
    and _relational_cue(query) is not None
    and _GROUNDING_PATTERN.search(query) is None   # placement queries are grounding, not explanation
)
```

`has_reference_signal` / `has_image_signal` are the **same helpers** grounding introduced, so grounding and explanation are mutually exclusive by construction (grounding-first precedence). A bare analytical verb without a cue — "analyze table 3" — cannot fire.

**Trigger examples (pinned as tests — §7 T2):**

| Query | Fires? | Why |
|---|---|---|
| "analyze table 1.1 and figure 1.1 and tell me the relationship" | ✅ | cue "relationship" + table + figure |
| "analyze the graph in chapter 4 using table 2" | ✅ | cue "using" + image + table |
| "explain how table 3 relates to figure 2" | ✅ | "relates"/"how does" + both signals |
| "summarize figure 4 using table 2" | ✅ | cue "using" + figure + table (borderline; watched — §9) |
| "analyze table 3" | ❌ | no image signal, no cue |
| "analyze table 2 and figure 3" | ❌ | names both but NO relational cue (precision over recall) |
| "solve question 5 using table 2" | ❌ | "using" present but no image signal |
| "generate an answer using figure 2" | ❌ | "using" + image but no reference signal |
| "explain how table 2 relates to the chapter" | ❌ | "chapter" is not an image signal |
| "explain the difference between Figure 2 and Figure 3" | ❌ | no table signal |
| "map the values in table 2 onto figure 4" | ❌ (grounding) | placement verb → grounding |

> **Cost/over-trigger is still the dominant risk (§13).** The relational-cue requirement + the two-signal gate are the precision anchors; the matched cue is logged (§9) so telemetry can flag a weak cue (notably "using") that over-fires. If needed, the next knob is requiring an explicit table reference AND figure reference both named. Flag + `COMPARISON_VISION_MODEL_ID` kill-switch bound cost meanwhile.

### 4.2 Data model — one execution mode + a typed cross-modal-family axis (`models/data_models.py`)

```text
class VisionMode(Enum):        SINGLE; MULTI; CROSS_MODAL       # migrate CROSS_MODAL_GROUNDING -> CROSS_MODAL
class CrossModalFamily(Enum):  GROUNDING; EXPLANATION           # VERIFICATION, COMPARISON reserved

@dataclass
class VisionAnalysis:
    ...
    cross_modal_family: CrossModalFamily | None = None   # set for CROSS_MODAL; None for SINGLE/MULTI
```

Named `cross_modal_family` (not `prompt_family`) so it stays scoped to the CROSS_MODAL mode — if SINGLE/MULTI ever grow their own prompt variants, they get their own axis. `GroundedArtifact` / `GroundingResolution` / `resolved_artifacts` are reused unchanged; `prompt_intent` (str) stays for MULTI's `"compare"/"describe_each"` sub-intent. Shared code branches on `mode == VisionMode.CROSS_MODAL` (structural) and on `cross_modal_family` (prompt/heading).

### 4.3 Generalize the shared path (`reasoning/image_escalation.py`)

Extract the family axis from the shipped grounding methods (grounding kept functionally unchanged via thin wrappers so its tests stay green):

```text
escalate_cross_modal(results, query, table_resolution, *, family, query_intent, scope_filter)
    # family ∈ CrossModalFamily; resolves the image, fetches bytes, ONE Sonnet call.
    # -> VisionAnalysis(mode=CROSS_MODAL, cross_modal_family=family, resolved_images/resolved_artifacts, ...)

escalate_cross_modal_grounding(...) -> escalate_cross_modal(..., family=CrossModalFamily.GROUNDING)  # wrapper, unchanged signature

_invoke_vision_llm_cross_modal(image_bytes, key, artifact, query, *, family, low_confidence)
    # SAME message shape; prompt via _cross_modal_prompt(family)

_cross_modal_prompt(query, artifact, family, low_confidence)
    -> _grounding_prompt(...)      if family is GROUNDING       # unchanged
    -> _explanation_prompt(...)    if family is EXPLANATION      # NEW (§4.4)
```

`_resolve_grounding_image`, `_fetch_image`, `_get_media_type`, `render_artifact`, `_MAX_GROUNDING_IMAGES` reused verbatim. The vision layer still consumes only the pure `GroundedArtifact` (2.5/2.6).

### 4.4 The explanation prompt (the crux — structured output, faithfulness-hardened)

```text
You are helping a student understand how a structured reference (such as a table) and an image
from their course materials RELATE to each other.
Above you are given: (1) a structured reference (a <artifact_type>, "<label>"), and (2) an image, each labeled.

The student asked: "<query>"

Structure your answer:
1. What the reference contains — briefly (its columns/rows and what they measure).
2. What the image shows — briefly (axes, legend, labeled series/regions).
3. The relationship between them — how the reference's data corresponds to or is illustrated by the
   image, and vice versa (trends, matches, what one measures about the other).
4. A direct answer to the student's specific question, teaching the connection.

Constraints:
- Use ONLY the values present in the reference and what is ACTUALLY visible in the image.
- Do NOT invent numbers, data points, axis labels, legends, colors, or curve shapes that are not present.
- Do NOT state a numeric value unless it appears in the reference or is clearly visible in the image.
- If the relationship cannot be determined from the supplied reference and image, say so explicitly
  rather than guessing.
- The reference may be truncated (large tables); reason only over the rows shown.
<if low_confidence>- The reference or image may not be the one the student intended; note this and invite them to confirm.</if>
```

The direct antidote to the observed failure (invented curve colors + fabricated latencies): the model sees the real artifacts, is told not to fabricate visual/numeric detail, and to admit when a relationship can't be determined. The explicit 4-part structure produces consistent, teachable output. `_grounding_prompt` is untouched.

> **On "functionally unchanged" grounding:** the refactor must not change grounding's *behavior* — same routing, same family (GROUNDING), same execution path, same section heading, and the grounding prompt still produced by `_grounding_prompt`. We deliberately do NOT promise byte-for-byte prompt text forever (a future typo fix must be allowed); the equivalence test (§11) asserts the functional properties, not string identity.

### 4.5 Orchestration & precedence (`reasoning/reasoning_engine.py`)

```text
structured_comparison → (comparison)
grounding    = _handle_cross_modal(family=GROUNDING)    if requires_cross_modal_grounding      # existing
explanation  = _handle_cross_modal(family=EXPLANATION)  if (grounding is None
                                                           and requires_cross_modal_explanation)  # NEW
escalation   = _handle_escalation(...)                  only if all of the above are None
```

`_handle_cross_modal_grounding` and a new `_handle_cross_modal_explanation` are thin callers of a shared `_handle_cross_modal(..., family)` that resolves the table (reusing `_resolve_grounding_table`) and calls `escalate_cross_modal(..., family=...)`. Gated by `CROSS_MODAL_EXPLANATION_ENABLED`. Degrade ladder identical to grounding; never raises.

### 4.6 Section (`reasoning/reasoning_engine.py`)

Generalize `_format_grounding_section` → `_format_cross_modal_section(va, query_intent)`, heading by `cross_modal_family`:
- GROUNDING → `## Cross-Modal Grounding: <Table> mapped onto <Figure>` (unchanged)
- EXPLANATION → `## Cross-Modal Explanation: relationship between <Table> and <Figure>`

Shared body + low-confidence hedge; EXPLANATION closing instruction: "Answer using ONLY this analysis, the reference content, and what is visible in the image; do not assert values or visual details the sources do not support."

### 4.7 Display union (`retrieval/handler.py`)

`_grounding_resolved_results` checks `mode == VisionMode.CROSS_MODAL` (was `== CROSS_MODAL_GROUNDING`), so BOTH families union their resolved table into `table_results` (image via the already-mode-agnostic `_image_response_parts`). No other handler change.

### 4.8 Chatbot (`chatbot_v2/src/figure_selection.py`)

Generalize `build_grounding_reinforcement` → `build_cross_modal_reinforcement(table_blocks, selected_figures, query)`: fires for a placement verb (grounding) OR a relational cue (explanation) when both blocks are shown, conditional wording ("If a cross-modal analysis appears in the retrieved context above, use it…"). `main.py` swaps the one call. `select_figures`/`select_tables` already attach both blocks for a query naming a figure and a table.

### 4.9 Edge cases (delta over grounding)

| Case | Behavior |
|---|---|
| Relational cue + table + image | Explanation vision call; both blocks shown. |
| Placement verb present | Grounding wins (explanation flag False by construction). |
| Cue + only a table / only an image | Not explanation; text or single-image escalation. |
| Analytical verb but NO cue ("analyze table 2 and figure 3") | Not explanation (precision over recall). |
| Image not in corpus / doesn't resolve | Degrade to text — **cannot prevent hallucination when there is no image** (needs the separate text-path faithfulness guard — §13). |
| Flag off | No explanation branch; behavior == pre-feature. |

### 4.10 CDK / infra

- **No new model / IAM / Bedrock env** — reuses the Sonnet 4.5 grant + `COMPARISON_VISION_MODEL_ID`.
- **One feature flag:** `CROSS_MODAL_EXPLANATION_ENABLED` env on the retrieval Lambda (default OFF in code; set per env). Kill-switch also via `COMPARISON_VISION_MODEL_ID`. CDK assertion test.

---

## 5. Data Flow (the motivating query)

```
"analyze table 1.1 and figure 1.1 and tell me the relationship, and do a deeper dive"
  → QueryAnalyzer: requires_cross_modal_explanation=True (cue "relationship" + table signal + figure
                   signal, no placement verb); requires_cross_modal_grounding=False
  → Reasoning: comparison=None, grounding=None → _handle_cross_modal(family=EXPLANATION):
        table: TableReferenceResolver / top-table → GroundingResolution(GroundedArtifact(TABLE,"Table 1.1",…))
        image: _resolve_grounding_image → Figure 1.1 image (+conf)
        escalate_cross_modal(family=EXPLANATION) → ONE Sonnet-4.5 call:
                   [table text block] + [image block] + [EXPLANATION prompt]
        → VisionAnalysis(mode=CROSS_MODAL, cross_modal_family=EXPLANATION, resolved_images=[Fig1.1],
                         resolved_artifacts=[Table1.1])
  → Reasoning: inject "## Cross-Modal Explanation: relationship between Table 1.1 and Figure 1.1"
  → Handler: image_results ∪= Fig1.1; table_results ∪= Table 1.1 (deduped)
  → Chatbot: both blocks attached; Sonnet writes a 4-part relationship analysis grounded in the REAL artifacts
  → Response: a faithful relationship explanation + the actual table + the actual figure
```

(Caveat: if Figure 1.1 is not in the corpus, explanation can't run and the text path is used — §13.)

---

## 6. Explicitly rejected alternatives

1. **Bare analytical verb as the trigger.** Rejected — "analyze/explain" are ubiquitous; require a **relational cue**. Precision over recall.
2. **Duplicate the grounding path.** Rejected — two structurally identical paths differing only in a prompt is the "family = axis" case (2.7); generalize.
3. **Keep two `VisionMode.CROSS_MODAL_*` values.** Rejected — makes `VisionMode` a prompt registry; use one `VisionMode.CROSS_MODAL` + typed `CrossModalFamily`.
4. **One monolithic relational regex.** Rejected for maintainability — grouped cue sets behind a helper so additions are a one-line edit.
5. **Promise byte-for-byte grounding prompt text.** Rejected — brittle (blocks a future typo fix); promise functional equivalence and test that.
6. **Fix this in the text path (generator faithfulness).** Complementary, not a substitute — the text path never sees the image.

---

## 7. Tasks (single phase; reuse-heavy; TABLE + EXPLANATION family)

- [ ] **T1.** `data_models.py`: migrate `VisionMode.CROSS_MODAL_GROUNDING` → `VisionMode.CROSS_MODAL`; add `CrossModalFamily{GROUNDING,EXPLANATION}`; `VisionAnalysis.cross_modal_family`; `QueryIntent.requires_cross_modal_explanation`. Update grounding's references. Tests: enum/flag defaults; grounding data-model tests updated to CROSS_MODAL + CrossModalFamily.GROUNDING.
- [ ] **T2.** `query_analyzer.py`: grouped `_RELATIONAL_*` cue sets + `_relational_cue` helper (returns matched cue) + `_detect_cross_modal_explanation` (cue + both signals + not grounding). Tests: the full §4.1 example table (11 cases) incl. cue-required negatives and grounding precedence; grounding/comparison flags unchanged.
- [ ] **T3.** `image_escalation.py`: generalize to `escalate_cross_modal(..., family)` + `_invoke_vision_llm_cross_modal(..., family)` + `_cross_modal_prompt` + new `_explanation_prompt`; keep `escalate_cross_modal_grounding`/`_grounding_prompt` as functionally-unchanged wrappers. Tests: explanation call → ONE Sonnet message with a table text block + image block + EXPLANATION prompt (4-part structure + "do NOT invent numbers/colors/curves" + "if the relationship cannot be determined, say so"); **grounding functionally unchanged** (existing grounding tests + equivalence assertion — §11).
- [ ] **T4.** `reasoning_engine.py`: shared `_handle_cross_modal(family)`; `_handle_cross_modal_explanation` wrapper; precedence grounding → explanation → escalation; gate on `CROSS_MODAL_EXPLANATION_ENABLED`. Tests: explanation resolves both → used, escalation skipped; grounding still wins when both flags set; image-only → escalation; reference-only/neither → text; never raises.
- [ ] **T5.** `reasoning_engine.py`: generalize `_format_grounding_section` → `_format_cross_modal_section` (heading by `cross_modal_family`). Tests: EXPLANATION section names table AND figure with the relationship heading; GROUNDING section functionally unchanged; hedge on LOW.
- [ ] **T6.** `retrieval/handler.py`: `_grounding_resolved_results` uses `mode == VisionMode.CROSS_MODAL`. Tests: an EXPLANATION product surfaces its table + figure; grounding + non-cross-modal responses unchanged.
- [ ] **T7.** `chatbot_v2/src/figure_selection.py`: `build_cross_modal_reinforcement` (placement OR relational cue + both blocks); wire in `main.py`. Tests: fires for an explanation query with both blocks; empty without a cue/placement or a missing block; grounding case still fires.
- [ ] **T8.** CDK: `CROSS_MODAL_EXPLANATION_ENABLED` env on the retrieval Lambda + `cdk/test` assertion. (No IAM/model change.)
- [ ] **T9.** Observability: emit `cross_modal_family` + `explanation_trigger_cue` (the matched cue) on the reasoning/query log so §9 metrics (esp. weak-cue over-fire) derive from real data.
- [ ] **T10.** Frontend: none (verify figure + table still render together).
- [ ] **T11.** `eval_harness/`: a behavioral faithfulness case (real model) — an image lacking visible numeric labels + a table → assert the produced explanation introduces **no** numeric value absent from the supplied artifacts (AC-3B). Plus manual E2E: the motivating query (both resolve → faithful 4-part relationship, both blocks); placement query still grounds; cue query with only a table → text; flag off → no explanation.

---

## 8. Security / Trust Boundary
Identical to grounding: query-parsed references drive only anchored, `scope_filter`-bounded lookups; content + image bytes are data (never executed); payload bounded (50 rows / char budget / 1 image). **No new IAM** — reuses the Sonnet 4.5 grant asserted in `iam-policies.test.ts`. Only deploy delta is one feature-flag env var.

## 9. Observability
Correlated by `query_id`, with a family dimension:
- `cross_modal_requests_total{family=grounding|explanation}`, `artifact_type` (v1 `table`), resolution path per modality.
- **`explanation_trigger_cue`** — which relational cue matched (e.g. "relationship" vs "using"), so a weak cue that over-fires is visible and can be dropped.
- Resolution health: reference/image resolved? both/one/none; confidence per modality + overall; what was chosen.
- Vision call: one-call latency, tokens, est. cost; truncated bool; hedge bool.
- **Trigger-tuning (critical for cost):** `explanation_request_rate` (share of all queries), `explanation_partial_resolution_rate`, `explanation_correction_rate` — the signals that say whether the trigger is over-firing and whether to tighten (§4.1).

## 10. Acceptance Criteria
- **AC-1:** All eleven §4.1 trigger cases resolve as tabulated (relational cue required; grounding precedence; two-signal gate). In particular "analyze table 3" and "analyze table 2 and figure 3" → `False`; "analyze how table 3 relates to figure 2" and "analyze the graph using table 2" → `True`.
- **AC-2:** An explanation query makes exactly **one** Sonnet 4.5 vision call whose body carries a reference text block **and** an image block, with the EXPLANATION prompt.
- **AC-3 (prompt, unit):** The explanation prompt contains the 4-part output structure, forbids inventing numbers/data points/axis labels/colors/curve shapes, forbids stating values not present, and requires admitting when the relationship can't be determined.
- **AC-3B (behavioral, eval harness):** Given an image with no visible numeric labels + a table, the generated explanation introduces no numeric value that is absent from the supplied reference/image (run against a real model in `eval_harness/`, not a mocked unit test).
- **AC-4 (grounding functionally unchanged):** Grounding routes to `CrossModalFamily.GROUNDING` via its wrapper, produces `mode == VisionMode.CROSS_MODAL`, uses `_grounding_prompt` (not the explanation prompt) and the grounding section heading. Asserted on these functional properties — not on exact prompt string identity.
- **AC-5:** Precedence: with both flags set (placement + cue), grounding runs and explanation does not.
- **AC-6:** Degrade: image-only → escalation; reference-only/neither → text; `_handle_cross_modal(EXPLANATION)` never raises.
- **AC-7:** The EXPLANATION section labels the table AND the figure with the relationship heading; the resolved table + figure appear in `table_results`/`image_results`.
- **AC-8:** With `CROSS_MODAL_EXPLANATION_ENABLED` unset/false, no explanation branch runs and behavior equals pre-feature.

## 11. Test Strategy
pytest, colocated, deterministic, mock Bedrock + S3. Critical unit tests: ONE-call-with-both-blocks + EXPLANATION-prompt-constraints (AC-2/AC-3); the full trigger table incl. cue-required negatives + grounding precedence (AC-1/AC-5); a **grounding functional-equivalence test** (AC-4) asserting grounding's routing/family/prompt-source/section — NOT byte-for-byte text, so a future grounding-prompt edit doesn't break it; degrade/never-raises (AC-6); handler union + heading (AC-7); flag-off (AC-8); chatbot reinforcement for both families (T7). **Behavioral:** the eval-harness faithfulness case (AC-3B) runs against a real model — the only place model obedience can actually be checked. CDK env assertion (T8). Run: `cd cdk && python -m pytest multimodal_rag_v2/ chatbot_v2/ -v` and `cd cdk && npm test`; eval harness per its own runner.

## 12. Refinement log
- **Round 1 (self, ~9.15):** explanation sibling reusing grounding's pipeline; two-signal gate; grounding-equivalence test.
- **Round 2 (reviewer):** required a relational connector (not a bare analytical verb) with a pinned example table; `VisionMode.CROSS_MODAL` + typed prompt-family axis; 4-part prompt + "cannot determine" instruction.
- **Round 3 — reviewer feedback (this revision):**
  - **Pass 2 (critique):** (a) "byte-for-byte unchanged" is a brittle promise; (b) the relational regex is growing into a maintenance hazard; (c) "using" is a weak cue worth watching; (d) `prompt_family` may be too broad a name; (e) AC-3 only checks prompt strings, not behavior.
  - **Pass 3 (revise):** (a) reframed to **functional** equivalence (routing/family/path/section), tested as such; (b) relational cues → **grouped constant sets behind a `_relational_cue` helper** (returns the matched cue); (c) kept "using" but **instrument the matched cue** (§9 `explanation_trigger_cue`) + flagged it in the example table; (d) renamed `prompt_family` → **`cross_modal_family`** / enum `CrossModalFamily`; (e) split AC-3 into **AC-3 (prompt, unit)** + **AC-3B (behavioral, eval harness)** with a real-model faithfulness case (T11).
  - **Pass 4 (score, ~9.25):** Architecture 9.5 · Production-readiness 9.5 (cue telemetry + eval) · Security 9.5 · Completeness 9.5 · Testability 9.5 (functional-equivalence + behavioral eval) · Simplicity 9 · Cost/perf **8.5** (connector-gated + instrumented; still broader than grounding) · Maintainability 9.75 (grouped cues, scoped family name). Cost remains the honest weak dimension, now instrumented for tuning.

## 13. Residual Risks / Open Items (honest notes)
- **Over-trigger / cost is still the dominant risk.** The relational-cue requirement + two-signal gate cut it materially; the matched-cue telemetry (§9) is how we detect a weak cue (esp. "using") over-firing, with the "both explicit refs" tightening knob + flag + kill-switch as responses.
- **Cannot fix the no-image case.** When no image resolves, explanation degrades to text and the text path can still hallucinate. The **text-path faithfulness guard** (separate item) is the complementary fix.
- **Retrieval primacy squared** (inherited): both artifacts must resolve correctly; mis-selection yields a confident-but-wrong explanation — mitigated by naming both + hedging + the correction metric.
- **Generalization migrates shipped grounding code** (VisionMode value + family field) — mitigated by wrappers + the AC-4 functional-equivalence test; the internal mode value has no wire impact.
- **Fuzzy family boundary.** Comparison-language-without-placement is treated as explanation in v1; the COMPARISON family will reclaim it later.

## 14. Future extensibility
The `CrossModalFamily` axis has two members (GROUNDING, EXPLANATION). **VERIFICATION** and cross-modal **COMPARISON** slot in as additional `CrossModalFamily` values + prompts + a heading, with **no** structural change (same `VisionMode.CROSS_MODAL`, same resolve/union/display) — the four canonical families (ground, explain, verify, compare) all ride one execution mode. Non-table reference types inherit grounding's roadmap; raising the 1+1 cap remains a cap change, not a redesign.
