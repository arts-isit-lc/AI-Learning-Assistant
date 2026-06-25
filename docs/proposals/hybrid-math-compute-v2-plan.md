# Hybrid Math Compute V2 — Implementation Spec

## 1. Goal

Build a **verified step-by-step math tutoring system** that:

- Uses **SymPy as the single source of truth**
- Generates a **canonical solution path**
- Guides students through steps interactively
- Prevents hallucinated or unverified math in explanations

The system is a **deterministic solver + constrained tutor UI**, not a general reasoning agent.

## 2. Core Principle

> Every explanation step must be either:
>
> 1. Directly derived from SymPy output
> 2. A valid algebraic transformation of a known step
> 3. A precomputed step in the canonical solution path

No new mathematical facts are ever introduced in language.

## 3. System Pipeline

### Step 1 — Parse Input

- Convert student problem into SymPy-compatible form
- If ambiguous → request clarification (no guessing)

### Step 2 — Compute Ground Truth (SymPy)

Produces:

- Final result `M`
- Optional metadata (eigenvalues, determinant, etc.)

This is the **only authoritative math computation layer**.

### Step 3 — Generate Canonical Solution Steps

Generate a **single structured solution path**:

```
Step 1: Form equation / matrix expression
Step 2: Apply transformation (e.g., det(A - λI))
Step 3: Simplify expression
Step 4: Solve final equation
```

Each step includes:

- Expected expression result
- Allowed transformation type

This is a **linear step list (not a DAG in V2.0)**.

### Step 4 — Define Rewrite Rules (Validation Layer)

A small fixed set of allowed transformations:

- expand determinant
- factor polynomial
- distribute terms
- simplify expressions
- rearrange algebraically

Used ONLY to validate student intermediate work.

Two validations:

- **Final answer check:** `simplify(student_answer - M) == 0`
- **Step check:** Must match expected step OR be valid via rewrite rules

### Step 5 — Tutor Runtime (Interaction Engine)

Maintains:

- current step index
- stuck counter
- student attempt history

Behavior:

| Student action | System response |
|---------------|----------------|
| Correct answer | Advance to next step |
| Incorrect answer | Give targeted hint based on step definition |
| Stuck (repeated failures) | Reveal current step output and move forward |
| "Just give me the answer" | Return SymPy result `M` |
| Valid but unexpected method | "Correct approach, but I don't have step-by-step guidance for this method. I can verify your result." |

## 4. Output Rules (Hard Constraints)

The tutor may only output:

- Values from SymPy result `M`
- Expressions from canonical step list
- Algebraically equivalent transformations (via SymPy simplify)
- Hints derived from step definitions

Forbidden:

- New formulas
- New mathematical claims
- Alternative solution methods not in step list (except verification mode)
- Geometric or conceptual interpretations not derived from SymPy facts

## 5. Error Handling Modes

| Situation | System Behavior |
|-----------|----------------|
| Ambiguous input | Ask clarification |
| Invalid math step | Explain local error + hint |
| Wrong answer | Compare vs expected step, guide correction |
| Stuck repeatedly | Reveal step |
| Alternative valid method | Verify only, no guidance |
| Request full solution | Return full step list + final answer |

## 6. System Architecture

```
User Input
   ↓
Parser (SymPy conversion)
   ↓
SymPy Solver (ground truth M)
   ↓
Step Generator (canonical solution path)
   ↓
Rewrite Rule Validator
   ↓
Tutor Runtime (state machine)
   ↓
LLM Renderer (constrained output only)
```

## 7. What V2 Is (Simple Definition)

> A deterministic math solver wrapped in a constrained step-by-step teaching interface.

Not:

- a reasoning agent
- a proof system
- a formal verifier

Just:

> "SymPy + structured solution steps + strict tutoring rules"

## 8. Success Criteria

The system is correct if:

- Final answers always match SymPy
- Every displayed step is verifiable
- No new math appears in explanations
- Students can progress step-by-step without confusion leakage

## 9. Explicit Non-Goals (Important)

- No multi-path reasoning graph (V2.1+)
- No ML-based student modeling
- No formal proof completeness guarantees
- No interpretation / intuition layer
- No adaptive pedagogy beyond stuck detection
