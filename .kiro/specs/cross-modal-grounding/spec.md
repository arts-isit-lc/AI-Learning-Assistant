# Cross-Modal Grounding (Structured Reference + Image, one vision call) — Spec

**Status:** Proposed — not started. Awaiting go-ahead before implementation. Reuses two shipped foundations: the **Multi-Image Reasoning** vision seam (`reasoning/image_escalation.py::_invoke_vision_llm_multi`, `VisionAnalysis`/`VisionMode`, Sonnet 4.5 via `COMPARISON_VISION_MODEL_ID`) and the **Structured Table Comparison** resolution/display seam (`reasoning/reference_resolver.py::TableReferenceResolver`, `ResolvedReferent.structured_content`, `retrieval/handler.py::_table_results_with_comparison`, `chatbot_v2` `select_tables`).
**Scope split (important):** the **architecture** is generalized to *structured reference + image*; the **implementation** ships a **single reference type — TABLE**. A "structured reference" here means a **referenced, resolvable element of the course materials** (a table today; formulas, code, algorithm listings later) — deliberately *not* arbitrary user-supplied JSON/source/XML. Other types fit the same seam later (add a resolver call + a render branch) and each gets its own follow-on spec. This avoids a table-only corner without paying for premature breadth.
**Area:** `multimodal_rag_v2` (query analysis; `reasoning/image_escalation.py` new grounding branch + vision call; `reasoning/reasoning_engine.py` orchestration + grounding; `retrieval/handler.py` display union), `chatbot_v2` (attach image + reference together), `cdk/lib` (one feature-flag env var only). Frontend: verify only (figure + table blocks already render).
**Refined via** `planning-refinement.md` (4 review rounds; latest incorporates reviewer feedback — §12; final self-score ~9.3/10). Residual risks in §13.

---

## 1. Problem Statement

A student asks a question that can only be answered by reading a **structured reference and an image together** — e.g. *"Using the population figures in Table 3.2, mark which regions on the map in Figure 4 are above the median,"* or *"Plot the data points from the results table onto the scatter plot."* The current pipeline cannot do this. It answers with a plausible-sounding narrative that is not actually grounded, because **no code path ever puts a real structured reference and real image pixels in front of the same model.**

### What happens today (verified in code)
The reasoning engine (`reasoning/reasoning_engine.py::_generate_answer_internal`) routes every query into **mutually exclusive** branches, and none fuses a structured reference with image pixels:

1. **Text-only reasoning** — `reasoning/context_builder.py::format_for_prompt` builds `## Tables` (rows rendered as text) and `## Image Descriptions` (the 1–3 sentence caption from ingestion, **not** pixels). The reasoning LLM sees the table data plus a vague description of the image, so it can narrate a loose connection but cannot read positions off the image.
2. **Image escalation** — the only path that sends real pixels to a vision model. `_invoke_vision_llm` sends **one image + the raw query string**; `_invoke_vision_llm_multi` sends **≥2 images + query**, scoped to comparing figures against each other. In **neither** case is any structured reference (table rows, etc.) included.
3. **Structured comparison** — `_handle_structured_comparison` is table-vs-table or formula-vs-formula only; never reference + image.

So a "map the table onto the image" query degrades to either (i) text reasoning with the image reduced to a caption, or (ii) a vision call that sees the image but has none of the table rows. Genuine grounding of structured data onto image content is unsupported.

### The seam is general, not table-specific
The vision model does not care that the structured input is a *table*. It cares that it receives **(a) some rendered structured text and (b) an image**. The durable abstraction is therefore:

```
Structured reference  +  Image  →  one vision call  →  grounded reasoning
```

where the structured reference is a **table today** and could be a **formula, code listing, algorithm, adjacency list, statistical output, …** later. "Reference" (not "artifact") is deliberate: these are elements *referenced in and resolved from the course materials*, which scopes the term away from "can I paste arbitrary JSON/code?". This spec builds that general seam and implements exactly one type (TABLE), because tables already have everything the seam needs (resolver, metadata, rendering, structured content); formulas/code do not and are a separate project (§3, §14).

### Load-bearing facts (verified in code)
- **The multimodal vision seam already exists.** `_invoke_vision_llm_multi` builds **one** Bedrock message that interleaves text-label blocks and image blocks and calls **Sonnet 4.5** (`COMPARISON_VISION_MODEL_ID`). Adding a *text block that carries a rendered structured reference* alongside the image block is a natural extension of this exact message shape.
- **Sonnet 4.5 is fully wired — no new infra.** `cdk/lib/multimodal-rag-stack.ts` injects `COMPARISON_VISION_MODEL_ID: SONNET_45.profileId` on the retrieval Lambda (and `VISION_MODEL_ID: HAIKU_45.profileId`), and grants `crisInvokeResources(SONNET_45, …)` on that role's `bedrock:InvokeModel` statement. `cdk/test/iam-policies.test.ts` asserts both. This feature adds **zero** new model, IAM, or Bedrock env.
- **Table rows are available at query time.** `enrichment/retrieval_unit_builder.py::_build_table_metadata` persists `table_headers`, `table_rows` (capped at 50), and `table_summary` into each TABLE unit's `metadata`; `retrieval/handler.py::_build_table_results` already surfaces them. So a resolved table's real rows can be rendered into the vision call **without a new fetch**.
- **Reference resolution is a reusable protocol.** `TableReferenceResolver.resolve(refs, ranked_results, scope_filter) -> list[ResolvedReferent]` (in `reasoning/reference_resolver.py`, wired into `ComparisonEngine` in `handler.py`) resolves a referenced table to `ResolvedReferent(structured_content={headers, rows, summary}, result=RankedResult, confidence=…)`. A `FormulaReferenceResolver` exists too — evidence the resolver protocol already generalizes across reference types when one is needed.
- **Image resolution is a reusable helper.** `image_escalation.py::_resolve_figure_image` returns `(RankedResult | None, ResolutionConfidence)` via sibling-link → scoped DB lookup; score-based fallback exists.
- **Display seams exist for both.** `chatbot_v2/src/figure_selection.py` has `select_figures` (`_MAX_FIGURES`) **and** `select_tables` (`_MAX_TABLES`) **and** `select_formulas`; `handler.py` has `_image_response_parts`, `_table_results_with_comparison`, `_formula_results_with_comparison` union helpers.

---

## 2. Principles

**2.1 The vision call is the only place fusion happens.** Grounding a structured reference onto an image is inherently visual — it requires the pixels. So the fusion MUST be a **single** multimodal call that receives *both* the rendered reference *and* the image. Two separate calls stitched afterward is exactly today's broken behavior and is explicitly rejected (§6).

**2.2 Retrieval primacy — squared.** Quality is dominated by *identification*: the vision model only ever operates on what retrieval selected. Cross-modal doubles this exposure — **both** the reference **and** the image must resolve correctly, or a capable model still produces a confidently wrong answer. Consequently: resolution is the hard part; every answer **names the reference and image it used**; and confidence is hedged aggressively.

**2.3 Generalize the design, not the V1 implementation.** The data model (`GroundedArtifact`) and prompt are reference-generic. V1 handles exactly one type (TABLE) via direct branches — no registry until a second type exists (§4.3). Adding FORMULA/CODE later is a `render_artifact` branch + a resolver call + a detection signal — never a data-model or API refactor.

**2.4 Additive and reversible.** The single-image and multi-image paths, structured comparison, and text-only reasoning are **untouched**. Grounding is a new, gated branch emitting a new `VisionMode`; disabled, it is as if the feature does not exist.

**2.5 The vision layer is reference-agnostic (layering).** The vision call operates only on the **rendered** reference text and the image; it is intentionally unaware of reference-specific metadata or semantics. All reference-specific knowledge lives in the **resolver** (how to find/load it) and the **renderer** (how to turn `structured_content` into text). The layering is strict:

```
Resolver → GroundedArtifact → Renderer → Vision
```

The message builder, prompt template, `VisionAnalysis`, and handler union never branch on reference type — only `render_artifact` does.

**2.6 Normalization before specialization.** Every structured reference is normalized into a **pure `GroundedArtifact`** *before* it enters the vision pipeline. The vision-pipeline functions (`render_artifact`, `_invoke_vision_llm_grounding`, prompt assembly) consume only `GroundedArtifact` and **never** a resolver/retrieval object (`RankedResult`, `ResolvedReferent`). Retrieval metadata rides separately on `GroundingResolution` (§4.2). This is the core invariant that keeps the pipeline generic — and it is **enforced by the type boundary**, not by convention: `GroundedArtifact` simply has no field through which the vision layer could reach retrieval state.

---

## 3. Goals / Non-Goals

**Goals**
- Detect a **cross-modal grounding** intent (structured-reference signal + image signal + a "place/map/locate onto" relationship).
- Resolve **one** image and **one** structured reference (each scoped, deterministic, with a resolution confidence), normalizing the reference into a `GroundedArtifact`.
- Co-present the rendered reference **and** the image in **one** Sonnet 4.5 vision call with a grounding-specific, reference-generic prompt.
- Inject the analysis as grounding; **display both** the image block and the reference block; **hedge** on low-confidence resolution.
- Degrade gracefully: only an image resolves → existing escalation; only a reference → existing text path; neither → today's fallback.
- Ship the **general seam** with **TABLE as the sole implemented reference type**.

**Non-Goals (v1)**
- Implementing non-table reference types (FORMULA, CODE, …). The seam accommodates them; each is a follow-on spec (§14). Formula grounding in particular needs its own resolver/rendering/serialization work.
- Other cross-modal *prompt families* — **interpretation/explanation** ("explain the diagram using the algorithm"), **verification**, **comparison across modalities**. This feature is **grounding only** (placement). See §4.1 scope boundary.
- Multiple images **and** multiple references in one call (v1 caps at **1 image + 1 reference**; the model is N-way-ready — §4.2/§14).
- Multimodal *embeddings* / CLIP-style pixel indexing at ingestion (large infra change — §6).
- New Bedrock model, new IAM, new residency decision (all reuse Sonnet 4.5 — §4.10).
- Frontend redesign (verify existing figure + table block rendering only).

---

## 4. Design

### 4.1 Query analysis — a grounding intent, scoped narrowly (`retrieval/query_analyzer.py`, `models/data_models.py`)

Grounding is neither image-comparison nor table-comparison. Add a dedicated flag set by **relationship (placement) language + a structured-reference signal + an image signal**:

```text
_GROUNDING_PATTERN = r"\b(map|plot|overlay|locate|mark|place|pinpoint|position|
                        annotate|highlight)\b .* \b(on|onto|in|over|against)\b
                      | \b(on|onto|in|over) the (map|figure|diagram|image|chart|graph|plot)\b"
# (illustrative; final pattern tuned in T2)

has_reference_signal = intent.requires_table or _has_table_reference(query)   # V1: table signals only
                                                                              #  ("table", "table 3.2", "the data/dataset/results")
has_image_signal     = intent.requires_image or bool(intent.figure_reference) # "map", "figure 4", "the plot/diagram/image"

intent.requires_cross_modal_grounding = (
    _GROUNDING_PATTERN.search(query) is not None
    and has_reference_signal
    and has_image_signal
)
```

`QueryIntent` gains `requires_cross_modal_grounding: bool` (and reuses the already-parsed `figure_reference` with `ref_type="table"` for a numbered table reference). When FORMULA is added later, `has_reference_signal` also considers formula signals — no other analysis change.

> **Scope boundary — grounding vs. other cross-modal families.** This feature detects **grounding/placement** ("map these values", "where does this row appear on the figure"). It intentionally **excludes semantic interpretation** ("explain why the graph looks like this using Table 2", "how does this equation relate to Figure 4"), **verification**, and **cross-modal comparison** — genuinely different prompt families. Naming everything `…Grounding` (intent, `VisionMode.CROSS_MODAL_GROUNDING`, section) reserves room for future siblings (`CROSS_MODAL_EXPLANATION`, `…_VERIFICATION`, `…_COMPARISON`) without a rename. Excluding interpretation in v1 is a deliberate boundary, not an oversight (§13).

> **Trigger is intentionally conservative — expected to evolve.** V1 requires an explicit placement verb *plus* both modality signals. Natural phrasings without a clear placement verb — e.g. *"Which points correspond to the values in Table 3.2?"* or *"Show where these values appear on the graph"* — will **not** trigger and fall to existing paths. This is deliberate: favor **precision over recall** so we don't fire costly false-trigger vision calls. The pattern should be tuned from **production telemetry** (§9: request volume, partial-resolution and correction rates), not broadened speculatively. Recall is a known v1 gap (§13).

### 4.2 Data model — normalized artifact vs. resolution record + a new VisionMode (`models/data_models.py`)

The reference is split into a **pure, vision-facing** type and a **retrieval-facing** record so principle 2.6 is enforced structurally:

```text
class VisionMode(Enum):  SINGLE; MULTI; CROSS_MODAL_GROUNDING      # add CROSS_MODAL_GROUNDING

@dataclass
class GroundedArtifact:
    """A structured reference NORMALIZED for the vision pipeline (principle 2.6).

    Pure and retrieval-agnostic: carries ONLY what render_artifact + the message builder
    need. It intentionally does NOT hold a RankedResult — retrieval metadata lives on
    GroundingResolution — so the vision layer cannot reach resolver/retrieval state (2.5/2.6).
    artifact_type REUSES ElementType (the repo's structured-content taxonomy), so FORMULA/CODE
    later are new ElementType values + a render_artifact branch, not a new type here.
    """
    artifact_type: ElementType             # V1: ElementType.TABLE only
    label: str                             # e.g. "Table 3.2"
    structured_content: dict[str, Any] = {}   # e.g. {headers, rows, summary}; the ONLY input to render_artifact

@dataclass
class GroundingResolution:
    """Resolution record: a normalized artifact + the retrieval object it came from + confidence.

    Consumed by orchestration, the display union (§4.7), and observability (§9) — NEVER by the
    vision pipeline. Keeps 'normalized artifact' and 'retrieval metadata' as separate concerns.
    """
    artifact: GroundedArtifact
    ranked_result: RankedResult | None = None
    confidence: ResolutionConfidence = ResolutionConfidence.LOW

@dataclass
class VisionAnalysis:
    mode: VisionMode
    analysis: str
    confidence: float
    resolved_images: list[RankedResult] = []                # existing
    reference_mapping: list[ResolvedReference] = []          # existing (image refs)
    prompt_intent: str = "describe_each"                     # existing; "ground" for CROSS_MODAL_GROUNDING
    resolved_artifacts: list[GroundingResolution] = []       # NEW: resolution records (artifact + retrieval + confidence)
```

A `TableReferenceResolver` returns `ResolvedReferent`; the grounding branch normalizes it into `GroundingResolution(artifact=GroundedArtifact(artifact_type=TABLE, label, structured_content), ranked_result=…, confidence=…)`. The vision call receives only `resolution.artifact`.

### 4.3 Orchestration & precedence (`reasoning/reasoning_engine.py`)

`_generate_answer_internal` gains a **grounding branch between** structured comparison and image escalation:

```text
1. structured_comparison = _handle_structured_comparison(...)          # table/formula compare — UNCHANGED
2. if structured_comparison is None and requires_cross_modal_grounding and CROSS_MODAL_GROUNDING_ENABLED:
       grounding = _handle_cross_modal_grounding(query, ranked_results, query_intent, scope_filter)
   else:
       grounding = None
3. if structured_comparison is None and grounding is None:
       escalation_result = _handle_escalation(...)                      # single/multi image — UNCHANGED
   else:
       escalation_result = grounding or EscalationResult(escalation_used=False)
4. ...format context (branch on VisionMode), invoke/return as today
```

`_handle_cross_modal_grounding` (direct branches — **no registry** in v1):
- **Resolve a reference (V1: TABLE):** call `TableReferenceResolver` (numbered table ref → scoped lookup; else top-scoring TABLE unit in `ranked_results`); normalize the `ResolvedReferent` into a `GroundingResolution` wrapping `GroundedArtifact(artifact_type=TABLE, …)`.
  > *Extension point (documented, not built):* when FORMULA lands, add a second branch resolving via `FormulaReferenceResolver` here. Promote resolver/renderer selection to a small registry only once **2–3** types exist — deferred until a second implementation justifies the indirection (§14).
- **Resolve an image:** `image_escalation._resolve_figure_image` (figure ref) or top-scoring image result.
- If **both** resolve → `image_escalation.escalate_cross_modal_grounding(image_result, resolution.artifact, query, low_confidence)` (the vision call is handed the **pure artifact**, per 2.6) → one Sonnet 4.5 vision call → `EscalationResult(vision_analysis=VisionAnalysis(mode=CROSS_MODAL_GROUNDING, resolved_images=[img], resolved_artifacts=[resolution], prompt_intent="ground"))`.
- If **only the image** resolves → return `None` so step 3 runs existing escalation (graceful).
- If **only the reference** (or neither) → return `None`; text path handles it.
- Never raises (mirrors `_handle_escalation` / `_handle_structured_comparison`).

### 4.4 Grounding vision call — reference-generic (`reasoning/image_escalation.py`)

New `escalate_cross_modal_grounding(...)` + `_invoke_vision_llm_grounding(image, artifact: GroundedArtifact, query, low_confidence)` — a sibling of `_invoke_vision_llm_multi` that accepts a **pure `GroundedArtifact`** (2.6). It renders via `render_artifact` and builds **one** message:

```text
[ {text: "<ARTIFACT_TYPE> — <label>:"},                 # e.g. "TABLE — Table 3.2:"
  {text: render_artifact(artifact)},                     # the ONLY place type matters; V1: table branch (bounded)
  {text: "Image — <figure label>:"},
  {image: <base64 bytes from S3 via _fetch_image>},
  {text: <GROUNDING PROMPT>} ]
```

Invoked with `COMPARISON_VISION_MODEL_ID` (Sonnet 4.5), `max_tokens ≈ 1500`. Exactly **one** vision call. `_MAX_GROUNDING_IMAGES = 1` in v1. Reuses `_fetch_image`, `_get_media_type`, existing base64 handling. **The message builder and prompt never branch on `artifact_type` — only `render_artifact` does (2.5); the vision layer sees plain text + an image.**

**`render_artifact(artifact: GroundedArtifact) -> str`** — a single function:
- `artifact_type == TABLE` → caption + headers + rows, **bounded** (rows already capped at 50 in metadata; also cap total rendered length to a ~6 KB character budget and note truncation in-prompt). This is the one **production-quality** renderer in v1.
- otherwise → a **generic fallback** (a readable dump of `structured_content`, e.g. key/value lines). **This fallback is plumbing only — NOT production-quality rendering.** It exists solely so the abstraction/layering test (§11) can drive a not-yet-specialized type through the pipeline. A reference type is **not** "supported" until it has its own real branch here; traversing the seam via the fallback proves *decoupling*, not *capability*. (See the explicit warning in §14 so a future reader never mistakes "FORMULA flows through the seam" for "FORMULA grounding works.")

**The grounding prompt (primary quality lever, reference-generic, example-led, isolated for tuning):**
```text
You are helping a student use a structured reference (such as a table) together with an image
from their course materials.
Above you are given: (1) a structured reference (a <artifact_type>, "<label>"), and (2) an image, each labeled.

The student asked: "<query>"

Ground the reference onto the image:
1. Briefly state what the image shows (axes, legend, labeled regions/points) and what the reference contains.
2. For each relevant entry in the reference (e.g. each table row), identify where it maps on the image — a region,
   marker, axis position, or label — using ONLY what is visibly present in the image and the reference's content.
3. If an entry cannot be located on the image (no matching label/legend/axis), say so explicitly for that entry.
4. Give a direct, justified answer to the student's question, based only on the reference content and visible image content.

Constraints:
- Use ONLY the provided reference content and what is actually visible in the image.
- Do NOT invent coordinates, positions, or labels the image does not show.
- If the image lacks the labels/legend/axes needed to place the data, state that rather than guessing.
- The reference may be truncated (large tables); if so, ground only the entries shown.
<if low_confidence>- The reference or image may not be the one the student intended; note this and invite them to confirm.</if>
```

### 4.5 Resolution & confidence (§2.2)

Reuse the shipped, scoped, deterministic resolvers unchanged; each produces a confidence carried on the resolution record:
- **Reference (V1 table):** `TableReferenceResolver.resolve` (numbered scoped lookup) with its confidence; top-scoring TABLE `RankedResult` fallback when no reference. Normalized into `GroundingResolution`.
- **Image:** `_resolve_figure_image` (sibling-link → scoped DB lookup) with its HIGH/MEDIUM/LOW confidence; score-based fallback when no figure reference.

The **overall** grounding confidence is the **weaker** of the two. Any LOW → the hedge (§4.4 constraint + §4.6 note). The `GroundedArtifact.label` + the image's `ResolvedReference` record what was chosen (audit/observability). All lookups pass the same `scope_filter` (isolation preserved).

### 4.6 Grounding section (`reasoning/reasoning_engine.py`)

`_format_context_with_escalation` already prepends a section when `vision_analysis is not None`; branch on `mode`:

```text
if mode == CROSS_MODAL_GROUNDING:  section = _format_grounding_section(vision_analysis, query_intent)
elif mode == MULTI:                section = _format_multi_image_section(...)   # UNCHANGED
```

`_format_grounding_section` emits, e.g.:
```text
## Cross-Modal Grounding: Table 3.2 mapped onto Figure 4
The following analysis relates the reference's content to the image (produced by a vision model shown
BOTH the reference and the image — treat its visible-content claims as observed):

<analysis text>

Both the reference and the image are shown below. Answer using ONLY this analysis, the reference content,
and what is visible in the image; do not assert positions the image does not support.
<low-confidence note, if any resolution was LOW>
```

Base text context (`## Tables`, `## Image Descriptions`) still assembles as today; the grounding section is prepended so the generator prioritizes it.

### 4.7 Display union (`retrieval/handler.py`)

Extend the **existing** union helpers so a CROSS_MODAL_GROUNDING product surfaces **both** modalities (deduped):
- `_image_response_parts(...)` → also union `vision_analysis.resolved_images` (as for MULTI) and derive wire `image_analyses`.
- For each `GroundingResolution` in `vision_analysis.resolved_artifacts`, route `resolution.ranked_result` by `resolution.artifact.artifact_type` to the existing per-type builder: `ElementType.TABLE → _build_table_results` (union into `table_results`), and — when added later — `FORMULA → _build_formula_results`. V1 wires only TABLE. Reuses/generalizes `_table_results_with_comparison`.

SINGLE/MULTI/comparison/no-escalation responses are unchanged.

### 4.8 Chatbot — attach image + reference together (`chatbot_v2/src/figure_selection.py`)

The resolved image is in `image_results` and the resolved table in `table_results` (top/prepended by §4.7). `select_figures` and `select_tables` already exist and key off those + the query. Ensure a grounding answer attaches **both** (≤ `_MAX_FIGURES` / `_MAX_TABLES`): a grounding query references both a figure and a table/data, so both selectors already fire; add a small grounding reinforcement so the generator treats the attached figure+reference as the grounded pair. `main.py`/`assemble_blocks` accept lists — unchanged. (When FORMULA is added, `select_formulas` is the parallel hook.)

### 4.9 Edge cases

| Case | Behavior |
|---|---|
| Reference + image both resolve | Grounding vision call; both blocks displayed. |
| Only image resolves | Fall through to existing single/multi image escalation. |
| Only reference resolves | Existing text path (reference as text; no vision call). |
| Neither resolves | Today's fallback answer. |
| >1 reference or >1 image referenced | v1 uses the top/first of each (1+1); answer states only one of each was grounded. |
| Table > 50 rows | Capped at 50 in metadata; prompt notes truncation; ground shown rows only. |
| Image lacks legend/labels | Prompt instructs the model to say entries can't be located rather than fabricate. |
| Ambiguous number in scope (either modality) | Deterministic pick + confidence (MEDIUM/LOW) + hedge (reused). |
| Unsupported reference type implied (e.g. a formula) | Not detected as a table signal in v1 → grounding not triggered → existing paths; correct until FORMULA is added. |
| Interpretation/explanation phrasing (no placement verb) | `requires_cross_modal_grounding` stays False → existing paths (§4.1 boundary). |
| Feature flag off | Branch never taken; identical to pre-feature behavior. |

### 4.10 CDK / infra — one flag, no new grants

- **No new model / IAM / Bedrock env.** Sonnet 4.5 invoke grant + `COMPARISON_VISION_MODEL_ID`/`VISION_MODEL_ID` env already on the retrieval role (verified: `multimodal-rag-stack.ts`, asserted in `iam-policies.test.ts`). The `COMPARISON_VISION_MODEL_ID` kill-switch (repoint to Haiku 4.5) covers this path too.
- **One feature flag:** add `CROSS_MODAL_GROUNDING_ENABLED` env on the retrieval Lambda (mirrors existing optimization flags). Per testing-policy (CDK change → assertion test), add a `cdk/test` assertion that the env var is set.

---

## 5. Data Flow (after change)

```
"Using Table 3.2, mark which regions on the map in Figure 4 are above the median"
  → QueryAnalyzer: requires_cross_modal_grounding=True (placement verb + table signal + figure signal),
                   table ref=Table 3.2, figure_reference=Figure 4
  → Reasoning: structured_comparison=None → _handle_cross_modal_grounding:
        reference: TableReferenceResolver → GroundingResolution(
                       artifact=GroundedArtifact(TABLE, "Table 3.2", {headers,rows,summary}), ranked_result, conf)
        image:     _resolve_figure_image  → Figure 4 image (+conf)
        escalate_cross_modal_grounding(img, resolution.artifact, ...) → ONE Sonnet-4.5 call:
                   [render_artifact(artifact) text] + [image block] + [ground prompt]
        → VisionAnalysis(CROSS_MODAL_GROUNDING, analysis, resolved_images=[Fig4], resolved_artifacts=[resolution])
  → Reasoning: inject "## Cross-Modal Grounding: Table 3.2 mapped onto Figure 4" (+hedge if LOW); no short-circuit
  → Handler: image_results ∪= Fig4; table_results ∪= Table 3.2 (routed by artifact_type; deduped)
  → Chatbot: select_figures + select_tables attach BOTH; Sonnet 4.5 writes the grounded answer
  → Response: grounded text + 1 figure block + 1 table block
```

---

## 6. Explicitly rejected alternatives

1. **Two separate calls (image-only + reference-only) stitched afterward.** This *is* today's failure: neither model sees the other modality, so nothing is grounded. Fusion must be one call (§2.1).
2. **Multimodal / CLIP pixel embeddings at ingestion.** A large ingestion + storage + retrieval change that does not itself enable grounding a reference onto a specific image at answer time. Out of scope; the vision-at-query-time approach reuses shipped seams and delivers now.
3. **OCR the image to text, then reason text-only.** Discards spatial layout — the exact signal grounding needs.
4. **Sending the full, uncapped reference.** Unbounded payload/cost; bounded by the 50-row metadata cap + a character budget.
5. **A resolver/renderer registry in v1.** Premature indirection before a second reference type exists; v1 uses direct branches and promotes to a registry only at 2–3 types (§4.3, §14).
6. **A single `GroundedArtifact` carrying its `RankedResult`.** Rejected: it would put a retrieval object on the type the vision layer consumes, violating 2.6 by convention rather than by construction. Split into `GroundedArtifact` (pure) + `GroundingResolution` (retrieval record) so the invariant is type-enforced. Cost: one extra small dataclass — accepted.
7. **Implementing all reference types now (formula/code).** Rejected for V1: formula grounding needs its own resolver/rendering/serialization; premature breadth. The seam is built; each type is a follow-on (§14).

---

## 7. Tasks (single phase — no new infra beyond one flag; TABLE reference only)

- [ ] **T1.** `data_models.py`: `VisionMode.CROSS_MODAL_GROUNDING`; `GroundedArtifact` (pure: artifact_type=ElementType, label, structured_content); `GroundingResolution` (artifact + ranked_result + confidence); `VisionAnalysis.resolved_artifacts: list[GroundingResolution]`; `QueryIntent.requires_cross_modal_grounding`. Tests: construction/defaults; `GroundedArtifact` has no retrieval field; SINGLE/MULTI back-compat.
- [ ] **T2.** `query_analyzer.py`: `_GROUNDING_PATTERN` + `has_reference_signal`/`has_image_signal`; set `requires_cross_modal_grounding`. Tests: "map Table 3.2 onto Figure 4" → True; "compare figure 2.1 and 4.1" → False (no reference); "show table 3.2" → False (no image/placement); "explain the diagram using table 2" → False (interpretation, no placement verb — §4.1); a no-placement-verb near-miss ("which points correspond to Table 3.2?") → False (documents the conservative gap); multi-image/comparison flags unchanged.
- [ ] **T3.** `image_escalation.py`: `escalate_cross_modal_grounding` + `_invoke_vision_llm_grounding(..., artifact: GroundedArtifact, ...)` (one message: `render_artifact` text block + image block + ground prompt → Sonnet 4.5; `_MAX_GROUNDING_IMAGES=1`); `render_artifact` (TABLE branch, bounded, + plumbing-only generic fallback). Tests: **one `invoke_model` call whose body contains BOTH a reference-bearing text block AND an image block, targeting the Sonnet 4.5 profile**; prompt is reference-generic and contains the "only what's visible / don't invent coordinates" constraints; table render bounds/truncation note; low-confidence note when flagged; SINGLE/MULTI untouched.
- [ ] **T4.** `reasoning_engine.py`: `_handle_cross_modal_grounding` (direct table resolution → normalize to `GroundingResolution`; resolve image; pass `resolution.artifact` to the vision call; both→grounding, image-only→None→existing escalation, else→None); precedence between structured comparison and escalation; gate on `CROSS_MODAL_GROUNDING_ENABLED`. Tests: both resolve → grounding used, escalation skipped; image-only → escalation; reference-only/neither → text; never raises.
- [ ] **T5.** `reasoning_engine.py`: `_format_grounding_section` + mode branch; no short-circuit. Tests: section labels the reference AND figure, isn't a verbatim single analysis, hedge on LOW; MULTI/SINGLE formatting unchanged.
- [ ] **T6.** `retrieval/handler.py`: extend `_image_response_parts` + generalize `_table_results_with_comparison` to union CROSS_MODAL_GROUNDING `resolved_images` + `resolved_artifacts` (route `resolution.ranked_result` by `resolution.artifact.artifact_type`; V1: TABLE→`_build_table_results`). Tests: resolved figure and table both present; non-grounding responses byte-for-byte unchanged.
- [ ] **T7.** `chatbot_v2/src/figure_selection.py`: ensure a grounding answer attaches the resolved figure **and** table (≤ caps) + grounding reinforcement. Tests: figure + table `retrieval_id`s both attached; single-modality regressions unchanged.
- [ ] **T8.** CDK (`multimodal-rag-stack.ts`): add `CROSS_MODAL_GROUNDING_ENABLED` env on the retrieval Lambda. Tests (`cdk/test`): env-var assertion. (No IAM/model change — Sonnet 4.5 already granted + asserted.)
- [ ] **T9.** Frontend (verify): chat renderer shows a figure block and a table block in one answer; ESLint-only fix if needed (no test framework).
- [ ] **T10.** Manual E2E (post-deploy): table+map both resolve (grounded answer + both blocks); image-only (degrades to escalation); table-only (text); image without legend (model declines to fabricate); interpretation phrasing (not triggered); flag off (no grounding).

---

## 8. Security / Trust Boundary
References parsed from the query drive only the anchored, `scope_filter`-bounded lookups (course/module/file isolation preserved); reference content and image bytes are treated as **data** (rendered/encoded, never executed — no `eval`). Reference payload bounded by the 50-row metadata cap + a character budget; images bounded to 1. **No new IAM**: the Sonnet 4.5 `bedrock:InvokeModel` grant already exists on the retrieval role (verified in `multimodal-rag-stack.ts`, asserted in `iam-policies.test.ts`) via `crisInvokeResources(SONNET_45, …)` with explicit inference-profile + FM ARNs (no wildcards). The only deploy delta is one feature-flag env var.

## 9. Observability
Correlated by `query_id`:
- **Volume:** `cross_modal_grounding_requests_total`; `artifact_type` used (V1 always `table`); resolution path per modality (referenced vs. top-result fallback).
- **Resolution health:** reference resolved? image resolved? both/one/none; `resolution_confidence` per modality + overall; what was chosen (reference label + image `retrieval_id`).
- **Vision call:** one-call latency, input/output tokens, est. cost (via `pricing.py`); reference-truncated bool; low-confidence-hedge bool.
- **Trigger tuning (§4.1):** `cross_modal_partial_resolution_rate` (one modality missing) and a planned `cross_modal_correction_rate` (student corrects the chosen reference/image) are the highest-value retrieval-quality signals given §2.2; together with request volume they are the telemetry that should drive any future broadening of the (deliberately conservative) trigger. The `artifact_type` dimension lets these be sliced per type once more are supported.

## 10. Acceptance Criteria
- **AC-1:** `analyze("map Table 3.2 onto the map in Figure 4")` → `requires_cross_modal_grounding=True`; `analyze("show table 3.2")`, `analyze("compare figure 2.1 and 4.1")`, and `analyze("explain the diagram using table 2")` → `False`; existing flags unchanged.
- **AC-2:** When both resolve, exactly **one** vision call is made whose serialized body contains **both** a reference-bearing text block **and** an image block and targets the **Sonnet 4.5** profile.
- **AC-3:** The ground prompt is reference-generic (leads with "a structured reference such as a table") and includes the "use only visible content / do not invent coordinates / say when an entry can't be located" constraints.
- **AC-4:** Image-only resolution falls through to existing escalation (unchanged output); reference-only/neither → existing text/fallback; `_handle_cross_modal_grounding` never raises.
- **AC-5:** Grounding section names the reference **and** the figure and is not a verbatim single-image analysis; a LOW resolution (either modality) triggers a hedge.
- **AC-6:** The resolved figure appears in `image_results` and the resolved table (routed by `artifact_type`) in `table_results` (deduped); non-grounding responses byte-for-byte unchanged; SINGLE/MULTI/comparison paths untouched.
- **AC-7:** The chatbot attaches both the figure and the table block for a grounding answer; single-modality behavior unchanged.
- **AC-8:** With `CROSS_MODAL_GROUNDING_ENABLED` unset/false, no grounding branch runs and behavior equals pre-feature.
- **AC-9 (abstraction/layering):** `GroundedArtifact` is pure (no retrieval field); the vision-pipeline functions (`render_artifact`, `_invoke_vision_llm_grounding`) accept only a `GroundedArtifact`; the message builder, prompt template, `VisionAnalysis`, and handler union signature never branch on reference type. Adding `FORMULA` is a `render_artifact` branch + a resolver call + a detection signal — with **no** edits to `VisionAnalysis`, the handler union signature, or the prompt template. Proven by the abstraction test (§11).

## 11. Test Strategy
pytest, colocated `test_*.py`, deterministic, mock Bedrock + S3 (no network/creds). Critical-path test: mock `invoke_model`, assert the body carries **both** a reference text block and an `image` block and the Sonnet 4.5 profile id (AC-2). Plus: intent positive/negative incl. the interpretation-exclusion and conservative near-miss cases (AC-1), prompt reference-generic wording + constraints (AC-3), resolution both/one/none + degrade (AC-4), grounding labels + hedge (AC-5), handler union routed by type + non-grounding regression (AC-6), chatbot both-attached (AC-7), flag-off (AC-8). **Abstraction/layering test (AC-9):** a pure `GroundedArtifact(artifact_type=FORMULA)` with sample `structured_content` renders via `render_artifact`'s plumbing-only fallback and flows through `_invoke_vision_llm_grounding`'s message assembly and `VisionAnalysis` unchanged — proving no table coupling in the vision/model/handler layers. The test asserts **decoupling only** and is annotated that it does NOT imply FORMULA grounding is implemented (FORMULA *resolution* + a real renderer remain unbuilt). Reuse factories (`_make_table_element`, image/ranked fixtures) and the resolver fake-cursor pattern. CDK env assertion (T8). Run: `cd cdk && python -m pytest multimodal_rag_v2/ chatbot_v2/ -v` and `cd cdk && npm test`.

## 12. Refinement log
- **Round 1 — Pass 1–4 (self, ~9.1):** grounding branch resolving a table + image into one Sonnet call; degrade ladder, payload caps, precedence, conservative trigger, CDK flag assertion. Weakest dim: cost (intrinsic, bounded).
- **Round 2 — reviewer feedback:** *generalize the abstraction from table to structured artifact, ship tables only.* Introduced `GroundedArtifact` + `resolved_artifacts`; per-type renderer/resolver registry; reference-generic prompt; grounding-vs-interpretation scope boundary; AC-9 abstraction test. Implementation stayed table-only.
- **Round 3 — reviewer feedback:** removed the premature registry (direct branches + single `render_artifact` w/ fallback); renamed "artifact"→"structured reference" (+ scope note); example-led prompt; added principle 2.5 (layering).
- **Round 4 — reviewer feedback (this revision):**
  - **Pass 2 (critique):** flagged (a) `GroundedArtifact.result` **mixing concerns** — a retrieval object on the vision-facing type, which makes 2.5/2.6 convention-only; (b) the generic fallback could be **misread as production** ("FORMULA works"); (c) the trigger's placement-verb reliance **misses natural phrasings** and lacked a telemetry note; (d) the layering deserved an explicit **normalization** invariant.
  - **Pass 3 (revise):** (a) split into pure `GroundedArtifact` + `GroundingResolution` (retrieval record); the vision pipeline now takes only the pure artifact, making 2.6 **type-enforced** (also §6.6 rejected-alt); (b) labeled the fallback **plumbing-only, not production**, in §4.4/§11/§14 with an explicit "does not imply the type works" warning; (c) added a **conservative-trigger note** (§4.1) with near-miss examples + a telemetry-driven-evolution pointer (§9), and a near-miss test (T2); (d) added principle **2.6 Normalization before specialization**. 
  - **Pass 4 (score, ~9.3):** Architecture 9.5 (invariant now structural) · Production-readiness 9 · Security 9.5 · Completeness 9.5 · Testability 9.5 · Simplicity 9 (one extra dataclass — justified by 2.6) · Cost/perf 8.5 (unchanged; intrinsic) · Maintainability 9.75. Weakest dim remains cost — intrinsic and bounded; loop stops at present-for-approval.

## 13. Residual Risks / Open Items (honest notes)
- **Double retrieval primacy (dominant risk, §2.2).** Both the reference and the image must be identified correctly — more failure surface than any single-modality feature. Top-result fallbacks *will* mis-pick when retrieval mis-ranks, producing a confidently wrong grounding. Mitigated (name both chosen items + confidence + hedge + planned correction metric) but **not eliminated**; durable fix is better identifier injection at ingestion.
- **Conservative trigger → recall gap.** The placement-verb + two-signal trigger favors precision; natural phrasings without a placement verb ("which points correspond to Table 3.2?", "show where these values appear on the graph") are missed and get today's weaker paths. Intentional for v1; broaden only from telemetry (§4.1, §9).
- **Vision spatial grounding is imperfect.** A map/plot without a legend, axes, or labels may not be groundable; the prompt instructs the model to decline rather than fabricate, but quality varies by image.
- **Grounding-only scope.** Interpretation/explanation/verification/comparison across modalities are excluded by design (§4.1). Users *will* ask interpretation questions; those get today's paths until a sibling family ships.
- **Cost/latency.** Adds one Sonnet 4.5 vision call (plus the chatbot's existing generation) for grounding queries only; bounded by gating, the 1-image/1-reference cap, the payload budget, and the `COMPARISON_VISION_MODEL_ID` kill-switch.
- **Truncated references.** The 50-row cap means large tables are only partially grounded; surfaced in-prompt.
- **Whole-page image fallback (inherited ingestion limit).** The "image" may be a whole page rather than a tight figure crop, weakening precision.
- **Formula is the obvious next type but non-trivial.** It needs a formula resolver + LaTeX rendering/serialization; deliberately deferred to its own spec (§14) so V1 proves the grounding infrastructure first.

## 14. Future extensibility (seam is explicit; indirection deferred)
- **New reference type (FORMULA, CODE, adjacency list, stats output, …):** add the `ElementType`, add a **real** `render_artifact` branch (do **not** ship on the plumbing-only fallback — see the warning below), resolve via the type's resolver in `_handle_cross_modal_grounding`, and extend `has_reference_signal`. No change to `VisionAnalysis`, the handler union signature, or the prompt template (guaranteed by AC-9). **Once 2–3 types exist,** promote resolver/renderer selection to a small registry — the indirection deliberately deferred at one type.
  > ⚠️ **The generic fallback renderer is not production rendering.** A `GroundedArtifact` of a new type will *flow through* the pipeline via the fallback (that is what the abstraction test proves), but the output is a raw `structured_content` dump, not a well-formed reference. A type is "supported" only when it has a dedicated `render_artifact` branch **and** a resolver. Do not conclude a type works because the abstraction test passes.
- **New cross-modal prompt family:** `CROSS_MODAL_EXPLANATION` (interpretation), `…_VERIFICATION`, `…_COMPARISON` become sibling `VisionMode` values + intents + prompt templates, reusing the same resolve→normalize→one-vision-call→ground/section→union→display pipeline. The grounding-specific naming keeps that space open without a rename.
- **Raising the 1+1 cap** to N references/images is a cap change, not a redesign (`resolved_images`/`resolved_artifacts` are already lists).
- **FORMULA** is the expected next type and warrants its own spec (resolver + LaTeX rendering/serialization + detection), building on the proven grounding infrastructure.