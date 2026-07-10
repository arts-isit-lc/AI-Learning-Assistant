# Structured Table Comparison — Spec

**Status:** Proposed — not started. Awaiting go-ahead before implementation.
**Area:** `multimodal_rag_v2` (retrieval query analysis; new `reasoning/reference_resolver.py`, `reasoning/comparison/` package; retrieval handler response), `chatbot_v2` (block selection + grounding). Frontend block rendering: verify only. **No new Bedrock model, no new IAM.**
**Related:** Sibling feature `.kiro/specs/multi-figure-comparison/spec.md` (multi-image reasoning — the *visual* comparison path). This is the *non-visual* counterpart for tabular content. Formula comparison is a **separate, deferred** spec: `.kiro/specs/formula-comparison/spec.md` — it reuses the resolution + engine foundation defined here.
**Refined via** `planning-refinement.md` (5 iterations; final score ~9.25/10). Iter 5 (this review) acted on design feedback: split resolution from comparison, split formulas into their own spec, typed the facts model, introduced a row-alignment abstraction, and made the comparator N-way-ready. Residual risks in §13.

---

## 1. Problem Statement

Students ask *"Compare table 2.1 and table 3.1 — which dataset has more coverage?"* Today this is answered on a **screenshot**, not the data.

A `table` reference already trips the multi-image path (the figure regex includes `table`), but resolution requires an image, so `reasoning/image_escalation.py::_find_image_by_figure_ref_in_db` *Strategy C* locates the table's page and grabs a **page-render screenshot**, then sends that to the vision model with a prompt that judges "visual-communication quality." The structured `table_headers`/`table_rows` — which are **stored and available** — are never compared, and a text model that could read them directly is never given them.

### Load-bearing facts (verified in code)
- `enrichment/retrieval_unit_builder.py::_build_table_metadata` persists `table_headers`, `table_rows` (capped at 50), and `table_summary` into each TABLE unit's `metadata`.
- `retrieval/handler.py::_build_table_results` already surfaces these to the client, deduped by `parent_element_id`.
- Caption injection prepends "Table N …" into a TABLE unit's `embedding_text`, so the same anchored-regex + `scope_filter` lookup used for figures resolves a table reference to its unit(s).
- Comparison intent language already exists as `_COMPARISON_PATTERN` in `query_analyzer.py`.

So the data is present and reference-addressable — what is missing is a **content-level comparison** path that never touches image bytes.

---

## 2. Design Principle — the comparator is the source of truth

This is the core philosophy and the reason there is **no comparison LLM call**:

> **The comparator computes comparison facts deterministically. The LLM never derives facts — its only job is to explain the comparator's output in prose.**

Consequences that shape every section below:
- Every claim the student sees ("Table 3.1 adds a `region` column", "they share 4 columns", "12 rows differ in `score`") originates in a deterministic `ComparisonFacts` object, not from a model reading a screenshot or guessing.
- The final answer is written by the **chatbot's existing generator**, grounded strictly on those facts + the referents' data. This removes a Bedrock call, removes an IAM delta, and makes the feature testable without mocking a model for correctness.
- The model may still add pedagogical framing ("more coverage likely means…"), but factual comparison is not its responsibility and it is instructed not to invent cells or columns.

---

## 3. Architecture — resolution and comparison are separate responsibilities

Two independent stages, so reference resolution is reusable outside comparison (e.g. a future "Show me Table 2.1" or "Summarize Table 3.1" needs resolution but not comparison):

```
QueryIntent
   │
   ▼
ReferenceResolver         (protocol)              ── independently reusable
   └─ TableReferenceResolver  → ResolvedReferent(structured_content=…)
   │
   ▼
list[ResolvedReferent]
   │
   ▼
ComparisonEngine          (orchestrator; registry keyed by ComparisonType)
   └─ TableComparator      → uses RowAligner(AlignmentStrategy) → TableComparisonFacts
   │
   ▼
StructuredComparison  →  grounding  →  chatbot's existing generator  →  answer + 2 table blocks
```

- **`ReferenceResolver` (protocol)** — `resolve(refs, ranked_results, scope_filter) -> list[ResolvedReferent]`. `TableReferenceResolver` finds each referenced table (sibling-link → scoped DB lookup, reusing the anchored regex), dedupes by `parent_element_id`, and loads `structured_content` from metadata. Resolution and its confidence rules mirror the image path's `_resolve_figure_image`.
- **`ComparisonEngine`** — selects a comparator by `ComparisonType` from a small **registry** (`{ComparisonType.TABLE: TableComparator()}` in v1; the formula spec registers `FORMULA`). No `if/else` chain; adding a type is a registry entry. Operates on a **list** of referents (N-way-ready — §4.7), even though v1 policy caps at 2.
- **`TableComparator`** — computes the deterministic diff over the referent list. Delegates row-level work to `RowAligner`.
- **`RowAligner` + `AlignmentStrategy`** — key-column detection and row matching are isolated here because "which column is the key" is genuinely hard (`Student ID` vs `SID` vs `Student Number`). v1 ships one strategy; smarter (synonym/semantic) strategies plug into the same seam without touching the comparator (§4.5).

> **Shared helpers.** `_build_reference_regex` and `_scope_predicate` currently live inside `image_escalation.py`. They are pure/static. Extract them into a small `reasoning/reference_lookup.py` used by **both** the image path and `TableReferenceResolver`, so there is one implementation of the anchored, scoped lookup. Low-risk (pure functions, unit-tested); the image path keeps identical behavior.

---

## 4. Detailed Design

### 4.1 Query analysis (`retrieval/query_analyzer.py`, `models/data_models.py`)

Reuse existing reference extraction; add one typed flag. No change to figure/image behavior.

```text
table_refs = [r for r in intent.figure_references if r.ref_type == "table"]   # existing list, filtered
intent.requires_table_comparison = (
    len(table_refs) >= 2 and _COMPARISON_PATTERN.search(query) is not None
)
```

`QueryIntent` gains `requires_table_comparison: bool`. (No new regex — tables are already captured by `_FIGURE_LOOKUP_PATTERN`; formulas are handled entirely in the separate formula spec, which adds its own pattern so the `requires_image` guard is never touched here.)

### 4.2 Data models (`models/data_models.py`) — typed, not loose dicts

```text
class ComparisonType(Enum):   TABLE                     # FORMULA added by the formula spec
class ComparisonIntent(Enum): COMPARE; DESCRIBE          # replaces free-form "compare"/"describe_each"

@dataclass
class ResolvedReferent:
    reference: str                          # "Table 2.1"
    retrieval_id: str
    parent_element_id: str
    confidence: ResolutionConfidence         # reuse existing enum (HIGH/MEDIUM/LOW)
    structured_content: dict                 # table: {headers, rows, summary}  (renamed from "payload")

# --- Facts: a typed hierarchy, not facts: dict ---
@dataclass
class ComparisonFacts:                       # base / marker for the engine + grounding
    pass

@dataclass
class TableShape:
    label: str
    n_rows: int
    n_cols: int
    columns: list[str]

@dataclass
class RowAlignmentResult:
    key_columns: list[str]
    aligned_rows: int
    differing_cells: list[dict]              # bounded; {key, column, values_by_label}
    unaligned_by_label: dict[str, int]

@dataclass
class TableComparisonFacts(ComparisonFacts):
    per_referent: list[TableShape]           # N-way-ready
    shared_columns: list[str]                # intersection across ALL referents
    unique_columns: dict[str, list[str]]     # label -> columns only in that referent
    row_alignment: RowAlignmentResult | None # None when no key column found

@dataclass
class StructuredComparison:
    comparison_type: ComparisonType
    intent: ComparisonIntent
    referents: list[ResolvedReferent]        # the ones actually resolved (<= policy cap)
    facts: ComparisonFacts                   # TableComparisonFacts here
    reference_mapping: list[ResolvedReferent] # requested -> chosen (missing ones noted in grounding)
    degraded: bool = False

@dataclass
class EscalationResult:                       # EXTEND existing — additive
    ...
    structured_comparison: StructuredComparison | None = None
```

### 4.3 Orchestration (`reasoning/reasoning_engine.py`)

The engine makes **no Bedrock call**, so this is a cheap deterministic pre-step:

```text
if query_intent.requires_table_comparison:
    sc = comparison_engine.compare(query_intent, ranked_results, scope_filter)   # resolve + diff
    if sc and sc.referents:
        result.structured_comparison = sc
        inject_comparison_grounding(sc)      # §4.6 — reaches the chatbot's generator
        # do NOT short-circuit; skip image escalation for this query
```

### 4.4 TableReferenceResolver + TableComparator

Resolver: for each `table_ref`, anchored `_build_reference_regex(ref_type, number)` against `element_type='table'` `embedding_text`, `scope_filter`-bounded; dedupe by `parent_element_id`; deterministic pick + confidence identical to the image rules; load `{headers, rows, summary}` into `structured_content`.

Comparator (`compare(referents: list[ResolvedReferent]) -> TableComparisonFacts`):
- Normalize headers (trim/casefold) per referent → `TableShape` (label, shape, columns).
- `shared_columns` = intersection across **all** referents; `unique_columns[label]` = per-referent difference.
- Delegate rows to `RowAligner` → `row_alignment` (or `None`).
- Pure function of its inputs → trivially unit-testable, deterministic (no LLM, no I/O).

### 4.5 RowAligner + AlignmentStrategy

```text
class AlignmentStrategy(Protocol):
    def choose_key(self, shapes: list[TableShape]) -> list[str] | None: ...

class ExactHeaderKeyStrategy:      # v1 default
    # A key column must exist (by normalized name) in ALL referents and be
    # (near-)unique within each. Prefers names in a small hint set
    # ("id", "name", "student id", ...); otherwise the first shared unique column.
    ...

class RowAligner:
    def __init__(self, strategy: AlignmentStrategy = ExactHeaderKeyStrategy()): ...
    def align(self, referents, shapes) -> RowAlignmentResult | None:
        key = self.strategy.choose_key(shapes)
        if not key: return None                 # schema/shape-only comparison (§4.8)
        # join rows on key; record differing cells (bounded); count unaligned per label
```

v1 keeps alignment intentionally simple (exact normalized key match, bounded by the upstream 50-row cap). Semantic/synonym key strategies (`Student ID` ≈ `SID` ≈ `Student Number`) are a future `AlignmentStrategy` implementation — the comparator does not change.

### 4.6 Grounding (`reasoning_engine.py` + `chatbot_v2/src/figure_selection.py`)

A new grounding section, parallel to the existing `build_table_grounding`, rendered from the typed facts:

```text
## Structured comparison of <Table 2.1> and <Table 3.1>
Verified facts (computed deterministically — treat as ground truth; do not recompute or invent):
- Table 2.1: 40 rows × 5 columns [id, name, score, term, dept]
- Table 3.1: 55 rows × 6 columns [id, name, score, term, dept, region]
- Shared columns: id, name, score, term, dept
- Only in Table 3.1: region
- Row alignment on `id`: 38 shared keys; 12 differ in `score`; 2 rows only in 2.1; 17 only in 3.1

Both tables are shown below. Write a direct comparison grounded ONLY in these facts and the
table data. Do NOT invent cells or columns. If a referent is missing or low-confidence, say so.
```

`reasoning_engine` injects it (like `_format_multi_image_section`); `chatbot_v2` gains `build_comparison_grounding(structured_comparison)`. No short-circuit — the existing generator writes the prose.

### 4.7 N-way readiness

The comparator and facts model operate on **collections**, so 3+ way comparison is a policy change, not a rewrite:
- `TableComparator.compare(referents: list)` and `TableComparisonFacts.per_referent`/`unique_columns` are already per-referent.
- v1 **policy** caps at 2, enforced at the engine/analyzer boundary (compare the first 2 distinct referents; state only two were considered — §4.9). Raising the cap later touches only that boundary and the grounding template.

### 4.8 Edge cases

| Case | Behavior |
|---|---|
| One of two tables not found | Describe the found one; note the other wasn't located (grounding). |
| Neither found | Today's fallback text answer. |
| >2 referents | Compare first 2 distinct; state only two were considered (§4.7). |
| Same table twice ("2.1 vs 2.1") | De-duped → 1 referent → not a comparison → existing single path. |
| No shared columns | `row_alignment=None`; report schema/shape diff only. |
| No usable key column | `row_alignment=None`; schema/shape diff only (still useful). |
| Comparison verb but <2 table refs | No flag; existing behavior. |
| Rows > 50 | Upstream cap applies; grounding notes the comparison is over the stored sample. |

### 4.9 Display (`chatbot_v2/src/figure_selection.py`)
Attach **both** resolved tables as `table` blocks via `select_tables` (extended to include the compared pair by `retrieval_id`), deduped. `assemble_blocks` already handles a list.

### 4.10 CDK / infra
None required. The comparator is pure Python and the prose comes from the chatbot's existing generator. Optional feature flag `TABLE_COMPARISON_ENABLED` (env) for staged enablement/kill-switch; add a CDK assertion test only if a resource actually changes.

---

## 5. Data Flow (after change)

```
"compare table 2.1 and table 3.1 — which has more coverage?"
  → QueryAnalyzer: figure_references=[table 2.1, table 3.1], requires_table_comparison=True
  → ComparisonEngine:
        TableReferenceResolver.resolve(...)  → [Referent(2.1,+conf), Referent(3.1,+conf)]
        TableComparator.compare([2.1,3.1])   → TableComparisonFacts{shapes, shared/unique cols, row_alignment}
        → StructuredComparison(TABLE, COMPARE, referents, facts)
  → Reasoning: inject "## Structured comparison of Table 2.1 and Table 3.1" grounding; NO vision, NO comparison LLM call
  → Handler: table_results includes BOTH resolved tables (deduped)
  → Chatbot: build_comparison_grounding + attach both table blocks; existing generator writes the prose
  → Response: comparative text grounded in verified facts + 2 table blocks
```

---

## 6. Tasks

- [ ] **T1.** `reasoning/reference_lookup.py`: extract `_build_reference_regex` + `_scope_predicate` from `image_escalation.py` (pure); repoint the image path to it. Tests: parity with existing regex/scope tests; image path unchanged.
- [ ] **T2.** `data_models.py`: `ComparisonType`, `ComparisonIntent`, `ResolvedReferent` (`structured_content`), `ComparisonFacts`/`TableShape`/`RowAlignmentResult`/`TableComparisonFacts`, `StructuredComparison`; `EscalationResult.structured_comparison`. Tests: construction/defaults; enum values.
- [ ] **T3.** `query_analyzer.py` + `QueryIntent`: `requires_table_comparison` (≥2 `table` refs + comparison verb). Tests: two tables + "compare" → True; "explain table 2.1 and 3.1" → False; one table → False; figure/image regression.
- [ ] **T4.** `reasoning/reference_resolver.py`: `ReferenceResolver` protocol + `TableReferenceResolver` (scoped resolution, dedupe by parent, confidence, load structured_content). Tests: sibling-link → HIGH; single DB match → HIGH; same number in two in-scope files → deterministic pick + MEDIUM/LOW; scope threaded.
- [ ] **T5.** `reasoning/comparison/row_aligner.py`: `AlignmentStrategy` + `ExactHeaderKeyStrategy` + `RowAligner`. Tests: key chosen from shared unique column; no-key → None; differing-cell detection; unaligned counts; bounded output.
- [ ] **T6.** `reasoning/comparison/table_comparator.py` + `ComparisonEngine` (registry): schema/shape/unique-column diff over a referent **list**; engine selects by `ComparisonType`. Tests: shared/unique columns across 2 (and a 3-referent unit test to prove N-way); shape; engine dispatch; policy cap-at-2.
- [ ] **T7.** `reasoning_engine.py`: run engine on `requires_table_comparison`, inject grounding, no short-circuit, skip image escalation. Tests: grounding present + labels both; partial-resolution note; single/non-comparison unchanged.
- [ ] **T8.** `retrieval/handler.py`: ensure both resolved tables appear in `table_results` (deduped). Tests: both present; non-comparison response unchanged.
- [ ] **T9.** `chatbot_v2/src/figure_selection.py`: `build_comparison_grounding`; attach both compared tables. Tests: both `retrieval_id`s attached; single-table regression.
- [ ] **T10.** Frontend (verify only): renderer shows two `table` blocks; ESLint-only fix if needed.
- [ ] **T11.** Manual E2E: two real tables (overlapping + differing columns; with and without a key column) → grounded comparison + both tables shown; one-missing case.

---

## 7. Security / Trust Boundary
References are parsed from the query and used only in the existing anchored, `scope_filter`-bounded lookup (course/module/file isolation preserved); `_MAX_PARSED_REFERENCES` bounds work. Row alignment output is bounded (differing-cell list capped; rows already capped at 50 upstream). No new IAM, no new Bedrock call, no new external calls. Stored table content is treated as data, never executed.

## 8. Observability
Correlated by `query_id`:
- **Volume:** `table_comparison_requests_total`, COMPARE vs DESCRIBE.
- **Resolution health:** referents requested vs resolved, partial-resolution rate, `resolution_confidence` distribution, `reference_mapping`.
- **Comparison shape:** shared/unique column counts, `row_alignment` present/absent, key column(s) chosen, comparator latency (no Bedrock cost delta).

## 9. Acceptance Criteria
- **AC-1:** `analyze("compare table 2.1 and table 3.1 …")` → `requires_table_comparison=True`; figure/image behavior for other queries unchanged.
- **AC-2:** Resolution yields two `ResolvedReferent`s with `structured_content` + confidence, deterministically, scope-bounded; ambiguous same-number → MEDIUM/LOW recorded in `reference_mapping`.
- **AC-3:** `TableComparator` returns a `TableComparisonFacts` with correct `shared_columns`/`unique_columns`/`per_referent`; a 3-referent unit test passes (N-way-ready) even though production policy caps at 2.
- **AC-4:** `RowAligner` picks a key when a shared unique column exists, reports differing cells + unaligned counts; returns `None` (schema/shape-only) when no key exists — no crash.
- **AC-5:** The comparison reaches the final generator as grounding derived **only** from `ComparisonFacts`; no vision call and no dedicated comparison LLM call occur.
- **AC-6:** Both referents appear as `table` blocks (deduped by `retrieval_id`).
- **AC-7:** One resolved → answer covers it and notes the other wasn't found; none → today's fallback.
- **AC-8:** Single-referent and non-comparison responses are byte-for-byte unchanged; the multi-image path is untouched.

## 10. Test Strategy
pytest, colocated `test_*.py`, factories (`_make_table_element()`), `monkeypatch`, deterministic — no network/creds/model. The comparator and aligner are **pure functions**, so correctness is tested without mocking any LLM (the whole point of §2). Resolver tested independently of comparison. Grounding-injection and `table_results` union tested at the reasoning/handler seam. Run: `cd cdk && python -m pytest multimodal_rag_v2/ chatbot_v2/ -v` and `cd cdk && npm test` (no CDK change expected unless a flag/resource is added).

## 11. Rollout
Additive and wire-compatible. Single-referent and non-comparison queries are unchanged; the multi-image path is untouched. No new Bedrock/IAM. Optional `TABLE_COMPARISON_ENABLED` flag for staged enablement/kill-switch. The `reference_lookup.py` extraction (T1) is a pure refactor gated by the `predeploy` `npm test`.

## 12. Refinement log
**Iters 1–4:** see `.kiro/specs/structured-comparison` history — unified table+formula draft; dropped the dedicated comparison LLM call (deterministic diff + existing generator); separated the formula reference pattern from the `requires_image` guard.
**Iter 5 (this review — design feedback):**
- **Split resolution from comparison** (`ReferenceResolver` → `ComparisonEngine`), making resolution reusable for non-comparison lookups.
- **Split formulas into their own deferred spec** (`.kiro/specs/formula-comparison/spec.md`) — different engineering problems (numbering, LaTeX parsing, SymPy, Lambda/IAM); ship tables first.
- **Typed the facts** (`ComparisonFacts`/`TableComparisonFacts`) instead of `facts: dict`.
- **`ComparisonIntent` enum** instead of free-form strings.
- **Isolated row alignment** (`RowAligner` + `AlignmentStrategy`) so key detection can grow independently.
- **Made the comparator N-way-ready** (operates on a referent list; 2-cap is policy).
- **Added the design-principle section** (§2 — comparator is the source of truth; the LLM only explains).
- **Renames:** `ComparisonEngine`, `structured_content`, `ComparisonType`-keyed registry.

## 13. Residual Risks / Open Items (honest notes)
- **Key-column detection is heuristic.** v1's `ExactHeaderKeyStrategy` will miss semantic keys (`Student ID` vs `SID`). Mitigated by the `AlignmentStrategy` seam + graceful schema/shape-only fallback; not solved.
- **50-row cap** means value-level alignment is over the stored sample, not necessarily the full table; grounding states this.
- **Header normalization is lexical** (trim/casefold); genuinely different tables that reuse column names could align spuriously — reported as facts, so the student/LLM can see the columns.
- **`reference_lookup.py` extraction touches the image path** (pure move); covered by parity tests.
- **Frontend rendering assumed, not verified** (T10).
