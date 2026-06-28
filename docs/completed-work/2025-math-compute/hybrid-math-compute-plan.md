# Hybrid Math Compute — Architecture Plan

## Problem

LLMs generate plausible-looking but incorrect multi-step mathematics. Claude 3 Sonnet produced wrong eigenvalues, wrong characteristic polynomial, and wrong determinant expansion — all presented confidently. For an educational chatbot, this is the most damaging failure mode.

## Solution

A compiler-style pipeline: parse input → compute with SymPy → verify via substitution → LLM explains the verified result.

The LLM never calculates. It explains.

## Architecture

```
Student provides math expression directly
       │
       ▼
┌────────────────────┐     ┌────────────────────┐
│  Chatbot V2        │     │  Compute Lambda    │
│                    │     │                    │
│  1. Classify       │────▶│  1. Parse          │
│  2. Extract        │     │  2. Validate       │
│  3. Render result  │◀────│  3. Compute (SymPy)│
│     with status    │     │  4. Verify         │
└────────────────────┘     └────────────────────┘
```

**4-core pipeline + 2 control layers:**

Core (linear, with uncertainty propagation):
- Parse (introduces uncertainty) → **Ambiguity Gate** (hard constraint — blocks if uncertain) → Compute (deterministic — reduces uncertainty) → Verify (strengthens constraints) → Render (reintroduces uncertainty — dangerous zone)

Control (gates/routing):
- Classify/Router (multi-label: compute + explain + verify flags, not mutually exclusive)
- Confidence propagation (parser uncertainty flows through — if parser confidence is low, render is constrained further)
- **Ambiguity gate** (if multiple valid interpretations exist → STOP and clarify, never guess)

**Key architectural insight:** This is a constraint propagation system, not a pipeline. Compute reduces uncertainty. Render reintroduces it. That paradox is the core design tension.

```
parse (uncertainty introduced)
   ↓
ambiguity gate (hard constraint — blocks if unresolved)
   ↓
compute (deterministic — uncertainty eliminated)
   ↓
verify (constraint strengthened)
   ↓
render (uncertainty reintroduced — must be bounded)
```

**Render layer contract:**

May:
- Reformat compute output for readability (purely representational)
- Paraphrase verified values in natural language
- State verification status
- Explain relationships explicitly derivable from compute output OR tagged symbolic properties (e.g., "this is a symmetric matrix" if SymPy confirms symmetry)

May NOT:
- Introduce claims requiring computation not performed (e.g., geometric interpretation without eigenvector computation)
- Recompute, re-derive, round, or modify any values
- "Helpfully explain" with ungrounded intuition

**This is NOT "may only say eigenvalues are 3 and 1."** The LLM may say "since both eigenvalues are positive, the matrix is positive definite" — because that's a logical derivation from the verified values. It may NOT say "this means stretching along the diagonal" — because that requires eigenvector information not requested/computed.

**Rule of thumb:** derivation from verified output = allowed. Interpretation requiring additional unverified computation = not allowed.

## Core Design Decisions

**Global invariant (NO-GUESSING PRINCIPLE):**

> If any stage — parser, ambiguity gate, classifier — cannot deterministically resolve structure → system MUST stop and request clarification. No fallback inference allowed. No "helpful guessing." This applies everywhere, including the LLM render layer.

This is the single rule that eliminates "confident inference under uncertainty" — the exact failure class this system exists to prevent.

| Decision | Rationale |
|----------|-----------|
| SymPy input IS the intermediate representation | Don't build a parallel semantic model. Accept long-term coupling risk — add abstraction only if SymPy syntax breaks. |
| Enforcement via output schema, not linting | Values from compute, explanation from LLM — one structural constraint |
| Verification = substitution under SymPy simplification + numerical tolerance | Cheap + meaningful. **Strength varies by domain** (see table below). These are current heuristic strengths, not formal guarantees — expect them to improve over time. |
| LLM may only reference values, variables, and expressions explicitly present in compute output | Strong behavioral constraint (~95-98% compliance via prompt). Not a hard guarantee — requires trace monitoring to catch drift. |
| If parsing fails → structured error, never LLM interpretation fallback | Maintains correctness boundary. LLM cannot "try to figure out" what was meant. |
| If classifier confidence is uncertain → default to compute-required | Safer to compute unnecessarily than to skip compute and hallucinate. Tradeoff: ~30-60% of conceptual queries will hit Lambda unnecessarily. Acceptable for V1; becomes a scaling constraint later. |
| V1 rejects discourse references ("that matrix") | Prevents confidently computing the wrong object |
| Lowest confidence gate wins | Single arbitration function — parser uncertainty propagates to render constraints |
| Execution trace is the authoritative source of truth | In debugging, trace determines what happened — not the final LLM output |

**Ambiguity gate formal rule:**

```
IF parse produces >1 valid canonical mathematical structure
   AND no explicit structural delimiter resolves ambiguity
THEN → REJECT (ask clarification)

IF structure inference requires assumption about:
   - dimensionality (is "2 1 1 2" a 2x2 or 4-vector?)
   - grouping (is "a b c d" a matrix row or multiple scalars?)
   - operation target (which object does "solve" apply to?)
THEN → REJECT (ask clarification)
```

Even `[[2,1],[1,2]]` is unambiguous only because brackets explicitly denote structure. Bare numbers like `2 1 1 2` ALWAYS require clarification.

**Clarification is an interaction loop, not terminal rejection.** The system asks → student responds → parse re-attempts. This is NOT "sorry, can't help." It's "I want to help correctly — which of these did you mean?"

**Core correctness equation:**

```
P(correct output) = P(correct parse) × P(correct ambiguity resolution) × P(correct compute)
```

SymPy (P(correct compute)) ≈ 1.0 — it's the least uncertain term. Parser and ambiguity resolution dominate actual failure rate. The system's correctness guarantee is only as strong as its weakest stage — which is parsing, not math.

**Verification strength by domain (current heuristic — not user-facing guarantees):**

| Domain | Verification method | Confidence level |
|--------|-------------------|-----------------|
| Linear algebra | Av=λv, A·A⁻¹=I, substitution | High |
| Calculus | Differentiate integral, numeric spot-check at 3 points | Medium |
| Statistics | Bounds checks, sum-to-1 for probabilities | Medium-low |

Users should NOT assume uniform guarantee. Verification status `verified` means "passed the available check for this operation type" — the check's strength varies.

## Classification

Multi-label routing with dependency graph. Execution order respects dependencies:

```json
{
  "flags": {"compute": true, "explain": true, "verify": false},
  "dependencies": {
    "explain": ["compute"],
    "verify": ["compute", "student_input"]
  }
}
```

| Flag | Trigger patterns | Depends on |
|------|-----------------|-----------|
| `compute: true` | "find", "calculate", "solve", explicit matrix/equation present | Independent |
| `explain: true` | "walk me through", "what does X mean", "why" | Requires compute result first |
| `verify: true` | "check my work", "is this correct", student provides answer | Requires compute + student's claimed answer |

Orchestration: if `verify` is flagged but student answer is missing → ask for it. If `explain` is flagged → compute runs first, explanation uses verified output.

Examples:
- "walk me through eigenvalues for [[2,1],[1,2]]" → `{compute: true, explain: true}` → compute first, then explain
- "what do eigenvalues represent?" → `{compute: false, explain: true}` → LLM-only
- "check my answer: eigenvalues are 2 and 0 for [[2,1],[1,2]]" → `{compute: true, verify: true}` → compute, compare to student answer

This makes the pipeline composable. Real student queries blend intents — forcing them into one category is a ceiling.

## Compute Lambda

- Python 3.11, SymPy + NumPy, no VPC, no DB
- Timeout: 30s, max matrix: 10x10, max polynomial degree: 20
- Returns verified results + verification status + confidence

```json
{
  "answer": {"eigenvalues": [3, 1], "characteristic_polynomial": "λ²-4λ+3"},
  "verification": {
    "method": "algebraic_substitution",
    "scope": "eigenvector_identity_Av_eq_lv",
    "guarantee": "local_correctness_only",
    "passed": true
  },
  "verification_status": "verified"
}
```

**Status values:** `verified` | `partial` | `failed`

**Verification method** (replaces fake-precision confidence floats):
- `algebraic_substitution` — strong (Av=λv, A·A⁻¹=I)
- `numeric_spot_check` — medium (evaluated at sample points)
- `heuristic_bounds` — weak (range/sanity checks only)

**Failure reason codes** (required when status != verified):
```
"failure_reason": "parse_error" | "unsupported_operation" | "dimension_mismatch" | "numerical_instability" | "timeout" | "validation_failed"
```

When status = `failed`, three distinct UX responses:

| Failure type | Response |
|-------------|----------|
| Parse error | "I couldn't interpret that as a math expression. Please format as [[1,2],[3,4]] or similar." |
| Unsupported operation | "I can't compute that operation yet. I can explain the method though." |
| Verification failed | "I computed a result but couldn't confirm it's correct. Here's what I'd try: [method explanation without claiming specific values]" |

## Supported Operations (Phased)

| Phase | Operations | Verification |
|-------|-----------|--------------|
| 1: Linear Algebra | Eigenvalues, determinants, inverse, RREF | Av=λv, A·A⁻¹=I |
| 2: Calculus | Derivatives, integrals, limits | Differentiate integral, numeric spot-check |
| 3: Statistics | Mean, std, correlation | Bounds checks |
| 4: Equations | Polynomial roots, systems | Substitute back |

## V1 Constraints

**Hard rules:**
- Only handles explicit input (student types the matrix/equation directly)
- Rejects all discourse references with structured guidance:
  ```
  I can't resolve "the matrix above" automatically.
  To compute accurately, please provide one of:
  • The matrix written out explicitly
  • The equation in standard notation
  ```
- No cross-message math persistence
- No implicit context binding

**Why:** Contextual reference resolution (v2) requires ingestion-time anchoring, disambiguation UX, and frontend coordination. The failure mode — confidently computing the wrong object — is worse than refusing.

## V2 Additions (data-driven trigger)

Ship v1, measure context-rejection rate. If >30% of compute-eligible queries hit the wall, fast-track v2:

- Referent grounding layer ("the matrix from Example 4" → find it in retrieved context)
- Disambiguation UX ("I found 2 matrices labeled Example 4. Which one?")
- Ingestion-time anchoring (tag every equation/matrix with a stable ID)
- `grounding_confidence` tracking

## Testing

Test bank is the primary quality gate:

| Category | Count |
|----------|-------|
| Known textbook results (2x2, 3x3, 4x4) | ~150 |
| Edge cases (singular, complex eigenvalues, repeated roots) | ~30 |
| Malformed input (graceful failure) | ~20 |
| Parser format coverage | ~50 |

CI blocks deployment if any known-correct case fails.

## Execution Trace

Every compute request logs a JSON trace with per-stage results + decision justification:

```json
{
  "trace_id": "uuid",
  "stages": [
    {"stage": "classifier", "result": "compute-required", "reason": "..."},
    {"stage": "parser", "result": {"sympy_input": "Matrix([[2,1],[1,2]])"}, "reason": "..."},
    {"stage": "validator", "result": {"valid": true}, "reason": "2x2 ≤ 10x10 limit"},
    {"stage": "compute", "result": {"eigenvalues": [3, 1]}, "latency_ms": 120},
    {"stage": "verify", "result": {"passed": true, "confidence": 0.99}, "reason": "Av=λv confirmed"}
  ],
  "final_status": "verified"
}
```

## Costs

| Item | Estimate |
|------|----------|
| Lambda compute | ~$2/month |
| Token amplification (math queries) | +10-20% (~$20-50/month at scale) |
| Provisioned concurrency (optional) | ~$15/month |
| Cold start (SymPy import) | ~2-4s first call |
| Warm latency (realistic) | 150-500ms per operation |

## Timeline

| Component | Effort |
|-----------|--------|
| Compute Lambda + SymPy operations | 2-3 days |
| Parser (explicit notation formats) | 2-3 days |
| Validator + classifier | 1-2 days |
| Integration with chatbot-v2 | 1-2 days |
| Test bank (200+ cases) | 3-4 days |
| CDK + deploy + integration testing | 1-2 days |
| **Total V1** | **10-14 days** |
| **V2 (referent grounding)** | **+8-12 days** |

## Remaining Risks

1. **Silent parser success with wrong interpretation — the most dangerous failure mode.** Input `"2 1 1 2"` has 3+ valid interpretations (2x2 matrix, 4D vector, flattened tensor). The ambiguity gate is now formalized, but it requires complete coverage: if structure inference requires ANY assumption → reject. The risk shifts from "system guesses wrong" to "ambiguity gate rules are incomplete" — a better problem to have.

2. **Render layer semantic drift — the hardest failure class to detect.** LLM will "correctly generalize incorrectly" (e.g., claiming geometric meaning not supported by output). V1 constraints are prompt-based (~95-98% compliance). Tail failures cluster on pedagogically important cases. V2 path: structured slot-filling where LLM has no free-form math narration capability.

3. **Confidence propagation is implicit in V1.** Parser state is binary: parsed cleanly (proceed) vs ambiguity-gated (reject). Anything more fine-grained (continuous confidence scores, gradient render constraints) will get ignored in implementation. Keep it binary for V1. V2 may add a 3-state model (clean / uncertain-but-proceed-with-caveat / rejected).

4. **Render strictness vs pedagogical value — the V2 tension.** V1 leans hard toward correctness: LLM cannot explain beyond compute output. This means it can say "eigenvalues are 3 and 1" but cannot say "this means stretching along eigenvectors." That removes educational value but guarantees no wrong explanations. This is deliberately chosen for V1. V2 must relax render constraints with guardrails — because a system that's correct but can't teach is a calculator, not a tutor.

5. **V1 context rejection + strict ambiguity = frequent "please clarify" responses.** Students write informally (shorthand, incomplete notation, "can you show me why this works"). The no-guessing principle is correct but UX-expensive. Expect friction. In production, the threshold may relax to "allow assumption if ambiguity is low + reversible" — but V1 stays strict to establish the correctness baseline first.

## Post-Launch Reality

**Week 1-3:** Parser dominates iteration time. Most failures are format mismatches.

**Week 3-6:** Classification ambiguity surfaces. Students don't fit clean categories.

**Ongoing:** Trace system becomes core product dashboard — used for debugging, improving classification, expanding parser, measuring V2 urgency.

**Biggest user-facing win:** correctness trust. Wrong math eliminated entirely for handled operations.

**Biggest user-facing friction:** "please provide directly" and cold-start latency spikes.

## V1 Scenario Walkthrough (real vs theoretical)

### Scenarios that work cleanly

| # | Input | Result | Notes |
|---|-------|--------|-------|
| 1 | `find eigenvalues of [[2,1],[1,2]]` | ✅ eigenvalues [3,1], verified | Baseline success case |
| 8 | `eigenvalues of [[1,2],[2,4]]` | ✅ eigenvalues [0,5], verified | Singular matrix — handled |
| 10 | `determinant of [[3,0],[0,4]]` | ✅ determinant = 12 | Trivial path |
| 13 | `eigenvalues of [[a,1],[1,a]]` | ✅ λ = a±1 (symbolic) | SymPy symbolic handling |
| 14 | `eigenvalues of 20x20 matrix` | ✅ "Matrix too large (limit 10x10)" | Guardrail works |
| 15 | `explain linear algebra intuitively` | ✅ LLM-only, no compute | Classifier routes correctly |

### Scenarios that work but stress the system

| # | Input | Pressure point |
|---|-------|---------------|
| 2 | `compute eigenvalues for matrix (2 1; 1 2)` | Parser must normalize `(a b; c d)` — this is core real-world format, not edge case |
| 3 | `A = \begin{bmatrix}2 & 1 \\ 1 & 2\end{bmatrix}, find eigenvalues` | LaTeX parsing required. Can kill V1 if not handled. |
| 5 | `walk me through solving eigenvalues for [[2,1],[1,2]]` | LLM must explain steps without introducing intermediate algebra not in compute output. Silent procedural hallucination risk. |
| 11 | `find eigenvalues and determinant of [[2,1],[1,2]]` | Multi-compute: ordering + structure integrity across two results |
| 12 | `what do eigenvalues represent, and compute them for [[2,1],[1,2]]` | Split intent: conceptual + compute. Two-pass required. Explanation may leak computation into reasoning. |

### Scenarios that expose design gaps

| # | Input | Problem | Required behavior |
|---|-------|---------|-------------------|
| 4 | `why does this matrix have repeated eigenvalues?` | No matrix provided. Default-to-compute triggers unnecessarily. | Compute runs on nothing → wasted Lambda, correct but wasteful |
| 6 | `check my work: eigenvalues are 2 and 0` | Matrix not provided. Can't verify without it. | "I need the matrix to verify. Please provide it." (UX friction) |
| 7 | `use the matrix above to compute eigenvalues` | Discourse reference. V1 cannot resolve. | "Please provide the matrix directly." (feels "stupid" to users) |
| 9 | `eigenvalues of matrix 2 1 1 2` | Ambiguous: [[2,1],[1,2]] or [2,1,1,2] vector? **Most dangerous failure if system guesses.** | Ambiguity gate fires: "Did you mean the 2x2 matrix [[2,1],[1,2]]?" — NEVER guess |

### What this reveals

**The system is actually 3 systems with different risk profiles:**

| System | Difficulty | Risk to correctness |
|--------|-----------|-------------------|
| Parser + ambiguity resolution | Hardest to build | Highest catastrophic risk (wrong problem) |
| Math execution (SymPy) | Solved problem | Lowest risk (deterministic) |
| Narrative render (LLM) | Hardest to constrain | Highest silent corruption risk (wrong explanation) |

**Irony:** SymPy — the component this entire project exists to add — is the least risky part. The parser (input) and renderer (output) are where failures actually live.

**Classification needs intent decomposition, not categories.** Multi-label flags (`{compute, explain, verify}`) handle blended queries. Mutually exclusive routing is a ceiling.

**Ambiguity gate is the single highest-value safety mechanism.** If input can be interpreted as multiple valid mathematical structures → STOP. This prevents the worst failure mode: verified correct math on the wrong problem.

**V1 is NOT a tutor.** It's a verified computation system with natural language projection. The product becomes a tutor only when V2 adds discourse tracking + conversational continuity.

## The Product Question

V1 is a **type-safe symbolic execution engine with probabilistic interfaces:**

- Core: deterministic math kernel (SymPy)
- Frontend: probabilistic parser (rules + format normalization)
- Output: constrained natural language renderer
- Safety: ambiguity rejection system (global invariant)

V1 deliberately chooses correctness over pedagogical richness:

| V1 tradeoff | Consequence |
|-------------|-------------|
| Strict render → correct but pedagogically thin | Students get right numbers, limited insight |
| No-guessing principle → safe but rigid | Frequent "please clarify" responses |
| Compute-first routing → reliable but slow on conceptual queries | 30-60% unnecessary Lambda calls |

**These are product decisions, not engineering limitations.** V2 relaxes each with guardrails:
- Render gets constrained-but-richer explanation (allow interpretations explicitly tagged as "conceptual, not computed")
- Ambiguity gate allows low-risk assumptions when reversible
- Routing gets semantic intelligence (embedding-based or LLM classifier)

**Classification scaling note:** rule-based multi-label routing is the first bottleneck. "Can you show me why this works" is simultaneously explanation, derivation, and walkthrough — no rule system resolves that cleanly. Expect LLM-based routing as first upgrade.

**Ship V1. Measure: context-rejection rate, "please clarify" frequency, user satisfaction with explanations. Let data drive V2 scope.**

**Core principle: know what you know, say what you don't.**
