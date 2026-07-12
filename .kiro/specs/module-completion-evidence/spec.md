# Evidence-Based Module Completion — Spec

**Status:** Phase 1 (diagnostic probe) **shipped to dev and measured** — see *Phase 1 Outcome* below. **Behavioral Phase 2 is on hold.** The one captured session did **not** reproduce the hypothesized canonical-matching starvation (`eval_kept == eval_raw` every turn); the binding constraint was **concept coverage** (2/5 demonstrated), so `module_score = 0` there is *consistent with the completion policy, not a defect*. §4.2 (index-based evaluator contract) is retained as an **optional future robustness** improvement, not an urgent fix. Keeps `module_score` **binary** (0 = not complete, 100 = complete) — a gradual score is out of scope.
**Area:** `cdk/chatbot_v2` only — `evaluation.py` (canonical-concept identification — the real unblocker), `state_machine.py` (`check_module_completion`), `main.py` (concept-tracking step + diagnostic logging). No DB migration, no API change, no frontend change, no IAM change.
**Refined via** `planning-refinement.md`. Built on a verified read of the completion pipeline (§2), which **corrects the original diagnosis**: `concepts_discussed` already includes `concepts_demonstrated`, so the field swap alone cannot loosen the gate (§3).

---

## 1. Problem Statement

`module_score` is binary and written by exactly one route (`POST /student/update_module_score`), which sets `100` iff the chatbot's terminal `llm_verdict` (`= state.module_complete`) is true. `module_complete` is set by `check_module_completion(state)`. Students who use a module see `module_score: 0` and it rarely (or never) reaches `100`.

Two things to fix:
- **Correctness:** completion should be gated on *evidence of understanding* (LLM-evaluated `concepts_demonstrated`), not on whether the student happened to type a topic's exact name (the current `concepts_discussed` substring path is a weak signal).
- **The stuck-at-0 symptom:** find and fix the condition that actually blocks completion — which requires measuring real sessions first, because the code does **not** behave the way the substring theory assumed (§3).

### Load-bearing facts (verified in code)
- **The completion gate** (`state_machine.py::check_module_completion`) requires ALL of: `interactions >= 5`; `len(concepts_discussed) >= ceil(0.5 × len(module_concepts))` (floor 1); `engagement_score >= 0.5`.
- **`module_complete` is latching** — `main.py` Step 6: `if not state.module_complete: state.module_complete = check_module_completion(state)`. Once true it stays true, and `update_module_score` never downgrades a `100`.
- **`concepts_discussed` is fed by TWO sources**, not one (`main.py`):
  - Step 5 (~L658): `if evaluation.concepts_demonstrated: demonstrate_concepts(...); discuss_concepts(state, evaluation.concepts_demonstrated)` — the LLM's demonstrated concepts are added to *discussed*.
  - Post-generation (~L862): `student_concepts = [c for c in state.module_concepts if c.lower() in message_content.lower()]; discuss_concepts(state, student_concepts)` — the substring path.
  - ⇒ **`concepts_discussed` ⊇ `concepts_demonstrated`** always.
- **`concepts_demonstrated` is the intended semantic signal** — its *plumbing* is solid; its *extraction correctness* is exactly what Phase 1/2 validate (the 4 plumbing checks):
  1. *Populated* only via `concept_tracker.demonstrate_concepts(state, evaluation.concepts_demonstrated)` (Step 5).
  2. *Canonical* — `evaluation.py::parse_evaluation_response` filters `concepts_demonstrated = [c for c in raw if c in module_concepts]`; `check_module_completion` compares against the same `module_concepts`. Same vocabulary.
  3. *Persists* — `demonstrate_concepts` does `list(state.concepts_demonstrated)` + append-if-absent (idempotent **accumulate**, never overwrite); `serialize_state`/`deserialize_state` round-trip it through DynamoDB.
  4. *No reset* — the only writer is `demonstrate_concepts`; `main.py` only ever reads the field elsewhere. The `= evaluator.concepts` overwrite failure mode does **not** exist.
  - *Not yet validated:* **semantic correctness**. The evaluator can overclaim — student says *"I don't understand Big O"*, evaluator returns `["Big O …"]` → the system records a demonstration that didn't happen. This is the correct signal *source*; Phase 1/2 validate its extraction quality (it is not a reason to avoid the signal, but a reason not to call it "reliable" before measuring).
- **The fragile link** is fact 2's filter: `c in module_concepts` is **exact string membership** against `generated_topics`, which are long descriptive phrases (e.g. *"Big O Notation and Algorithmic Complexity Analysis"*). Any evaluator output that isn't an exact match is silently dropped — starving `concepts_demonstrated` (and therefore `concepts_discussed`).
- **Evaluation doesn't run on turn 1** — `eval_should_run = state.interactions > 0 and message_content`; `interactions` increments at end of turn. So demonstrations accrue from turn 2 onward (fine — completion needs `interactions >= 5`).

---

## Phase 1 Outcome — measured (2026-07-12, n=1)

The probe shipped to **dev** and one real session was captured (`session f5a245a5`, module "Week 2 Algorithms", 5 topics, `required_concepts = 3`), read in the §4.1 priority order:

| turn | interactions | demonstrated (accum.) | RAW → KEPT (this turn) | engagement | missing_requirements |
|---|---|---|---|---|---|
| 1 | 0 | 0 | `[]` → `[]` | 0.0 | interactions, concept_coverage, engagement |
| 2 | 1 | 1 | `[Bubble]` → `[Bubble]` | 0.1 | interactions, concept_coverage, engagement |
| 3 | 2 | 2 | `[BigO]` → `[BigO]` | 0.3 | interactions, concept_coverage, engagement |
| 4 | 3 | 2 | `[BigO,Bubble]` → `[BigO,Bubble]` | 0.5 | interactions, concept_coverage |
| 5 | 4 | 2 | `[Bubble,BigO]` → `[Bubble,BigO]` | 0.7 | interactions, concept_coverage |
| 6 | 5 | 2 | `[BigO,Bubble]` → `[BigO,Bubble]` | 0.9 | **concept_coverage** |

**Findings (§4.1 order):** (1) **Extraction ✓** — the evaluator emitted demonstrated concepts every evaluated turn. (2) **Canonicalization loss ✗ — NOT reproduced** — `eval_kept == eval_raw` on *every* turn; the evaluator returned the exact canonical phrases, so the `c in module_concepts` filter dropped nothing. (3) **Binding constraint = `concept_coverage`** — the student demonstrated **2 of 5** topics (needs 3); `interactions` and `engagement` cleared on their own.

**Conclusion (deliberately cautious):** for the observed session, `module_score = 0` is **consistent with the current completion policy and does not indicate a defect** — the student genuinely covered 2/5 topics. One session does **not** prove the 50% threshold is pedagogically right, that most students can realistically reach it, that evaluator behavior is reliable at scale, or that the completion *rate* is acceptable — those remain product/UX questions. In short: this looks like a **completion-expectation mismatch, not a correctness bug**, and the original *canonical-matching-starvation* hypothesis was **not supported by the data**.

### Revised priorities (this replaces the P0=fix framing)
- **P0 — Keep the probe telemetry.** Non-behavioral; it already did its job (invalidated the starvation hypothesis) and is now ongoing completion-health data.
- **P1 — Observe completion behavior at scale** before any behavioral change (honoring §2.1 "measure before changing behavior").
- **P2 — Index-based evaluator contract (§4.2): optional future robustness** — justification is "reduce future evaluator drift," *not* "fix today's bug."
- **P3 — Tune the completion policy only if product data warrants** (see below).

### The two-dimensional model is validated
The data confirms two **distinct** questions, correctly kept separate — do not collapse them into one number:
- **Progress** — `course_progress.concept_mastery` (per-topic, e.g. Big O 100% · Bubble 80% · Quick Sort 0%).
- **Completion** — `Student_Modules.module_score` (binary: *has the learner met the module's completion criteria?*).

### Before touching thresholds — collect, don't guess
Do **not** change `CONCEPTS_DISCUSSED_COMPLETION_RATIO = 0.5` yet. First gather, across many sessions: completed vs. incomplete counts, and the distribution of concepts-demonstrated at session end. Decision rule:
- *Healthy* (most students reach 3–5 topics, reasonable completion rate) → leave `0.5`; the observed `0` was just an in-progress student.
- *Too strict* (most students plateau at ~2, completion rate very low) → open a threshold discussion.

Revisit the index-based contract (§4.2) only if `eval_kept < eval_raw` appears in future sessions.

---

## 2. Principles

**2.1 Measure before changing behavior.** The substring theory is disproven by the code (§3); the true binding constraint must be observed on real sessions before any gate change. Ship diagnostic logging first (non-behavioral), then fix with data.

**2.2 Completion is evidence-based.** The gate should count *demonstrated understanding* (LLM-evaluated, canonical) — not conversational coincidence. Remove reliance on the substring signal.

**2.3 Keep `module_score` binary.** `0 = not complete`, `100 = complete` is a sound product model. No gradual score in this spec (deferred — §5).

**2.4 Smallest correct change.** Prefer a one-line gate change + an upstream matching fix over new subsystems. No DB/API/frontend change.

---

## 3. Key correction to the original diagnosis (why the field swap isn't the fix)

The proposal was: replace `concepts_discussed` (substring) with `concepts_demonstrated` (LLM) in the gate, to fix stuck-at-0. But **`concepts_discussed` already ⊇ `concepts_demonstrated`** (§2, Step 5 feeds demonstrated → discussed). Therefore:
- Swapping the gate field is **equal-or-stricter**, never looser — it **cannot** by itself make a stuck-at-0 module complete.
- The gate change is still worthwhile as a **correctness** change: it drops the weak substring signal so completion reflects evidence, and it prevents *false* completions where an incidental substring inflates `concepts_discussed`. It is best understood as **replacing lexical evidence with semantic evidence** — semantically *stricter*, not a loosening (§13).
- The **actual** stuck-at-0 cause is almost certainly upstream: the exact-match filter (§2, fragile link) starves `concepts_demonstrated`, so neither count reaches `ceil(0.5 × topics)`. That is what the Phase 1 logging will confirm or refute.

So this spec keeps the evidence-based gate (the proposal's intent) **and** targets the real bottleneck, in that order.

---

## 4. Design (phased)

### Phase 1 — Diagnostic logging (ship first; no behavior change)

Add one structured Powertools log line per evaluated turn in `main.py`, right after Step 6 (completion check), capturing the exact values that drive the gate — plus the **raw vs. canonical-filtered** evaluator concepts, so the "exact-match drop" failure mode is visible:

```text
logger.info("module_completion_probe", extra={
    "module_concepts_count": len(state.module_concepts),
    "concepts_exposed": state.concepts_exposed,
    "concepts_discussed": state.concepts_discussed,
    "concepts_demonstrated": state.concepts_demonstrated,
    "eval_raw_demonstrated": <raw evaluator list BEFORE the module_concepts filter>,
    "eval_kept_demonstrated": <list AFTER the filter>,
    "interactions": state.interactions,
    "engagement_score": state.engagement_score,
    "required_concepts": required_concepts_discussed(len(state.module_concepts)),
    "module_complete": state.module_complete,
    "missing_requirements": missing,   # derived — which requirements aren't met yet (see below)
})
```

To capture `eval_raw_demonstrated` vs `eval_kept_demonstrated`, `parse_evaluation_response` (evaluation.py) must surface both (e.g. keep the raw list on `EvaluationResult` as a debug-only field, or log the drop inside the parser). Correlated by the existing `session_id`/`course_id` appended keys.

`missing_requirements` is derived from the same inputs so every log names *which* completion requirements aren't met yet. It is named neutrally on purpose: a non-empty list is usually just normal in-progress, not an error ("blocker" would over-imply failure). No manual recomputation; dashboard-ready:
```text
missing = []
if state.interactions < MIN_INTERACTIONS_FOR_COMPLETION:         missing.append("interactions")
if len(<gate list>) < required_concepts:                         missing.append("concept_coverage")
if state.engagement_score < MIN_ENGAGEMENT_SCORE_FOR_COMPLETION: missing.append("engagement")
# [] ⇒ complete. Gate list is concepts_discussed in Phase 1; concepts_demonstrated after §4.3.
```

**Exit criteria for Phase 1:** run a handful of real student sessions and read the probe, diagnosing in this **priority order** (each step only matters if the previous passed):
1. **Extraction** — does the evaluator produce **raw** demonstrated concepts at all? (`eval_raw_demonstrated` non-empty)
2. **Canonicalization loss** — are they being **discarded** by the exact-string filter? (`eval_kept_demonstrated` ≪ `eval_raw_demonstrated`)
3. **Gate coverage** — are the surviving `concepts_demonstrated` **enough** for the gate? (`≥ required_concepts`)
4. **Other thresholds** — is **engagement/interactions** the binding constraint instead?

`missing_requirements` names which of #3/#4 bind. This order isolates the failure to extraction (evaluator), data contract (canonicalization), coverage, or thresholds — and selects the Phase 2 emphasis. (`concepts_discussed ⊇ concepts_demonstrated` always holds, but both can legitimately be `[]` early; the load-bearing question is #1 → #2.)

### Phase 2 — Fix identification, then the gate · STATUS: DEFERRED (see *Phase 1 Outcome*)

> **Deferred after Phase 1 (n=1).** The measured session did not reproduce canonicalization loss (`eval_kept == eval_raw`) and the binding constraint was coverage, not matching — so Phase 2 is **not an urgent remediation**. §4.2 is retained below as an **optional future robustness** improvement (justification: reduce future evaluator drift, *not* fix today's bug); §4.3 waits on scale data + a product decision on the threshold. Kept in full for when the data warrants.

Order matters: once concept identification is trustworthy (4.2), the gate change (4.3) is almost trivial and observably correct.

**4.2 Fix canonical concept identification — FUTURE ROBUSTNESS (not an urgent fix; see *Phase 1 Outcome*).** *Originally hypothesized as the real unblocker; the one measured session did not support that — `eval_kept == eval_raw`, no canonicalization loss.* It remains a sound investment: **change the evaluator's data contract to emit canonical concept INDEXES instead of free-text strings** — eliminating string matching (and its ambiguity) entirely, rather than adding matching intelligence to compensate for a bad contract. Justification is now *reduce future evaluator drift risk*, not *fix today's bug*; pursue it only if the probe shows `eval_kept < eval_raw` at scale.

**Target implementation — index-based output (do this directly).** Number the vocabulary in the eval prompt and have the model return **indexes**:
```text
Concepts:
  0. Big O Notation and Algorithmic Complexity Analysis
  1. Merge Sort, Quick Sort, and Divide & Conquer Algorithms
  2. Binary Search on Sorted Data
Return the indexes of the concepts the student demonstrated (and misunderstood).
```
`parse_evaluation_response` maps each index → `module_concepts[i]` (validate in range; ignore out-of-range). This is a prompt + parser change in `evaluation.py`. **Go straight to indexes — do not ship two parsing formats**, which would leave a permanent `if isinstance(concept, int): … else: normalized_match(…)` compatibility branch.

> **Invariant (required by index-based output):** a session's `state.module_concepts` **ordering is immutable for the lifetime of the session** — indexes are only meaningful against that fixed ordering. It is loaded once from `Course_Modules.generated_topics` on session creation and persisted in the DynamoDB session state (verified), so ordering is already stable per session; this spec elevates that to an explicit, documented invariant. A future `module_concept_version` could harden it across topic regenerations, but is out of scope.

**Transitional fallback (only if needed) — normalized-exact:** `lower()` + `strip()` + collapsed-whitespace equality, storing the canonical string. Include this **only** as a short compatibility window for in-flight sessions whose evaluator still emits strings; it is not a second permanent path. If no such window is required, skip it and ship indexes alone.

**Explicitly rejected — substring/containment matching (either direction):** one evaluator token (e.g. `"Algorithms"`) can be contained in several canonical entries (*Sorting Algorithms*, *Search Algorithms*, …), silently assigning wrong evidence (§5.6). Indexes are unambiguous by construction. Phase 1's `eval_raw_demonstrated` vs `eval_kept_demonstrated` quantifies how much the current exact-string filter is discarding — confirming this contract change is the fix before it ships.

**4.3 Change the completion gate to demonstrated evidence.** With identification fixed, switch `check_module_completion` from `concepts_discussed` to `concepts_demonstrated`:
```text
required = max(1, ceil(CONCEPTS_DISCUSSED_COMPLETION_RATIO * len(state.module_concepts)))
return (state.interactions >= MIN_INTERACTIONS_FOR_COMPLETION
        and len(state.concepts_demonstrated) >= required
        and state.engagement_score >= MIN_ENGAGEMENT_SCORE_FOR_COMPLETION)
```
This replaces *lexical* evidence with *semantic* evidence — semantically **stricter**, not a loosening (a student who merely typed a topic name no longer counts). Completions rise only where 4.2 lets **valid** demonstrations through. *If the probe shows thresholds are the blocker:* revisit `MIN_INTERACTIONS_FOR_COMPLETION` / ratio / `MIN_ENGAGEMENT_SCORE_FOR_COMPLETION` in `constants/models.py` — a tuning decision surfaced for approval, not changed blindly.

**4.4 Latching unchanged.** `module_complete` stays set-once; `update_module_score` stays non-downgrading. No change to the write path, the endpoint, or the frontend — a completing student's next terminal turn sends `llm_verdict=true` → `module_score=100`, exactly as today.

---

## 5. Explicitly rejected alternatives

1. **Keyword / token-overlap matching for "discussed."** Better than full-phrase substring, but it needs synonym lists, stemming, and domain vocabulary, and it produces false positives that aren't evidence of understanding (e.g. *"Big O is confusing"* would count as covered). The LLM evaluator already yields a stronger, meaning-aware signal — use it instead. Rejected.
2. **Gradual 0–100 `module_score`.** The binary complete/not-complete model is fine and matches the write path's semantics. Overloading it with a partial value (e.g. `73`) raises unanswerable questions — mastery? monotonic? can it decrease? UI percentage? instructor meaning? Keep the two concepts **separate**: `Student_Modules.module_score`/`module_complete` = the binary gate; per-concept mastery already lives in `course_progress` → `derived_summary.concept_mastery`. Rejected for now.
3. **Field swap alone as the stuck-at-0 fix.** Disproven by §3 (`discussed ⊇ demonstrated`) — it's equal-or-stricter. Kept only as a correctness change, paired with 4.3. Rejected as a standalone fix.
4. **Changing behavior before logging.** The substring theory was wrong once already; ship the probe (Phase 1) and let data pick the Phase 2 fix. Rejected.
5. **Writing `module_score` from `chatbot_v2` directly.** The frontend→`update_module_score` path already works and is unchanged; adding a second writer (and DynamoDB→Postgres coupling) is unnecessary. Rejected.
6. **Substring / containment matching of evaluator output → canonical concepts.** One evaluator token (e.g. `"Algorithms"`) can be contained in several canonical entries, silently misattributing evidence. Use normalized-exact (unique) or index-based (unambiguous) only — see §4.2. Rejected.

---

## 6. Tasks (phased)

**Phase 1 — Diagnostic (non-behavioral)**
- [ ] **T1.** `evaluation.py`: surface the raw (pre-filter) demonstrated/misunderstood concepts alongside the canonical-filtered ones (debug-only field on `EvaluationResult`, or an in-parser drop log). Keep `DEFAULT_EVALUATION` behavior unchanged. *Tests: parser keeps raw + filtered; exact-match drop is observable.*
- [ ] **T2.** `main.py`: add the `module_completion_probe` structured log after Step 6 (§4.1), including the derived `missing_requirements` list. No behavior change. *Test: extract the derivation as a pure helper — assert each unmet condition adds its requirement name and an all-pass state yields `[]`.*
- [ ] **T3.** Run real sessions; record the probe output; confirm `discussed ⊇ demonstrated` and identify the binding constraint. (Manual; gates Phase 2 choice.)

**Phase 2 — Fix (behavioral; ships together)**
- [ ] **T4.** `evaluation.py`: change the evaluator contract to **index-based** output (§4.2) — numbered vocabulary in the prompt; `parse_evaluation_response` maps in-range indexes → `module_concepts[i]`; document the immutable-ordering invariant. Normalized-exact only if a compatibility window is required. **No containment matching.** *Tests: index → `module_concepts[i]`; out-of-range index ignored; empty/garbage → dropped; (if fallback kept) case/whitespace variant → canonical.*
- [ ] **T5.** `state_machine.py`: `check_module_completion` counts `len(concepts_demonstrated)` (§4.3). *Tests: T-1..T-4 below.*
- [ ] **T6.** (Optional, if the probe shows thresholds) surface a thresholds tuning proposal for approval — do not change `constants/models.py` blindly.
- [ ] **T7.** Run `cd cdk && python -m pytest chatbot_v2/ -v`.

**Deferred (separate, optional)**
- [ ] **T8.** Rename `concepts_discussed` → `concepts_explored` (§11) — mechanical, no logic change, its own PR.

---

## 7. Test Strategy

pytest, colocated `test_*.py` in `chatbot_v2/`, deterministic (mock Bedrock — no real model). Run: `cd cdk && python -m pytest chatbot_v2/ -v`.

Gate tests (`test_module_completion.py`, extends existing):
- **T-1 — completes on demonstrated evidence:** `interactions=5`, `concepts_demonstrated=["Big O Notation …","Merge Sort …","Binary Search …"]` (≥ `ceil(0.5×5)=3` of 5 topics), `engagement_score=0.8` → `check_module_completion(state) is True`.
- **T-2 — no verbatim topic names needed:** feed an evaluation whose `concepts_demonstrated` is non-empty while the student message contains none of the topic phrases verbatim; assert the module can still complete (guards against reintroducing substring dependence). Pairs with an assertion that `concepts_discussed ⊇ concepts_demonstrated` (documents the §3 invariant).
- **T-3 — insufficient coverage:** `concepts_demonstrated=["Big O Notation …"]` (1 of 5, `< 3`) → `False`.
- **T-4 — accumulates across turns:** apply `demonstrate_concepts` on turn 2 (`A`) and turn 5 (`B`); assert `concepts_demonstrated == ["A","B"]` (not `["B"]`) — the non-overwrite guarantee.

Identification tests (`test_evaluation.py`, T4): an in-range index → `module_concepts[i]`; an out-of-range index → ignored; empty/garbage evaluator output → dropped; (only if the transitional normalized-exact fallback is kept) a case/whitespace variant → the canonical string. There is no containment path to test — that's the point.

Probe helper test (T2): the `missing_requirements` derivation is a pure function — each unmet condition appends its requirement name; an all-pass state ⇒ `[]`.

Parser test (T1): `parse_evaluation_response` exposes both raw and filtered lists; a raw concept absent from `module_concepts` appears in raw but not filtered.

---

## 8. Non-Goals
- No gradual `module_score` (stays binary — §5.2).
- No DB migration, no `update_module_score` / OpenAPI / frontend change, no IAM change.
- No new writer of `module_score` (the frontend→endpoint path is unchanged).
- The `concepts_discussed → concepts_explored` rename is deferred (§11), not part of Phase 1/2.

## 9. Observability
Phase 1 *is* the observability deliverable: the `module_completion_probe` structured log (correlated by `session_id`/`course_id`) exposes every gate input plus the raw-vs-filtered evaluator concepts, so the binding constraint and any exact-match drop are directly visible in CloudWatch. No new metric pipeline. The probe can stay (INFO) after the fix as an ongoing completion-health signal.

## 10. Acceptance Criteria
- **AC-1 (Phase 1):** every evaluated turn emits `module_completion_probe` with all gate inputs + `eval_raw_demonstrated` / `eval_kept_demonstrated` + the derived `missing_requirements` list; no behavior change (completion outcomes identical to pre-change for the same inputs).
- **AC-2:** real-session logs confirm `concepts_discussed ⊇ concepts_demonstrated` (the §3 invariant) and identify the binding constraint.
- **AC-3 (Phase 2 gate):** `check_module_completion` uses `len(concepts_demonstrated)`; T-1..T-4 pass.
- **AC-3b (Phase 2 identification):** the evaluator emits canonical **indexes** resolved to `module_concepts[i]` (in-range only; out-of-range ignored); containment is not used; the session's `module_concepts` ordering is immutable so stored indexes stay meaningful.
- **AC-4 (Phase 2 fix):** the identification fix lets a student who demonstrates ≥ 50% of a long-phrase module's topics reach `module_complete=True` (→ `module_score=100` via the unchanged verdict path) on **semantic** evidence — without typing topic names verbatim.
- **AC-5:** completion remains latching and non-downgrading; a genuinely-unknown concept is still not counted.
- **AC-6:** `cd cdk && python -m pytest chatbot_v2/ -v` passes.

## 11. Deferred: rename `concepts_discussed` (optional, separate PR)
`concepts_discussed` implies a weak signal. Longer term, prefer a clearer vocabulary:
- `concepts_explored` — conversational coverage (what the current discussed/exposed lists mean),
- `concepts_demonstrated` — evidence of understanding (unchanged),
- `module_complete` — the final gate.

This is a mechanical rename touching `state_machine.py` (field + `serialize_state`/`deserialize_state` keys — needs a back-compat read of the old key), `concept_tracker.py`, and `main.py`. No logic change. Kept out of Phase 1/2 to keep the behavioral change reviewable; it also leaves room to add partial-progress reporting later without overloading semantics.

## 12. Refinement history
- **Draft:** implement the proposal — swap the completion gate from `concepts_discussed` to `concepts_demonstrated`, log first, add regression tests, optional rename.
- **Verification pass (pre-spec):** read the completion pipeline end-to-end and found `main.py` Step 5 already feeds `evaluation.concepts_demonstrated` into `concepts_discussed`, so `discussed ⊇ demonstrated`. This **invalidates the field swap as a stuck-at-0 fix** and pinpoints the exact-match canonical filter (`evaluation.py`) as the likely real bottleneck. Confirmed `concepts_demonstrated` is reliable (canonical, accumulated, persisted, no reset).
- **Restructure:** kept the proposal's intent (evidence-based gate, binary score, log-first, tests, rename) but reframed the swap as a *correctness* change that must ship with an upstream fix, and made Phase 1 diagnostics the gating first step so the Phase 2 fix is data-selected.
- **Reviewer round 1:** rejected containment matching (ambiguous — misattributes evidence); introduced index-based evaluator output; **reordered Phase 2** to fix identification (§4.2) *before* the gate change (§4.3); added the derived probe field; reframed the gate change as *lexical → semantic* (stricter, not a loosening); reinforced keeping `module_score` binary (keep mastery in `course_progress`).
- **Reviewer round 2:** made **index-based output the definitive implementation** (not co-equal with normalized-exact); demoted normalized-exact to an optional transitional fallback (avoid a permanent dual-parse path); added the **immutable `module_concepts` ordering invariant** that index-based output depends on; softened "reliable signal" → "intended semantic signal, extraction validated by Phase 1/2" (evaluator can overclaim); reordered the Phase 1 diagnosis to extraction → canonicalization-loss → coverage → thresholds; renamed `completion_blockers` → **`missing_requirements`** (neutral — in-progress isn't an error).
- **Phase 1 outcome (measured, n=1, 2026-07-12):** probe shipped to dev; one session showed `eval_kept == eval_raw` every turn (no canonicalization loss) with `concept_coverage` the sole remaining blocker (2/5 demonstrated < 3 required). **The canonical-matching-starvation hypothesis was NOT reproduced** — reframed as a likely completion-expectation question, not a correctness bug. Priorities reordered (P0 keep probe telemetry → P1 observe at scale → P2 index contract as optional robustness → P3 threshold tuning only if product data warrants); behavioral Phase 2 held; two-dimensional model (binary completion vs. granular mastery) validated. Recorded as ADR-007 in `engineering-log.md`.

## 13. Residual Risks / Open Items (honest notes)
- **The hypothesized unblocker was tested and NOT reproduced (measured, n=1).** Phase 1 showed the binding constraint was `concept_coverage`, not canonicalization loss (`eval_kept == eval_raw`). So neither the gate change (§4.3) nor the identification fix (§4.2) is a stuck-at-0 remedy on current evidence — §4.2 is optional future robustness; revisit only if `eval_kept < eval_raw` appears at scale. See *Phase 1 Outcome*. **(n=1 — directional, not conclusive.)**
- **Index-based output depends on stable ordering.** It's unambiguous by construction, but its one requirement is the **immutable `module_concepts` ordering per session** (§4.2 invariant): if a session's vocabulary were ever reordered mid-life, stored indexes would mismap. Verified stable today (loaded once, persisted); a `module_concept_version` would harden it against topic regenerations later. Covered by T4 tests.
- **Semantic change, not a loosening.** The gate moves from *lexical* evidence (typed a topic name) to *semantic* evidence (LLM judged it demonstrated) — semantically stricter, with likely **fewer false positives**. Completions rise only where §4.2 lets **valid** demonstrations through. It still changes what `module_score=100` means in practice, so a product sign-off is worthwhile — especially if thresholds are tuned (T6).
- **LLM evaluator variance** — demonstrations depend on a model call; `DEFAULT_EVALUATION` (on failure) records nothing, so a flaky eval slows completion. Acceptable; the probe makes it visible.
- **Rename back-compat** — if pursued (§11), `deserialize_state` must read the old `concepts_discussed` key for in-flight DynamoDB sessions.
