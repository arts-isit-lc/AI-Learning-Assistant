# Formula-native Comparison — Spec

**Status:** Proposed — spec in active development. Awaiting go-ahead before implementation. Builds on the shipped **Structured Table Comparison** foundation (`.kiro/specs/table-comparison/spec.md`): `ReferenceResolver`, `ComparisonEngine` (registry keyed by `ComparisonType`), `ComparisonFacts` hierarchy, `StructuredComparison`, grounding injection, and block display.
**Area:** `multimodal_rag_v2` (query analysis; new `reasoning/formula/` package — lexer + comparator; a `FormulaReferenceResolver`; grounding + handler union), `chatbot_v2` (block display + grounding), and — **Phase 2 only** — `math_compute` (new `compare_expressions` operation) + `cdk/lib` (one `lambda:InvokeFunction` grant + env). Frontend: verify only (formula blocks already render).
**Refined via** `planning-refinement.md`. This replaces the earlier deferred sketch; the design was restructured around retrieval-primacy, a lexer/parser split (lexical Tier 1 vs. symbolic Tier 2), and an explicit rejection of image-based formula comparison. A later review added: a dedicated `FormulaReference` (no `FigureReference` overload), a normalization stage before tokenization, retained raw/normalized tokens for future similarity metrics, a documented confidence rationale, "best-effort lexical" framing for `EquationType`, and a planned `formula_correction_rate` metric. Residual risks in §13.

---

## 1. Problem Statement

Students ask to compare formulas — *"How does equation 3.4 differ from 5.2?"*, *"Compare the momentum equation with the energy equation."* Today this is impossible: `retrieval/query_analyzer.py` deliberately omits `equation` from `_FIGURE_LOOKUP_PATTERN` (its comment notes adding it wrongly forces `requires_image=True`), there is no formula referencing, and formulas only ever reach the text LLM as a passive `## Formulas` context section. No structural or symbolic comparison exists.

### Load-bearing facts (verified in code)
- **Formula structure is retrievable.** `enrichment/retrieval_unit_builder.py::_build_formula_metadata` persists `latex_repr` + `formula_concepts`; `retrieval/handler.py::_build_formula_results` already surfaces `latex` to the client.
- **Formulas are NOT reference-addressable today.** Caption injection handles only table/figure captions — formulas carry no "Equation 3.4" label, so a numeric lookup only works when the number happens to appear in the stored `latex_repr`/`embedding_text`/`formula_concepts` (§4.4, §13).
- **A symbolic engine already exists.** `math_compute/src/verifier.py` uses `simplify(a - b) == 0`; `compute.py`/`parser.py` handle matrices + simple expressions (not general LaTeX). It is invoked as a Lambda: `invoke({raw_input, operation_hint, source})` → `{status, answer, verification, failure_reason, ...}` (see `chatbot_v2/src/math_compute_client.py`). The **retrieval/reasoning layer does not call it today.**
- **The comparison foundation shipped.** The table feature added the resolver/engine/facts/grounding/display seams this feature slots into.

---

## 2. Principles

Two principles shape every decision below.

**2.1 The comparator is the source of truth** (inherited from the table spec). The comparator computes deterministic `ComparisonFacts`; the LLM only explains them. No comparison LLM call; the chatbot's existing generator writes the prose from injected facts.

**2.2 Retrieval primacy.** *Correct formula identification is the primary determinant of comparison quality. Symbolic reasoning only ever operates on the formulas retrieval selected — if retrieval picks the wrong pair, a perfect lexer and a perfect symbolic engine still produce a confidently wrong answer.* Consequently: resolution is the hard part and gets the most care (§4.4); every comparison **surfaces which formulas it chose** so the student can correct it; and confidence is hedged aggressively.

---

## 3. Architecture — lexical vs. symbolic, cleanly separated

```
QueryIntent (requires_formula_comparison)
   │
   ▼
FormulaReferenceResolver ── ResolvedReferent(structured_content={latex, concepts, ...})   (reuses ReferenceResolver protocol)
   │
   ▼
ComparisonEngine (registry: {TABLE: TableComparator, FORMULA: FormulaComparator})
   │
   ▼
FormulaComparator
   ├─ Tier 1 (ALWAYS):  latex → normalize → lex → tokens → structural profile   (pure, no deps)
   └─ Tier 2 (BEST-EFFORT, optional): SymbolicEquivalenceChecker → equivalence  (math_compute; Phase 2)
   │
   ▼
StructuredComparison(facts=FormulaComparisonFacts) → grounding → chatbot generator → answer + 2 formula blocks
```

The **lexer/parser split** is the core architectural choice:
- **Tier 1 is lexical, not parser-based.** `latex_repr` is first put through a small **normalizer** (strip `\left`/`\right`, collapse whitespace/spacing macros, drop redundant braces and display delimiters, canonicalize alias commands) so the lexer sees a regular stream; the lexer then tokenizes and derives a structural profile. It never calls SymPy and succeeds on nearly all real inputs — even ones a full parse would choke on. This is the *promise*: a comparison always comes back.
- **Tier 2 is symbolic and optional.** Only when both formulas parse does SymPy (via `math_compute`) contribute an equivalence result. It is a *bonus*, isolated behind a service, and degrades silently.

This separates robust **lexical analysis** from fragile **symbolic reasoning**, and keeps the comparator pure (Tier 1) with I/O confined to an injected checker (Tier 2).

---

## 4. Detailed Design

### 4.1 Query analysis (`retrieval/query_analyzer.py`, `models/data_models.py`)

Add a formula-specific pattern that sets **formula** flags only — never `requires_image` (preserving the existing guard):

```text
_FORMULA_REF_PATTERN = r"\b(equation|eq\.?|eqn\.?|formula)\s*\(?(\d+(?:[.-]\d+)*)?\)?"

formula_refs = _extract_formula_references(query)        # numbered refs, may be empty
intent.formula_references = formula_refs
intent.requires_formula_comparison = (
    _COMPARISON_PATTERN.search(query) is not None
    and (len(formula_refs) >= 2 or intent.requires_formula)
)
```

`requires_formula_comparison` fires when there is comparison language **and** either ≥2 numbered equation references **or** a formula-intent keyword (`equation`/`formula`/…) is present. The second clause is what lets *"compare the momentum equation with the energy equation"* (no numbers) trigger — resolution (§4.4) then decides *which* formulas. `QueryIntent` gains `formula_references: list[FormulaReference]` (a dedicated type — §4.2 — not an overloaded `FigureReference`) and `requires_formula_comparison: bool`.

> **Known detection gap (§13):** a purely semantic query with no formula keyword ("compare the loss function") will not trip `requires_formula`, so v1 does not treat it as a formula comparison. Semantic-intent detection is deferred.

### 4.2 Data models (`models/data_models.py`)

```text
class ComparisonType(Enum):  TABLE; FORMULA          # add FORMULA

# Dedicated type — a formula is NOT a figure, so we do not overload
# FigureReference. (A future StructuredReference base could unify
# FigureReference/TableReference/FormulaReference, but that migration is out of
# scope here.)
@dataclass
class FormulaReference:
    number: str = ""            # "3.4" when the query gives one; "" for name-only refs
    keyword: str = ""           # matched token: "equation" | "eq" | "eqn" | "formula"

# best-effort LEXICAL classification (heuristics over tokens — NOT semantic parsing)
class EquationType(Enum):    SCALAR_EQUALITY; VECTOR_EQUATION; MATRIX_EQUATION;
                             OPTIMIZATION_OBJECTIVE; PROBABILITY_EXPRESSION;
                             RECURSIVE_DEFINITION; PIECEWISE; UNKNOWN

class EquivalenceStatus(Enum): EQUIVALENT; NOT_EQUIVALENT; UNKNOWN   # UNKNOWN = unparsed/undecided

@dataclass
class EquivalenceResult:
    status: EquivalenceStatus = EquivalenceStatus.UNKNOWN
    method: str = ""            # e.g. "sympy simplify(a-b)==0"
    reason: str = ""            # short, for observability/grounding

@dataclass
class FormulaProfile:           # per-referent lexical profile (N-way-ready)
    label: str
    variables: list[str]
    constants: list[str]
    operators: list[str]
    functions: list[str]        # sin, cos, log, exp, max, argmax, sum(Σ), prod(Π), int(∫), ...
    greek: list[str]
    equation_type: EquationType  # best-effort lexical classification
    # Raw + normalized token streams retained so FUTURE similarity metrics
    # (Jaccard, TF-IDF, edit distance, tree matching) need not re-tokenize.
    tokens: list[str] = []
    normalized_tokens: list[str] = []

@dataclass
class FormulaComparisonFacts(ComparisonFacts):
    per_referent: list[FormulaProfile]
    shared: dict[str, list[str]]      # {"variables":[...], "functions":[...], ...} intersection
    unique: dict[str, dict[str, list[str]]]   # label -> {"variables":[...], ...}
    equivalence: EquivalenceResult = EquivalenceResult()   # UNKNOWN unless Tier 2 fills it
```

`ResolvedReferent`, `StructuredComparison`, and `ComparisonIntent` are reused unchanged from the table feature.

### 4.3 Orchestration

`ComparisonEngine._plan` gains a FORMULA branch: `requires_formula_comparison → (ComparisonType.FORMULA, formula_refs, ComparisonIntent.COMPARE)`. The engine already selects resolver + comparator by type from its registry, caps referents at 2, and returns a `StructuredComparison`. `reasoning_engine` already runs the engine for `requires_table_comparison`; extend that gate to also cover `requires_formula_comparison` (and skip image escalation for it, same as tables).

### 4.4 FormulaReferenceResolver (the hard part — §2.2)

Resolves up to 2 formulas, in priority order, always `scope_filter`-bounded and deterministic, and records what it chose:

1. **Numbered references** ("equation 3.4"): anchored `build_reference_regex("equation", n)` against FORMULA units' `embedding_text`/`latex_repr` within scope; dedupe by `parent_element_id`; confidence by candidate count (HIGH single / MEDIUM many-in-module / LOW cross-module), mirroring the table resolver.
2. **Top-ranked retrieved formulas** (fallback when < 2 numbered refs resolve): take the top FORMULA results already in `ranked_results` (query-relevant, scoped), dedupe by parent, up to 2. Relevance-chosen, not label-matched.

Confidence is assigned explicitly (so it is consistent and auditable):

| Confidence | Assigned when |
|---|---|
| HIGH | Unique numbered match in scope (exactly one candidate). |
| MEDIUM | Multiple numbered candidates within the same module; OR a retrieval-fallback pick with a strong retrieval score. |
| LOW | Numbered candidates span multiple modules (cross-module ambiguity); OR a retrieval-only pick with a weak score. |

If fewer than 2 distinct formulas resolve, produce a single-referent `StructuredComparison` (describe the one) and note the gap — never fabricate a second. `structured_content = {latex, concepts, page_num, module_id, content}`.

### 4.5 Tier 1 — LatexNormalizer + LatexLexer + FormulaComparator (lexical, pure, always)

`LatexNormalizer.normalize(latex: str) -> str` — a pre-tokenization cleanup so the lexer stays simple and robust: strip `\left`/`\right`, collapse whitespace and spacing macros (`\,` `\;` `\quad`), drop redundant braces and display delimiters (`$$ … $$`, `\[ … \]`), and canonicalize a small set of alias commands. Purely textual, no parsing.

`LatexLexer.tokenize(normalized: str) -> list[str]` — a lightweight tokenizer (regex/char-scan, **not** `sympy.parsing.latex`). From the token stream it derives a `FormulaProfile`, retaining both the raw and normalized token lists on the profile (§4.2) so future similarity metrics need not re-tokenize:
- **variables / constants** (identifiers vs. numeric/`e`/`\pi`)
- **operators** (`+ - * / ^ = ≤ ≥ ∇ ...`)
- **functions** — `sin cos tan log ln exp`, `max min argmax argmin`, `\sum`(Σ) `\prod`(Π) `\int`(∫), etc.
- **Greek** (`\alpha \beta \lambda \theta …`)
- **equation_type** — a **best-effort lexical classification** (token heuristics, NOT semantic parsing; it may be UNKNOWN and must never be presented as authoritative): `\begin{cases}`→PIECEWISE; `argmax|argmin`→OPTIMIZATION_OBJECTIVE; `P(`/`E[`→PROBABILITY_EXPRESSION; `\vec`/`\mathbf`→VECTOR_EQUATION; `\begin{bmatrix}`→MATRIX_EQUATION; `f(n)=…f(n-1)`→RECURSIVE_DEFINITION; else SCALAR_EQUALITY/UNKNOWN.

`FormulaComparator.compare(referents) -> FormulaComparisonFacts`:
- Build a `FormulaProfile` per referent (normalize → lex → profile; pure).
- Compute `shared`/`unique` per category (variables, functions, operators, Greek).
- `equivalence` left UNKNOWN here. If an injected `equivalence_checker` is present (Tier 2) and there are exactly 2 referents, call it and attach its result.

The Tier 1 path is a pure function of `latex_repr` strings — fully testable with no SymPy and no I/O (checker=None).

### 4.6 Tier 2 — SymbolicEquivalenceChecker + math_compute (best-effort; Phase 2)

`SymbolicEquivalenceChecker` protocol: `check(left_latex, right_latex) -> EquivalenceResult`.
- `MathComputeEquivalenceChecker(lambda_client, function_arn)` invokes `math_compute` with a **new** operation and maps the response to `EquivalenceResult`. Any parse/compute/invoke failure → `EquivalenceStatus.UNKNOWN` (never raises).
- Default (no checker / Phase 1) → equivalence stays UNKNOWN; Tier 1 stands alone.

**`math_compute` `compare_expressions` operation:** accept `{operation: "compare_expressions", left, right}`; parse both (reuse existing parse; general LaTeX may fail → return `equivalent: null`); compute `simplify(sympify(left) - sympify(right)) == 0` (reusing `verifier.py`'s primitive). Response adds `comparison: {equivalent: true|false|null, method, reason}`. Safe parsing only (no `eval`), consistent with the module's current pattern.

### 4.7 Grounding (`reasoning/reasoning_engine.py`)

`_format_comparison_section` already branches on facts type for tables; add a `FormulaComparisonFacts` branch:

```text
## Structured comparison of Equation 3.4 and Equation 5.2
Verified facts (computed deterministically — treat as ground truth):
- Equation 3.4: variables {x, w, b}; functions {exp, sum}; type: scalar equality
- Equation 5.2: variables {x, w, b, λ}; functions {exp, sum}; type: scalar equality
- Shared: variables x, w, b; functions exp, sum
- Only in Equation 5.2: variable λ
- Symbolic equivalence (per SymPy): NOT equivalent    # or "not determined" when UNKNOWN

Both formulas are shown below. Compare them using ONLY these facts and the formula
text. Do NOT assert mathematical equivalence beyond what SymPy determined; if
equivalence is "not determined", do not claim they are equal or unequal.
```

Reuses the existing missing-referent note + LOW-confidence hedge. The equivalence line is phrased conservatively (§5 of principles / §13).

### 4.8 Display (`chatbot_v2/src/figure_selection.py`, `retrieval/handler.py`)

- Handler: generalize the resolved-referent union so a FORMULA `StructuredComparison` routes `resolved_results` through `_build_formula_results` (parallel to `_table_results_with_comparison`). Formulas already render as `formula` blocks.
- Chatbot: `select_formulas` already attaches formula blocks when a formula/equation is referenced; ensure both compared formulas are surfaced (they are prepended/top by the handler union). Add a comparison-grounding reinforcement for formulas (generalize `build_comparison_grounding`).

### 4.9 Edge cases

| Case | Behavior |
|---|---|
| Only one formula resolves | Describe it; note the other wasn't found; no fabricated second formula. |
| No formulas resolve | Today's fallback text answer. |
| > 2 referenced | Compare first 2 distinct; state only two were considered. |
| Numbered ref not in stored text | Fall through to top-2 retrieved (§4.4). |
| LaTeX unparseable (Tier 2) | `equivalence = UNKNOWN`; Tier 1 comparison stands; `degraded=True`. |
| Comparison verb but single formula intent | Requires ≥2 distinct resolved formulas; else describe one (avoids comparing unrelated formulas). |
| No formula keyword ("the loss function") | Not detected as a formula comparison in v1 (§13). |

### 4.10 CDK / infra

- **Phase 1 (lexical):** no new Bedrock, no new IAM, no new Lambda calls — pure Python + the chatbot's existing generator. Optional flag `FORMULA_COMPARISON_ENABLED`.
- **Phase 2 (symbolic):** add `lambda:InvokeFunction` on the retrieval role scoped to the `math_compute` function ARN (explicit ARN, least privilege) + `MATH_COMPUTE_FUNCTION_NAME` env. CDK assertion test for the grant + env (testing-policy: CDK change → assertion test).

---

## 5. Data Flow (after change)

```
"compare equation 3.4 and equation 5.2"
  → QueryAnalyzer: formula_references=[3.4, 5.2], requires_formula_comparison=True
  → ComparisonEngine(FORMULA):
        FormulaReferenceResolver.resolve(...) → [Equation 3.4 (+conf), Equation 5.2 (+conf)]
        FormulaComparator.compare(...):
            Tier 1 (lexer): profiles + shared/unique symbols + equation types
            Tier 2 (Phase 2, if both parse): math_compute compare_expressions → equivalence
        → StructuredComparison(FORMULA, COMPARE, referents, FormulaComparisonFacts)
  → Reasoning: inject "## Structured comparison of Equation 3.4 and Equation 5.2" grounding; NO vision call
  → Handler: formula_results includes BOTH resolved formulas (deduped)
  → Chatbot: existing generator writes the comparison; both formula blocks shown
```

---

## 6. Explicitly rejected: comparing formulas as images

Do **not** build an OCR → vision-model → comparison path. The stored `latex_repr` is a dramatically better, structured signal than a re-recognized picture, and it is what makes both Tier 1 (lexical) and Tier 2 (symbolic) possible. Rendering a formula to an image and asking a vision model to "compare" discards that structure and reintroduces the exact screenshot-comparison weakness this effort exists to remove. The **only** time vision should be considered is when ingestion never extracted `latex_repr` at all — and even then the correct fix is upstream (better extraction), not vision comparison.

---

## 7. Tasks (phased — ship the lexical comparison before any infra)

**Phase 1 — Lexical comparison (no new Bedrock/IAM/Lambda calls)**
- [ ] **T1.** `data_models.py`: `ComparisonType.FORMULA`, `FormulaReference`, `EquationType`, `EquivalenceStatus`, `EquivalenceResult`, `FormulaProfile` (incl. `tokens`/`normalized_tokens`), `FormulaComparisonFacts`; `QueryIntent.formula_references` + `requires_formula_comparison`. Tests: construction/defaults.
- [ ] **T2.** `query_analyzer.py`: `_FORMULA_REF_PATTERN` + `_extract_formula_references` (→ `FormulaReference`; sets formula flags only, never `requires_image`); `requires_formula_comparison`. Tests: numbered pair + verb → True and `requires_image` False; keyword+verb no-number → True; single → False; guard regression.
- [ ] **T3.** `reasoning/formula/latex_normalizer.py` + `latex_lexer.py`: normalize (`\left`/`\right`, spacing, redundant braces, aliases, display delimiters) → tokenize → variables/constants/operators/functions/Greek/equation_type, retaining raw + normalized tokens. Tests: normalizer idempotence + delimiter/brace stripping; rich lexer fixtures incl. Σ/∫/argmax/cases/matrix/piecewise; malformed LaTeX still yields a profile (no raise).
- [ ] **T4.** `reasoning/formula/formula_comparator.py` (Tier 1, checker optional/None): profiles + shared/unique; equivalence UNKNOWN. Tests: shared/unique symbols; equation types; 3-referent N-way; pure (no I/O).
- [ ] **T5.** `reasoning/reference_resolver.py`: `FormulaReferenceResolver` (numbered scoped lookup → top-2 retrieved fallback; dedupe; confidence). Tests: numbered HIGH/MEDIUM/LOW; fallback to top-2; <2 resolved.
- [ ] **T6.** Register `FORMULA` in `ComparisonEngine`; extend `reasoning_engine` gate + `_format_comparison_section` FORMULA branch (conservative equivalence wording). Tests: grounding labels both formulas + symbol facts; single/non-comparison unchanged.
- [ ] **T7.** `retrieval/handler.py`: generalize resolved-referent union to route FORMULA → `_build_formula_results`. Tests: both resolved formulas present; non-comparison unchanged.
- [ ] **T8.** `chatbot_v2/src/figure_selection.py`: both compared formulas display + comparison grounding reinforcement. Tests: both `retrieval_id`s attached; single-formula regression.

**Phase 2 — Symbolic equivalence (adds math_compute integration + IAM)**
- [ ] **T9.** `math_compute`: `compare_expressions` operation (`compute.py` + `verifier.py` reuse, `handler.py` route). Tests (`math_compute/tests/`): equivalent pair → equivalent; non-equivalent → not; unparseable → `null` (graceful).
- [ ] **T10.** `SymbolicEquivalenceChecker` + `MathComputeEquivalenceChecker`; inject into `FormulaComparator`; degrade to UNKNOWN on any failure. Tests: mocked invoke → equivalence attached; invoke error → UNKNOWN + `degraded`.
- [ ] **T11.** CDK: `lambda:InvokeFunction` grant (explicit `math_compute` ARN) + `MATH_COMPUTE_FUNCTION_NAME` env on the retrieval role. Tests (`cdk/test`): grant + env assertions.
- [ ] **T12.** Manual E2E: numbered pair (equivalent + non-equivalent); keyword no-number pair; one-missing; unparseable LaTeX degrade.

---

## 8. Security / Trust Boundary
References parsed from the query drive only the anchored, `scope_filter`-bounded lookup (course/module/file isolation preserved); `_MAX_PARSED_REFERENCES` bounds work. The lexer operates on stored `latex_repr` as **data** (tokenize only — never `eval`). Phase 2 symbolic parsing runs inside the already-sandboxed `math_compute` Lambda using its safe `parse`/`sympify` path (no `eval`); Phase 2 adds exactly one least-privilege `lambda:InvokeFunction` grant (explicit ARN), asserted in a CDK test. Phase 1 adds no IAM and no external calls.

## 9. Observability
Correlated by `query_id`:
- **Volume:** `formula_comparison_requests_total`; resolution path used (numbered vs. top-2 fallback).
- **Resolution health:** referents requested vs. resolved, partial-resolution rate, confidence distribution, which formulas were chosen.
- **Tier split:** `formula_tier1_only_rate`, Tier 2 attempt/parse-success rates, `equivalence_status` distribution (equivalent/not/unknown), `degraded` rate, math_compute invoke latency/errors (Phase 2).
- **`formula_correction_rate` (plan for it now):** the fraction of comparisons a student corrects ("no, I meant the other equation"). Given retrieval primacy (§2.2), this is expected to be the single most valuable retrieval-quality signal. It needs a lightweight correction affordance in the UI to capture; not required for v1, but the grounding already names the chosen formulas so a correction turn is natural, and the metric should be wired as soon as that affordance exists.

## 10. Acceptance Criteria
- **AC-1:** `analyze("compare equation 3.4 and equation 5.2")` → `requires_formula_comparison=True`, **`requires_image` False**; a single formula reference → False.
- **AC-2:** The lexer produces a `FormulaProfile` (variables/functions/Greek/equation_type) for well-formed AND malformed LaTeX without raising.
- **AC-3:** `FormulaComparator` (Tier 1, no checker) returns shared/unique symbol sets and per-referent equation types deterministically, with `equivalence=UNKNOWN`; a 3-referent unit test passes (N-way).
- **AC-4:** Resolution yields ≤2 referents, deterministic + scoped, recording which formulas were chosen; < 2 resolved → single-referent comparison with a note (no fabricated formula).
- **AC-5:** Grounding labels both formulas, lists shared/unique symbols, and states equivalence **only** as SymPy-determined (or "not determined") — never as a general proof.
- **AC-6 (Phase 2):** Both parse → `EquivalenceResult` attached; parse/invoke failure → `UNKNOWN` + `degraded=True`, Tier 1 comparison intact.
- **AC-7:** Both resolved formulas appear as `formula` blocks; single/non-comparison responses unchanged; multi-image path untouched.

## 11. Test Strategy
pytest, colocated `test_*.py`, deterministic. Tier 1 (lexer + comparator) is pure → fully tested without SymPy or mocks (the §2.1 point). Resolver tested with a fake DB cursor (as the table resolver is). Tier 2 tested with a mocked checker + a mocked `math_compute` invoke (equivalent / not / unparseable / error→UNKNOWN). `math_compute` `compare_expressions` gets happy + error cases in `math_compute/tests/`. CDK assertion test for the Phase 2 grant + env. Run: `cd cdk && python -m pytest multimodal_rag_v2/ chatbot_v2/ math_compute/ -v` and `cd cdk && npm test`.

## 12. Rollout
Phase 1 is additive and wire-compatible: single/non-comparison queries unchanged, multi-image path untouched, no new Bedrock/IAM. `FORMULA_COMPARISON_ENABLED` flag gates it. Phase 2 adds one `lambda:InvokeFunction` grant + env behind the `predeploy` `npm test`; `compare_expressions` failures degrade to Tier 1, so enabling Tier 2 cannot regress the lexical comparison.

## 13. Residual Risks / Open Items (honest notes)
- **Referencing is the dominant risk (§2.2).** *Formula retrieval quality is expected to dominate comparison quality until ingestion provides stable formula identifiers. Improving symbolic reasoning does not compensate for incorrect formula selection.* The `top-2 retrieved` fallback is workable but **will produce false positives** whenever retrieval mis-ranks — e.g. *"compare the momentum equation and the energy equation"* may retrieve the energy equation and a *conservation* equation (not momentum), and the system would then confidently compare the wrong pair. This is a retrieval limitation, not a comparison-logic flaw; it is mitigated by always naming the chosen formulas + hedging (and, later, `formula_correction_rate`), but **not eliminated**. The durable fix is formula label/caption injection during ingestion (a separate ingestion change) — this is the key decision to make before committing.
- **Semantic intent gap:** "compare the loss function" (no `equation`/`formula` keyword) is not detected in v1.
- **LaTeX → SymPy is brittle:** Tier 2 will be UNKNOWN for many real formulas; the lexer Tier 1 is the reliable deliverable. Never present equivalence as a general proof (only "as determined by SymPy").
- **`math_compute` invocation path from retrieval is new** — confirm ownership/trigger conventions before wiring (Phase 2).
- **Over-trigger:** a comparison verb + one formula could pull an unrelated second formula; guarded by requiring ≥2 distinct resolved formulas, else describe one.

---

## 14. Future extensibility (not in scope — noting the seam)
Because Tier 2 isolates symbolic reasoning behind the `math_compute` service, the same seam extends later to `derive`, `solve`, `substitute`, `simplify`, dimensional analysis, and units checking — each a new operation on the service, not a new branch in the comparator. The two-tier design (lexer for structure, math service for symbolic work) is intentionally future-proof.
