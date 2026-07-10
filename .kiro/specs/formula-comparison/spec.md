# Formula-native Comparison — Spec (DEFERRED)

**Status:** Deferred — do NOT start. Parked intentionally until **Structured Table Comparison** (`.kiro/specs/table-comparison/spec.md`) ships and proves useful. This document preserves the analysis so it isn't re-derived later; it is a starting point, not a scheduled plan, and the design will be revised once the table feature is in production.
**Why separate from tables:** table comparison and formula comparison look similar but are mostly different engineering problems. Tables are ready today (structured data stored, references resolvable). Formulas are not — they carry a stack of distinct, unsolved problems (below). Bundling them would have blocked a shippable table feature behind formula-specific risk.

---

## 1. What it reuses from Table Comparison

Formula comparison plugs into the **foundation** defined by the table spec, so the incremental surface is smaller than a from-scratch feature:
- `ReferenceResolver` protocol → add a `FormulaReferenceResolver`.
- `ComparisonEngine` registry → register `ComparisonType.FORMULA → FormulaComparator`.
- `ComparisonFacts` hierarchy → add `FormulaComparisonFacts`.
- `ComparisonIntent`, `StructuredComparison`, grounding-injection, and block-display paths are shared as-is.
- Deterministic-source-of-truth principle (table spec §2) still holds: the comparator produces facts; the LLM only explains them.

The genuinely new work is everything **specific to formulas** — and that is where the risk lives.

---

## 2. The hard problems (why this is its own project)

1. **Numbering / referencing.** Course formulas are not reliably labeled the way figures/tables are. There is no formula caption injection today, so "Equation 3.4" usually cannot be resolved by an anchored label lookup. A dedicated `_FORMULA_REF_PATTERN` (`equation|eq|eqn|formula` + number) must be added that sets formula flags **only** and never `requires_image` (the `_FIGURE_LOOKUP_PATTERN` code comment is explicit that adding `equation` there wrongly forces the image path). When no number is present, fall back to the top-2 retrieved FORMULA results — inherently lower-confidence.
2. **Retrieval.** Selecting *the two formulas the student means* from a lecture full of equations is imprecise without labels; confidence will often be MEDIUM at best, requiring hedged grounding.
3. **Parsing.** `latex_repr` is stored, but arbitrary textbook LaTeX → a symbolic form is brittle. `math_compute`'s parser targets matrices + simple expressions, not general LaTeX; general parsing needs `sympy.parsing.latex` (antlr4 runtime) and still fails on plenty of real inputs.
4. **SymPy / equivalence.** `math_compute/src/verifier.py` already has the primitive (`simplify(a - b) == 0`), but equivalence is only meaningful when **both** formulas parse cleanly.
5. **Lambda integration.** `math_compute` is a separate Docker Lambda with no current `chatbot_v2` caller — its trigger/ownership must be confirmed before wiring a retrieval→math_compute invoke.
6. **IAM.** The symbolic path adds a `lambda:InvokeFunction` grant (explicit `math_compute` ARN) + env on the retrieval role — a CDK/IAM change (with an assertion test), unlike the table feature which needs none.
7. **Parser failures as the norm, not the exception.** The design must treat "cannot parse" as a common path, not an error.

---

## 3. Sketch of the intended design (subject to revision)

Two-tier comparator so the feature always produces *something* and never blocks on the parser:

- **Tier 1 — structural, always available (no parser):** from `latex_repr` lexically extract variable/symbol sets, an operator inventory, and `formula_concepts` overlap → a structural diff. This never fails and is the baseline.
- **Tier 2 — symbolic, best-effort (verified enhancement):** only when **both** `latex_repr` parse, obtain a verified equivalence verdict via `math_compute` (new `compare_expressions` operation reusing `compute.py`/`verifier.py`). Any parse/compute/invoke failure → `degraded=True`, keep Tier 1 only.

`FormulaComparisonFacts` (typed, per the table spec's model): `per_referent` (vars, operators), `shared_vars`, `concept_overlap`, `equivalent: true | false | unknown`.

Integration options for Tier 2 (decide at start): (a) **invoke the `math_compute` Lambda** — isolates the heavy/fragile sympy+antlr dependency and reuses verified code, at the cost of a cross-Lambda call + IAM (recommended); (b) a **shared SymPy layer** in the RAG image — no cross-Lambda call but pulls antlr/sympy into that image and duplicates logic.

---

## 4. Entry criteria (when to pick this up)
- Table Comparison is in production and used.
- A decision on formula **referencing** is made (accept top-2/hedge, or invest in formula label/caption injection during ingestion — parallels the existing table/figure caption injection).
- Appetite exists for the LaTeX-parsing reality: Tier 1 is the promise; Tier 2 (verified equivalence) is a best-effort bonus, not guaranteed for general formulas.

## 5. Explicit non-promise
Do **not** advertise "verified equivalent" for arbitrary course formulas. The honest deliverable is a structural comparison that always works, plus a verified equivalence badge on the subset of formulas that parse cleanly.
