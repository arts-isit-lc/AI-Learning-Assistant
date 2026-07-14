# Chatbot V2: Structured Learning Flow (Technical Deep-Dive)

This document explains how the Chatbot V2 Lambda (`chatbotV2Function`, source in `cdk/chatbot_v2/`) orchestrates a structured learning conversation end-to-end. Unlike the V1 `text_generation` Lambda (open-ended Q&A), Chatbot V2 is an **application-controlled learning engine**: it evaluates each student answer, tracks per-concept progress and engagement, escalates hints, runs a deterministic step-by-step math tutor when appropriate, decides when a module is complete, and generates every reply grounded in retrieved course material.

> For a plain-language version of everything here, see [Chatbot V2 — Explained Simply](./chatbot-v2-explained.md).

---

## Core Principles

1. **App = Teacher, LLM = Reasoning Engine.** The application layer owns every pedagogical decision (evaluate, pick a mode, escalate a hint, advance a stage, declare completion). The LLM only renders natural language inside app-defined boundaries.
2. **Completion = Engagement, not mastery.** A module completes on meaningful participation (interaction count + concept coverage + engagement score), never on reaching a stage or a mastery ratio.
3. **Mastery = Analytics.** Per-concept mastery is tracked for instructor dashboards; it never gates a student from finishing.
4. **Stages drive depth, not gating.** Learning stages (`prior_knowledge → comprehension → application → mastery`) control question difficulty and scaffolding — a student can complete a module at any stage.
5. **Grounded or silent.** The response model is told it only sees a *subset* of course materials; it must never claim content is absent from the course.
6. **Fail safe, never loud.** Evaluation, retrieval, persistence, and streaming are all best-effort with safe fallbacks; a subsystem failure degrades the turn rather than dropping it.

---

## Two Delivery Channels (read this first)

A single turn is delivered over **two channels**, and understanding this is essential to reading the handler:

| Channel | Role | Notes |
|---|---|---|
| **AppSync GraphQL stream** | **Authoritative** | Token-by-token chunks during generation, then exactly **one terminal `done=true` message** carrying the final render blocks + metadata (or `error=true`). The frontend renders from this. |
| **HTTP response** (API Gateway) | Best-effort ack | On a slow multi-image turn the POST can hit API Gateway's **29s timeout**; the client then relies entirely on the stream. |

Every handler exit path calls `_stream_final(...)` (which wraps `streaming.send_final`) so the stream always receives a single, payload-bearing terminator — success or error. Incremental chunks are sent via `streaming.send_chunk` (`done=false`); the terminal message is sent once, separately, after render blocks are assembled.

Both use the same AppSync mutation:

```graphql
sendChatChunk(session_id, chunk, done, llm_output, blocks, session_name, llm_verdict, error)
```

---

## Request Flow (14-step pipeline)

```
Student sends message  ──HTTP POST──▶  chatbotV2Function.handler
        │                                    │
        │        (token chunks + terminal message)
        ◀───────────────  AppSync stream  ───┘
                                             │
┌────────────────────────────────────────────────────────────────────────────┐
│  Parse & validate (course_id, session_id, module_id)                         │
│  1. Load session state (DynamoDB)            → 503 on read failure           │
│  2. Load module_concepts + module_name (new session only, Postgres) → 503    │
│     Load chat history (DynamoDB)                                             │
│  ── if tutor active → route to MATH TUTOR sub-flow and return early ──       │
│  3. Evaluate last answer (Claude Haiku)  ┐  (run concurrently when           │
│  10. Retrieve grounding (RAG Lambda)     ┘   PARALLEL_EVAL_RETRIEVAL on)      │
│  4. update_state (counters, engagement)                                      │
│  5. Concept progress (introduce/discuss/demonstrate/misunderstand)           │
│  6. check_module_completion (engagement-based)                               │
│     + emit module_completion_probe diagnostic log                            │
│  7. check_stage_advancement (threshold-based)                                │
│  8. select_mode (decision table)                                             │
│     + hint escalation (hint_level++ on hint modes)                           │
│  9. completion bookkeeping (load sibling modules for "complete")             │
│  10. RAG grounding + figure/table/formula block selection                    │
│  10.5 Math intent classify → math_compute (verified values or tutor entry)   │
│  11. build_system_prompt (identity + rules + mode + topic + RAG + guardrail) │
│  12. stream_response (Claude Sonnet, guardrailed) → AppSync chunks           │
│  13. assemble_blocks → persist turn (DynamoDB canonical + RDS projection)    │
│      interactions += 1 → persist session state (optimistic concurrency)      │
│  14. Emit terminal stream message + latency/analytics logs → HTTP 200        │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Session State Model

Session state is the entire learning model for one session, persisted to the **`Session_State_Table`** (DynamoDB), keyed by `session_id`. Defined as the `SessionState` dataclass in `state_machine.py`.

| Field | Type | Purpose |
|---|---|---|
| `session_id` | str | Partition key |
| `stage` | `prior_knowledge`\|`comprehension`\|`application`\|`mastery` | Question difficulty / scaffolding depth |
| `module_complete` | bool | Latched true once the completion gate passes |
| `completion_message_sent` | bool | Ensures the congratulatory message fires exactly once |
| `interactions` | int | Turn counter; incremented once per turn by the handler (see note) |
| `engagement_score` | float | 0.0–1.0 participation-quality score |
| `concept_progress` | dict[str, ConceptProgress] | Per-concept `level` / `exposures` / `demonstrations` |
| `concepts_exposed` | list[str] | Concepts the bot has mentioned |
| `concepts_discussed` | list[str] | Concepts appearing in **both** bot and student messages |
| `concepts_demonstrated` | list[str] | Concepts the student showed correct understanding of |
| `module_concepts` | list[str] | Canonical topic vocabulary (from `Course_Modules.generated_topics`) |
| `correct/partial/incorrect_count` | int | Cumulative evaluation tallies |
| `consecutive_failures` / `consecutive_correct` | int | Streaks driving stage advancement + `explain` fallback |
| `hint_level` / `hint_count` | int | Socratic hint escalation state |
| `last_mode` | str | Last mode chosen (debug/analytics only) |
| `tutor_state` | dict | Math tutor step machine state (see Math Tutor) |
| `module_name` / `allowed_file_ids` | str / list | Static per-module metadata, cached when `CACHE_MODULE_METADATA` on |
| `state_version` | int | Optimistic-concurrency guard |

> **`interactions` note:** `update_state()` deliberately does **not** touch `interactions`. The handler increments it exactly once per turn near Step 13 (comment "H1"), so the gate counts every processed turn whether or not evaluation ran. `engagement_score` is serialized as a string in DynamoDB to preserve numeric precision.

**Optimistic concurrency (`_persist_session_state`):** each write increments `state_version` under a `ConditionExpression`. On a `ConditionalCheckFailedException` it reloads, re-applies the version, and retries once; a second conflict is abandoned (losing one turn's state update is safer than clobbering a newer writer — full delta-merge is intentionally deferred).

---

## Step 1–2: State + Module Concepts + History

- **Load state** from DynamoDB; a missing item means a new session → `create_default_state`. A table read failure returns **HTTP 503** (and streams a terminal error).
- **New session only:** load `module_concepts` and `module_name` from Postgres `Course_Modules` (`generated_topics`, which may be double-JSON-encoded). This canonical list is (a) the vocabulary the evaluator is filtered against and (b) the denominator for coverage / completion. A DB failure here returns **HTTP 503**.
- **`topic`** = `module_name` (falls back to `session_name`, which is often just "New Chat").
- **Load chat history** from the **`Chat_History_Table`** (DynamoDB), same `History`-list format as the V1 LangChain `DynamoDBChatMessageHistory`.

---

## Step 3: Answer Evaluation (Claude Haiku)

Runs only when `interactions > 0` **and** a message is present (the opening greeting has nothing to evaluate). Implemented in `evaluation.py`.

- Model: **`EVAL_MODEL_ID`** = `us.anthropic.claude-haiku-4-5-...` (`max_tokens=500`), a separate, cheaper Bedrock `invoke_model` call from the response model.
- Prompt (`EVALUATION_PROMPT`) passes `topic`, `stage`, the last AI question, the student answer, retrieval-derived key concepts, and the module vocabulary; it demands **strict JSON**:

```json
{ "correct": true/false, "partial": true/false, "confidence": 0.0-1.0,
  "concepts_demonstrated": ["..."], "concepts_misunderstood": ["..."] }
```

- `parse_evaluation_response` strips ```json fences, then **filters** `concepts_demonstrated` / `concepts_misunderstood` to the canonical `module_concepts` (raw pre-filter lists are retained for the diagnostic probe).
- **Safe fallback:** any LLM/parse failure returns `DEFAULT_EVALUATION` (`partial=true`, `confidence=0.5`, no concepts) — non-penalizing, so a flaky evaluator never blocks a learner.

---

## Step 4: State Machine Update (`update_state`)

Exactly one correctness counter is updated per evaluation, streaks are managed, and engagement is adjusted (capped at 1.0):

| Evaluation | Counter | Streaks | Engagement |
|---|---|---|---|
| Correct | `correct_count += 1` | `failures=0`, `correct += 1` | **+0.2** |
| Partial **with** demonstrated concepts | `partial_count += 1` | `failures=0`, `correct=0` | **+0.1** |
| Partial, no concepts | `partial_count += 1` | `failures=0`, `correct=0` | +0.0 |
| Incorrect | `incorrect_count += 1` | `failures += 1`, `correct=0` | +0.0 |

`module_complete` and `interactions` are never modified here.

---

## Step 5: Concept Progress Tracking (`concept_tracker.py`)

```
INTRODUCED ───────▶ DISCUSSED ───────▶ DEMONSTRATED ───────▶ MASTERY
(bot mentioned)     (in BOTH bot &     (student showed        (demonstrations/
                     student msgs)      correct understanding)  exposures ≥ 0.6)

concepts_exposed    concepts_discussed  concepts_demonstrated
```

- `introduce_concepts` — concept appeared in a bot message → add to `concepts_exposed`, `exposures++`.
- `discuss_concepts` — concept appeared in **both** bot and student messages → add to `concepts_discussed`, advance level to ≥ `discussed`. Called for evaluation-demonstrated concepts **and** for module concepts literally present in the student's message.
- `demonstrate_concepts` — from evaluation → add to `concepts_demonstrated`, `demonstrations++`, level to ≥ `demonstrated`; promote to `mastery` when `demonstrations/exposures ≥ MASTERY_DEMONSTRATION_RATIO (0.6)`.
- `record_misunderstandings` — `exposures++` only; **no penalty** to engagement or completion.
- Levels advance monotonically via `advance_concept_level` (never regress).
- Concepts named in the RAG answer are also marked *introduced* (the bot "mentioned" them).

---

## Step 6: Module Completion Check (`check_module_completion`)

Completion is **purely engagement-based** — all three must hold:

| Requirement | Threshold | Source constant |
|---|---|---|
| `interactions` | `>= 5` | `MIN_INTERACTIONS_FOR_COMPLETION` |
| `len(concepts_discussed)` | `>= required_concepts_discussed(len(module_concepts))` | `CONCEPTS_DISCUSSED_COMPLETION_RATIO = 0.5` |
| `engagement_score` | `>= 0.5` | `MIN_ENGAGEMENT_SCORE_FOR_COMPLETION` |

`required_concepts_discussed(total) = max(1, ceil(total * 0.5))` — at least half the module's topics (rounded up), floored at 1. Consequences:

- A 1- or 2-topic module needs **1** discussed; 3–4 topics need **2**; etc.
- A **0-topic module can never complete** (the floor of 1 can't be reached with no concepts).

The gate explicitly ignores `stage`, `correct_count`, `consecutive_failures`, and mastery. Once true, `module_complete` latches.

**Diagnostic probe (non-behavioral).** Every turn the handler emits a `module_completion_probe` structured log with all gate inputs plus the evaluator's **raw vs. canonical-filtered** demonstrated concepts, and `completion_missing_requirements(state)` — a subset of `["interactions", "concept_coverage", "engagement"]` (`[]` == complete). This mirrors the real gate exactly and measures how much the exact-string concept filter discards. A future spec (§4.3) moves the gate from `concepts_discussed` to `concepts_demonstrated`; the probe and gate are updated in lockstep.

---

## Step 7: Stage Advancement (`check_stage_advancement`)

Stages control **difficulty**, not completion. At most one advancement per turn:

```
prior_knowledge ──▶ comprehension ──▶ application ──▶ mastery
 correct ≥ 2         correct ≥ 5 AND    correct ≥ 8
                     consecutive ≥ 3
```

On advancement: `consecutive_failures = 0` **and `hint_level = 0`** (a fresh stage restarts hint escalation).

---

## Step 8: Mode Selection + Socratic Hint System

### Mode decision table (`mode_selector.select_mode`, priority order)

```
 1. completion_message_sent            → post_completion   (highest priority)
 2. module_complete AND !sent          → complete
 3. interactions == 0                  → greet
 4. correct AND advanced               → advance
 5. correct AND NOT advanced           → assess
 6. partial AND hint_level == 0        → hint_nudge
 7. partial AND hint_level >= 1        → hint_scaffold
 8. incorrect AND consecutive_failures >= 3 → explain
 9. incorrect AND hint_level < 2       → hint_scaffold
10. fallback                           → explain
```

Each mode maps to a constrained instruction template (`constants/modes.py`):

| Mode | Instruction to the LLM |
|---|---|
| `greet` | Warm greeting **and** an opening question about `{topic}` in one paragraph |
| `assess` | Ask ONE question at the `{difficulty}` level about `{concept}`; don't explain yet |
| `hint_nudge` | Gentle nudge toward `{missing_concept}` **without** revealing the answer |
| `hint_scaffold` | Break `{concept}` into sub-steps; ask about the first sub-step |
| `explain` | Briefly explain `{concept}` from context, then ask a follow-up |
| `advance` | Acknowledge `{mastered_concept}`, bridge to `{next_concept}` |
| `complete` | Congratulate, summarize `{concepts_discussed}`, suggest `{other_modules}` |
| `post_completion` | Open exploratory chat about `{topic}`; do **not** re-congratulate |

### Hint escalation (the key mechanic)

Hint **text** is prompt-driven (the LLM writes it from the template), but the **escalation** is app-controlled. Immediately after mode selection:

```python
if mode in ("hint_nudge", "hint_scaffold"):
    state.hint_level += 1
    state.hint_count += 1
```

This is what turns a first partial answer (`hint_level 0 → hint_nudge`) into progressively firmer scaffolding on repeats (`hint_level ≥ 1 → hint_scaffold`), and, after `consecutive_failures ≥ 3`, into a direct `explain`. Without this increment `hint_scaffold` would be unreachable (fix "M7"). Stage advancement resets `hint_level` to 0, so each new stage starts gentle again.

```
partial (level 0) ─▶ hint_nudge ─▶ level 1 ─▶ partial ─▶ hint_scaffold ─▶ level 2 ...
incorrect ×3 (consecutive_failures ≥ 3) ─▶ explain (stop hinting, just teach)
```

---

## Math Tutor Sub-Flow (deterministic, step-by-step)

When a turn involves a solvable, *verified* math problem and the student wants to work through it, the chatbot switches into a **deterministic tutor** (`tutor_integration.py`) driven by `state.tutor_state`. This path runs **before** the normal pipeline: if `is_tutor_active(state)` and a message is present, the handler routes the turn through the tutor and returns early (state persistence, block assembly, dual-channel delivery all still apply).

### Entering tutoring

At Step 10.5, `math_classifier.classify_math_intent` inspects the message; if it `needs_compute_lambda()` (compute intent + explicit math, not a discourse reference), `math_compute_client.invoke_math_compute` calls the **math_compute** Lambda. Then `should_enter_tutoring(...)` returns true only when:

- the compute `status == "verified"` (partials stay on the direct-injection path), **and**
- the result carries `_steps`, **and**
- the student wanted a walkthrough (`explain` flag, or explicit-math compute intent).

`create_tutor_state` seeds `{active, current_step_index:0, stuck_count:0, step_list, final_answer, operation, completed:false}`.

### Tutor turn routing (`process_tutor_turn`)

```
student message
   │
   ├─ direct request ("just tell me", "give me the answer", "skip", "i give up")
   │      → reveal full verified solution, mark completed
   ├─ hint request ("hint", "help me", "i'm stuck", "i don't know")
   │      → return the CURRENT step's stored hint (never the answer)
   └─ otherwise → validate attempt against current step (_lightweight_validate)
          ├─ correct → confirm, advance to next step, reset stuck_count
          │              (last step → completion prompt)
          └─ incorrect → stuck_count += 1
                 ├─ stuck_count >= MAX_STUCK (2) → reveal this step, advance
                 └─ else → give the step's hint, ask to retry
```

- `_lightweight_validate` does string/number matching (normalized equality, ~70% of expected numbers present, or containment) — full SymPy equivalence lives in the math_compute Lambda, not here.
- Every branch returns a **constrained prompt** (e.g. `"MATH TUTORING — INCORRECT ATTEMPT … Hint to give: {hint} … Do NOT reveal the expected answer"`) that the response model renders into natural language via `build_tutor_system_prompt` (which re-prepends the global no-emoji rule since it bypasses `MODE_TEMPLATES`).

So there are **two distinct hint systems**: the Socratic `hint_level` escalation for conceptual learning, and the tutor's `stuck_count` escalation (hint → hint → reveal) for procedural math.

### The math_compute Lambda (`math_compute/src/handler.py`)

A deterministic SymPy pipeline: `parse → ambiguity_gate → validate → compute → verify → generate_steps`. It returns `{status: verified|partial|failed, answer, verification, steps[], failure_reason, clarification_needed, trace}`; `status == "verified"` only when verification passes. A separate `compare_expressions` entry does Tier-2 symbolic-equivalence checks. Results are formatted for the prompt by `MathComputeResult.get_prompt_injection()` — verified values carry a "reproduce EXACTLY, do not round/recalculate" instruction; partials are flagged for double-checking; failures instruct the model to explain the method only. Discourse references ("the matrix above") are explicitly rejected with a request to restate the input.

---

## Step 10: RAG Retrieval + Grounding

Retrieval grounds every reply in course material via a synchronous Lambda-to-Lambda call (`retrieval_client.invoke_retrieval` → `ragRetrievalFunction`, the multimodal RAG v2 pipeline).

**Scope (`_get_allowed_file_ids`).** The retrievable file set is the UNION of the module's own files (`Module_Files`) and its cross-module references (`Module_File_References`), gated by `ENABLE_CROSS_MODULE_REFERENCING` (default on; a runtime kill-switch). On any DB error it falls back to `module_id` scoping — it never broadens scope on failure.

**Request payload:**

```python
{ "query": retrieval_query, "session_id", "course_id",
  "allowed_file_ids": [...], "chat_history": last_4_turns,
  "learning_context": { "stage", "concepts_demonstrated", "concepts_misunderstood" },
  "module_id" }
```

**Result (`RetrievalResult`):** `answer`, `sources`, `escalation_used`, plus `image_analyses`, `image_results`, `table_results`, `formula_results`. `invoke_retrieval` returns `None` on any failure (never raises); the RAG side returns HTTP 503 if pgvector/embedding is unavailable. `rag_context = result.answer`.

**Block selection & grounding (`figure_selection.py`).** Deterministic, rule-based, no LLM/embedding calls — runs on the retrieval outputs. It selects up to `_MAX_FIGURES/TABLES/FORMULAS` figures/tables/formulas and builds **grounding text** appended to `rag_context` so the response model's prose matches the visual blocks the UI will show (fix "H6/M1" — prevents the model disclaiming a figure the display simultaneously renders).

> **Greeting exception:** an auto-greeting (`greet` mode with no student message) skips visual blocks and their grounding (it runs retrieval on a synthesized topic-overview query and would otherwise dump PDF pages under the opening line), but keeps `rag_context` so the opening question stays grounded.

See [Multimodal RAG Pipeline](./multimodal-rag-pipeline.md) for what happens inside `ragRetrievalFunction`.

---

## Step 11: System Prompt Assembly (`prompt_builder.py`)

`build_system_prompt` concatenates six sections (missing template vars are left as literal `{placeholders}` via a defaulting dict, never a `KeyError`):

```
1. BASE_INSTRUCTOR_IDENTITY   ("You are an instructor…" + strict GROUNDING RULE)
2. NO_EMOJI_RULE              (shared global formatting constant)
3. Mode instruction          (MODE_TEMPLATES[mode], variable-substituted)
4. Topic: {topic}
5. rag_context               (retrieval answer + figure/table/formula grounding)
6. guardrail_tags            (Bedrock Guardrail input tags; empty on ConverseStream)
```

`context_vars` (built in the handler) supply `difficulty` (=stage), `concept` (last exposed), `missing_concept`, `mastered_concept`, `next_concept`, `concepts_discussed`, `other_modules`. Math-compute output (verified values or the initial tutor prompt) is appended **after** assembly. The tutor path uses `build_tutor_system_prompt` instead of the mode templates.

---

## Step 12: Response Streaming + Guardrails

Streaming (`streaming.py`) uses **Claude Sonnet 4.5** (`RESPONSE_MODEL_ID`, `max_tokens=4000`). Two API paths, normalized to one event vocabulary (`delta` / `usage` / `stop` / `block_type`), selected by the `USE_CONVERSE_STREAMING` flag:

| Path | API | Guardrail mode | TTFT |
|---|---|---|---|
| Default (flag off) | `invoke_model_with_response_stream` | **Synchronous** (guardrail id/version as top-level params → `X-Amzn` headers; can't sit in the JSON body or Claude rejects it) | buffers before first token |
| Flag on | `converse_stream` | **Asynchronous** (`guardrailConfig`, `streamProcessingMode: async`) | first token immediately; block signaled by `messageStop.stopReason='guardrail_intervened'` + trailing metadata — not an exception. Cuts ~6.8s guardrail TTFT overhead |

Both buffer output to `CHUNK_SIZE = 80` chars, POST `sendChatChunk` chunks to AppSync, and log `ttft_ms` / `stream_total_ms`. On a non-guardrail failure they return `FALLBACK_MESSAGE`.

**Guardrails (`guardrails.py`).** Config (id/version) is read from SSM (`""` = proceed without). Input is wrapped in `<amazon-bedrock-guardrails-guardContent_{rand}>` tags on the InvokeModel path (skipped on ConverseStream, where `guardrailConfig` assesses the whole turn). `_stream_with_guardrail_retry` classifies failures:

- **Intervention (input/output blocked)** → return a safe redirect message (`GUARDRAIL_REDIRECT_INPUT/OUTPUT`). This is a *shown message*, not an error.
- **Service error** → if `GUARDRAIL_FAIL_CLOSED` on, return a safe message (never regenerate ungated); else retry once **without** guardrails; if that fails, HTTP 500.

A guardrail-blocked turn is written to the **RDS projection** (so the UI history shows the exchange) but **not** to the DynamoDB canonical log — blocked content must never be replayed to the model as history (fix "M16").

---

## Step 13: Persistence (`_persist_turn`)

One shared path for both normal and tutor turns, canonical-first:

1. **DynamoDB `Chat_History_Table` — canonical text log** (`history.persist_message_pair`), written **first** so a delayed/failed projection never loses a message. `get_bounded_history` feeds the last `MAX_PROMPT_TURNS = 10` pairs to the prompt (retrieval uses the last 4).
2. **Postgres/RDS projection (UI history, carries render blocks)** — `rds_projection.persist_message_to_rds` inserts into `Messages` (`message_blocks` JSONB), bumps `Sessions.last_accessed`, and `log_engagement` writes `User_Engagement_Log` (joined to `Users`/`Enrolments` by email). Written **async via SQS** when `ASYNC_RDS_PROJECTION` on (consumed by `rds_projection_consumer.py`), else synchronously.

Turn timestamps (`_utc_now_iso`, UTC) are threaded through both modes so RDS `time_sent` ordering reflects **turn time**, not (possibly delayed) write time. Then `interactions += 1` and `_persist_session_state` writes state under optimistic concurrency.

Render blocks (`figure_selection.assemble_blocks`) combine the LLM prose with the pre-selected figures/tables/formulas into a `blocks` list (`type: text|figure|table|formula`) saved with the AI message and streamed in the terminal message.

---

## Step 14: Terminal Delivery + Telemetry

The handler emits the single terminal stream message (`_stream_final` → `send_final`, `done=true`) carrying `llm_output`, `blocks`, `session_name`, and `llm_verdict` (= `module_complete`), then returns the HTTP 200 ack with the same payload plus a `session_state` view:

```json
{
  "session_name": "Sorting Algorithms",
  "llm_output": "Great — that's exactly right...",
  "blocks": [ { "type": "text", "content": "..." } ],
  "llm_verdict": false,
  "session_state": {
    "stage": "comprehension",
    "module_complete": false,
    "engagement_score": 0.4,
    "concepts_demonstrated": ["bubble_sort"],
    "tutor_active": false
  }
}
```

`_session_state_view` guarantees the same keys on every exit path (normal, guardrail-block, tutor, tutor-block) so the frontend has a stable schema. Diagnostics: a per-turn `latency_breakdown` log (`state_load_ms`, `history_load_ms`, `eval_ms`, `retrieval_ms`, `time_to_generation_ms`, `generation_ms`, `persist_ms`, `total_ms`) plus the streaming `ttft_ms`, and an analytics log (coverage, mastery count).

---

## Session Lifecycle Example

```
Turn 1 (greet):      Student opens session.
                     → greet: "Welcome! Let's explore sorting algorithms. What do you
                       already know about how computers put data in order?"

Turn 2 (assess):     "Bubble sort compares adjacent elements."
                     eval: correct, demonstrated=[bubble_sort]
                     correct_count=1, engagement=0.2, stage=prior_knowledge
                     → assess: "Right! What happens to the largest element after one
                       full pass?"

Turn 3 (hint_nudge): "It moves to the middle?"
                     eval: partial. hint_level 0→1
                     → hint_nudge: gentle nudge toward the missing idea, no answer.

Turn 4 (advance):    "Oh — it bubbles to the end!"
                     eval: correct, demonstrated=[bubble_sort, pass_mechanics]
                     correct_count=2 → stage→comprehension, hint_level reset to 0
                     → advance: bridge to efficiency / time complexity.

...
Turn 7 (complete):   interactions=7, concepts_discussed=4, engagement=0.6
                     → module_complete=true → complete: congratulate + summarize +
                       suggest next modules. completion_message_sent=true.

Turn 8+ (post_completion): open exploratory Q&A, no re-congratulation.
```

---

## Error Handling

| Failure point | Behavior |
|---|---|
| `Session_State_Table` read failure | HTTP **503** + terminal stream error |
| DB failure loading module concepts (new session) | HTTP **503** + terminal stream error |
| Evaluation LLM failure | `DEFAULT_EVALUATION` (partial, no concepts); pipeline continues |
| RAG retrieval failure | `None` → generate from history + mode prompt (no grounding) |
| math_compute failure | Method-only explanation injected; no verified values claimed |
| Block selection/grounding failure | Text-only blocks; turn continues |
| Guardrail intervention (input/output) | Safe redirect message; RDS-only persist; HTTP 200 |
| Guardrail service error | `GUARDRAIL_FAIL_CLOSED`? safe message : retry once ungated → else HTTP 500 |
| AppSync stream failure | Logged, best-effort; HTTP body still carries payload |
| Session state write conflict | Reload + retry once; then abandon (best-effort) |
| Unhandled exception | Full stack trace logged, terminal stream error, HTTP 500 |

---

## Feature Flags (`flags.py`) — all default OFF (no-op deploy)

| Flag | Effect |
|---|---|
| `GUARDRAIL_FAIL_CLOSED` | On a guardrail **service** error, return a safe message instead of regenerating ungated |
| `CACHE_MODULE_METADATA` | Cache `module_name` + `allowed_file_ids` in state (skip per-turn Postgres reads) |
| `PARALLEL_EVAL_RETRIEVAL` | Run evaluation + retrieval concurrently (`ThreadPoolExecutor`); retrieval uses pre-eval learning state |
| `ASYNC_RDS_PROJECTION` | Offload the RDS projection + engagement logging to SQS (DynamoDB stays synchronous source of truth) |
| `USE_CONVERSE_STREAMING` | Use `converse_stream` + async guardrail (low TTFT) instead of InvokeModel + sync guardrail |
| `STREAM_GUARDRAIL_DISABLED` | **DEV-ONLY** TTFT diagnostic — drops the guardrail from the streamed call (unfiltered output; never in prod) |

---

## Models & Key Constants

| Role | Model / value |
|---|---|
| Response generation | `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, `max_tokens=4000` |
| Answer evaluation | `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `max_tokens=500` |
| RAG reasoning (in `ragRetrievalFunction`) | `us.anthropic.claude-haiku-4-5-...`, `max_tokens=4096` |
| Completion | interactions ≥ 5 · concepts_discussed ≥ ceil(0.5·topics), floor 1 · engagement ≥ 0.5 |
| Stage advance | correct ≥ 2 → ≥ 5 & consec ≥ 3 → ≥ 8 |
| Engagement increments | correct +0.2 · partial-with-concepts +0.1 · cap 1.0 |
| Mastery | demonstrations/exposures ≥ 0.6 |
| Tutor stuck reveal | `MAX_STUCK = 2` |
| Prompt/retrieval history | `MAX_PROMPT_TURNS = 10` · retrieval last 4 |
| Stream chunk size | 80 chars |

> All Bedrock calls use **Geo-US cross-Region inference profiles** (the `us.` prefix): `ca-central-1` has no in-Region access to the 4.5 family, and the account is set to zero data retention. No Llama / LangChain runs in `chatbot_v2` — LangChain lives in the older `text_generation` Lambda.

---

## Module Source Files

```
cdk/chatbot_v2/src/
├── main.py               # Lambda handler — the 14-step orchestrator + dual-channel delivery
├── state_machine.py      # SessionState, update_state, completion gate, stage advancement, (de)serialize
├── concept_tracker.py    # introduce / discuss / demonstrate / record_misunderstandings + mastery
├── evaluation.py         # EvaluationResult, evaluate_answer (Haiku), parse_evaluation_response
├── mode_selector.py      # select_mode decision table (Socratic hint routing)
├── prompt_builder.py     # build_system_prompt (6-section) + build_tutor_system_prompt
├── retrieval_client.py   # invoke_retrieval (Lambda→Lambda) + RetrievalResult
├── figure_selection.py   # deterministic figure/table/formula selection, grounding, assemble_blocks
├── streaming.py          # InvokeModel/ConverseStream paths, AppSync send_chunk/send_final
├── guardrails.py         # SSM config, input tagging, intervention vs service-error classification
├── history.py            # DynamoDB canonical chat log load/persist + history bounding
├── rds_projection.py     # Postgres UI-history projection + engagement logging
├── math_classifier.py    # rule-based math intent classification (compute/explain/verify)
├── math_compute_client.py# invoke math_compute + get_prompt_injection formatting
├── tutor_integration.py  # deterministic math tutor state machine (stuck_count hint escalation)
├── flags.py              # feature flags (all default OFF)
└── constants/
    ├── models.py         # model IDs + completion/engagement/mastery thresholds
    └── modes.py          # MODE_TEMPLATES (8 mode instruction strings)
```

---

## Related Documentation

- [Chatbot V2 — Explained Simply](./chatbot-v2-explained.md) — the non-technical companion to this doc
- [Architecture Overview](./architecture-overview.md) — system-wide architecture (all 7 CDK stacks)
- [Multimodal RAG Pipeline](./multimodal-rag-pipeline.md) — what happens inside `ragRetrievalFunction`
- [Data Flow](./data-flow.md) — end-to-end from file upload to student answer
