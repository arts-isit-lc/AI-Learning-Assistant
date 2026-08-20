# Contextual Grounding — Enable the Guardrail's Grounding/Relevance Checks

Status: **PLAN — not started.** No implementation yet; awaiting go-ahead. This
doc captures the plan so it isn't lost.

## Problem

The Bedrock guardrail defined in `cdk/lib/api-gateway-stack.ts` declares
contextual-grounding filters:

```ts
contextualGroundingPolicyConfig: {
  filtersConfig: [
    { type: 'GROUNDING', threshold: 0.7 },
    { type: 'RELEVANCE', threshold: 0.7 },
  ],
},
```

but they are **inert** — in prod the block trace shows
`contextualGroundingPolicyUnits: 0`, i.e. the filters never evaluate. Contextual
grounding only runs when the request tags a `grounding_source` (the reference
material) and a `query` (the user question). The `chatbot_v2` Lambda never emits
those tags, so today this is dead config.

Goal: make the grounding/relevance checks actually function, so the bot can
catch hallucinated or off-source claims — a real concern for an educational RAG
tutor.

## The central tension (why "just turn it on at 0.7" is wrong)

The chatbot is a **Socratic tutor**. Its responses are frequently probing
questions, encouragement, and hints — *not* grounded factual statements that
answer the literal query. GROUNDING and especially RELEVANCE at 0.7 would very
likely block a large fraction of legitimate Socratic turns — the same class of
false positive we just eliminated on the input side (see the guardContent
input-scoping fix in `streaming.py`). Blocking on day one is the wrong move.
**Recommendation: monitor-first rollout.**

## Verified facts (AWS docs, 2026-08-20)

- Contextual grounding filters support `action: NONE` — "take no action but
  return detection information in the trace response" — so we can evaluate and
  trace scores WITHOUT blocking. (`GuardrailContextualGroundingFilterConfig`,
  JS/Python SDK refs.) `action: BLOCK` is the enforcing mode.
- The check requires `grounding_source` (reference) + `query` (user question)
  tags; multiple tags of each type are combined and evaluated together.
- XML input tagging (`wrap_user_message`) applies only to InvokeModel; the
  Converse API uses `guardContent` content blocks with `qualifiers`.
- OPEN (needs Phase 0 validation): whether a `query`-qualified user block is
  STILL scanned by the input content/prompt-attack filters (the thing our
  input-scoping fix relies on); whether the pinned `aws-cdk-lib ^2.263.0`
  `CfnGuardrail` exposes `action` on contextual-grounding filters; whether the
  model reads `grounding_source` content for generation (decides if we can avoid
  duplicating the RAG context).

## Current data flow (as-is)

- `rag_context = retrieval_result.answer` (main.py ~775), then optionally
  appended with figure/table/formula grounding descriptions (~828).
- `rag_context` is folded into the **system prompt** text via
  `build_system_prompt` (prompt_builder.py section 7). It is NEVER passed
  separately to the model or to a guardContent block.
- Generation entry: `main._stream_with_guardrail_retry(system_prompt,
  user_message, prompt_history, session_id, model_kwargs, guardrail_id)` →
  `streaming.stream_response(...)` → `_iter_converse_events(...)`.
- `_iter_converse_events` (post input-scoping fix): history turns are plain
  `{"text": ...}`; the current user message is wrapped
  `{"guardContent": {"text": {"text": user_message}}}` (no qualifiers) to scope
  INPUT filters to just that message; `system_prompt` goes to
  `converse_kwargs["system"]` as plain text (not assessed).
- Turns with NO `rag_context`: the **completion turn** (`mode == "complete"`,
  rag_context forced `""`) and the **tutor turn** (returns early, uses
  `build_tutor_system_prompt`, no retrieval). The **greeting turn** DOES keep
  rag_context (only visual blocks are skipped).
- OUTPUT blocks (where contextual grounding lands) surface via
  `_iter_converse_events` metadata → `outputAssessment` → `block_type="output"`
  → `build_intervention_result` → `GUARDRAIL_REDIRECT_OUTPUT` ("Let me rephrase
  my response to stay focused on the course material.").

## Proposed approach (phased, flag-gated)

### Phase 0 — Validation spike (dev, throwaway script, no product code)
Confirm against the real dev guardrail:
1. The exact `guardContent` shapes (`query` on the user message,
   `grounding_source` on the RAG context) that make
   `contextualGroundingPolicyUnits > 0` and surface grounding/relevance scores
   in the trace.
2. Whether a `query`-qualified user block is still scanned by the input
   content/prompt-attack filters. If NOT, keep a separate plain `guardContent`
   block for input scoping so the shipped fix doesn't regress.
3. Whether the pinned `CfnGuardrail` supports `action` on contextual-grounding
   filters (else use an escape hatch / `addPropertyOverride`).
4. Whether the model reads `grounding_source` for generation (decides whether we
   can drop the duplicate RAG context from the system prompt).

### Phase 1 — CDK: monitor mode
- Set the two contextual-grounding filters to `action: NONE` (evaluate + trace,
  don't block), keep `enabled`. New guardrail version + Jest assertion test.
- Safe, reversible guardrail change.

### Phase 2 — Lambda: wire the tags behind `ENABLE_CONTEXTUAL_GROUNDING` (default OFF)
- Thread the raw `rag_context` and the user query down through
  `_stream_with_guardrail_retry` → `stream_response` → `_iter_converse_events`.
- In `_iter_converse_events`, when grounding is enabled AND `rag_context` is
  non-empty: add a `grounding_source` block (RAG context) and a `query` block
  (user message), while PRESERVING the existing plain `guardContent`
  input-scoping block.
- Only on turns with real context: **skip the tutor turn and the completion
  turn** (no rag_context — a `query` with no `grounding_source` can't ground and
  risks blocking everything). Greeting keeps its context, so it's fine.
- Capture grounding/relevance scores from the `outputAssessment` trace and emit
  a structured `grounding_probe` log every turn (data even while `action:NONE`).
- Initially KEEP `rag_context` in the system prompt too (Phase 0 decides if we
  can de-dupe) to avoid degrading generation quality.

### Phase 3 — Measure & decide (separate follow-up)
- Run in dev, gather the grounding/relevance score distribution over real
  Socratic turns, then choose final thresholds and whether to flip GROUNDING to
  `BLOCK`. Expectation: keep RELEVANCE non-blocking (Socratic redirects
  legitimately diverge from the literal query); enforce GROUNDING at a tuned
  threshold.

## Files likely touched

- `cdk/lib/api-gateway-stack.ts` (grounding filter `action`),
  `cdk/test/*guardrail*.test.ts`
- `cdk/chatbot_v2/src/streaming.py`, `main.py`, `flags.py`, and prompt/streaming
  tests
- `cdk/chatbot_v2/src/guardrails.py` only if we add a grounding-specific surface

## Risks / tradeoffs

- **Over-blocking** Socratic turns → mitigated by monitor-first + flag OFF.
- **Regressing the input-scoping fix** → mitigated by keeping a dedicated
  content-scanned block; Phase 0 validates.
- **Cost/latency**: contextual grounding is billed per source size, and
  (initially) we may duplicate the RAG context → real per-turn cost. Phase 0
  checks whether we can de-dupe.
- **Not a pure Lambda change**: needs a guardrail (CDK) deploy + new version,
  unlike the input-scoping fix.

## Self-score (avg ~8.6/10)

Architecture 9 · Production-readiness 9 (monitor-first, flagged, reversible) ·
Security 9 · Completeness 8 (Phase 0 unknowns open) · Testability 8 (grounding
scores are model-driven; assert request shape + score-parsing/logging
deterministically, not model verdicts) · Simplicity 7 (multi-phase, threads new
params, CDK+Lambda) · Cost/perf 8 · Maintainability 9.

Simplicity is the weak point — inherently more involved than the input fix
because grounding needs a real reference channel and a safe rollout. Collapsing
the phases (skipping monitor-first) is how you ship a tutor that blocks half its
own questions, so the phasing stays.

## Open decision for next session

- Proceed starting with Phase 0 validation spike against dev, OR
- Go straight to implementing Phases 1–2 behind the OFF flag and validate by
  deploying to dev.
