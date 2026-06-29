# Chatbot V2: Structured Learning Flow

This document explains how the Chatbot V2 Lambda (`chatbotV2Function`) orchestrates a structured learning conversation. Unlike the V1 text_generation Lambda which provides open-ended Q&A, Chatbot V2 implements an application-controlled learning engine that tracks engagement, evaluates understanding per-concept, and adapts conversation difficulty through learning stages.

---

## Core Principles

1. **Completion = Engagement** — Module completion is determined by meaningful participation (interaction count + concept coverage + engagement score), never by reaching a specific stage or mastery level.
2. **Mastery = Analytics** — Per-concept mastery is tracked for instructor dashboards but never gates the student from completing.
3. **Stages Drive Depth, Not Gating** — Learning stages (prior_knowledge → comprehension → application → mastery) control question difficulty and scaffolding, not whether the student can finish.
4. **App = Teacher, LLM = Reasoning Engine** — The application layer controls all pedagogical decisions (mode, progression, completion). The LLM generates constrained natural language within app-defined boundaries.

---

## Request Flow

```
Student sends message
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    chatbotV2Function Handler                                │
│                                                                            │
│   1. Parse & validate request (course_id, session_id, module_id)          │
│   2. Load session state from DynamoDB (or create default)                 │
│   3. Load module_concepts from Course_Modules.generated_topics (new only) │
│   4. Evaluate student's answer (Claude 3 Haiku — skip on first message)  │
│   5. Update state machine (counters, engagement_score)                    │
│   6. Update concept progress (introduce, discuss, demonstrate)            │
│   7. Check module completion (engagement-based)                           │
│   8. Check stage advancement (threshold-based)                            │
│   9. Select response mode (decision table)                                │
│  10. Invoke ragRetrievalFunction (Lambda-to-Lambda, sync)                 │
│  11. Build system prompt (mode template + RAG context + guardrails)       │
│  12. Stream response (Claude 3 Sonnet → AppSync → frontend)              │
│  13. Persist chat history + session state (DynamoDB)                      │
│  14. Return HTTP response with session_state summary                      │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Breakdown

### Step 1: Request Parsing

The Lambda receives an API Gateway event with:
- **Query parameters:** `course_id`, `session_id`, `module_id`, `session_name`
- **Body:** `{ "message_content": "student's answer" }`

Missing required params return HTTP 400 with the specific parameter name.

### Step 2: Session State Load

Session state is stored in the `Session_State_Table` (DynamoDB), keyed by `session_id`.

If the session is new (no existing state), a default state is created:

```
SessionState {
    session_id: "...",
    stage: "prior_knowledge",
    module_complete: false,
    completion_message_sent: false,
    interactions: 0,
    engagement_score: 0.0,
    concept_progress: {},
    concepts_exposed: [],
    concepts_discussed: [],
    concepts_demonstrated: [],
    module_concepts: [],       ← populated in Step 3
    correct_count: 0,
    partial_count: 0,
    incorrect_count: 0,
    consecutive_failures: 0,
    consecutive_correct: 0,
    hint_level: 0,
    hint_count: 0,
    state_version: 0           ← optimistic concurrency
}
```

### Step 3: Module Concepts Load (New Sessions Only)

On the first interaction, the system queries `Course_Modules.generated_topics` for the module and stores the result as `module_concepts` in the session state. This canonical list serves as:
- The vocabulary for the Evaluation Engine (LLM only reports concepts from this list)
- The denominator for coverage calculation (`concepts_discussed / module_concepts`)

### Step 4: Answer Evaluation

Skipped on the first message (no prior question to evaluate against).

For subsequent messages, invokes **Claude 3 Haiku** with a structured evaluation prompt:

```
Input:  topic, stage, last_ai_question, student_answer, module_concepts
Output: { correct, partial, confidence, concepts_demonstrated, concepts_misunderstood }
```

Key behaviors:
- Only reports concepts from the canonical `module_concepts` list
- On any failure (timeout, parse error), returns a safe default: `{ correct: false, partial: true, confidence: 0.5, concepts_demonstrated: [], concepts_misunderstood: [] }`
- Uses a separate Bedrock InvokeModel call from the response generator

### Step 5: State Machine Update

Based on the evaluation result, the state machine updates:

| Evaluation | Counter Updated | Consecutive | Engagement Score |
|-----------|-----------------|-------------|-----------------|
| Correct | `correct_count += 1` | `failures = 0`, `correct += 1` | `+0.2` (capped at 1.0) |
| Partial (with concepts demonstrated) | `partial_count += 1` | `failures = 0`, `correct = 0` | `+0.1` (capped at 1.0) |
| Partial (no concepts) | `partial_count += 1` | `failures = 0`, `correct = 0` | `+0.0` |
| Incorrect | `incorrect_count += 1` | `failures += 1`, `correct = 0` | `+0.0` |

The `interactions` counter always increments by 1. The `module_complete` flag is never modified here.

### Step 6: Concept Progress Tracking

Three levels of concept engagement are tracked:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      CONCEPT LIFECYCLE                                   │
│                                                                          │
│   INTRODUCED ──────▶ DISCUSSED ──────▶ DEMONSTRATED ──────▶ MASTERY    │
│   (bot mentioned)    (student engaged)  (correct answer)    (ratio met) │
│                                                                          │
│   concepts_exposed   concepts_discussed  concepts_demonstrated           │
│   (any assistant     (appeared in BOTH   (evaluation reported            │
│    message)           assistant AND        correct understanding)         │
│                       student messages)                                   │
└────────────────────────────────────────────────────────────────────────┘
```

Each concept has a `ConceptProgress` record:
- `level`: introduced → discussed → demonstrated → mastery (never regresses)
- `exposures`: total times the concept was encountered
- `demonstrations`: successful demonstrations by the student

Mastery threshold: `demonstrations / exposures >= 0.6`

### Step 7: Module Completion Check

Completion is purely engagement-based. All three conditions must be met:

| Metric | Threshold | Purpose |
|--------|-----------|---------|
| `interactions` | >= 5 | Minimum conversation depth |
| `len(concepts_discussed)` | >= 3 | Breadth of engagement |
| `engagement_score` | >= 0.5 | Quality of participation |

This check explicitly does NOT reference: learning stage, correct_count, consecutive_failures, or mastery analytics.

### Step 8: Stage Advancement

Stages control conversation difficulty, not completion:

```
prior_knowledge ──▶ comprehension ──▶ application ──▶ mastery
   (correct >= 2)    (correct >= 5     (correct >= 8)
                      AND consec >= 3)
```

Rules:
- At most one stage advancement per interaction
- On advancement: `consecutive_failures = 0`, `hint_level = 0`
- A student can complete the module at any stage (even `prior_knowledge`)

### Step 9: Mode Selection

The mode selector is a pure decision table evaluated in priority order:

```
┌───────────────────────────────────────────────────────────────────────┐
│                     MODE DECISION TABLE                                 │
│                                                                         │
│  Priority 1: completion_message_sent == True     → "post_completion"   │
│  Priority 2: module_complete AND !sent           → "complete"          │
│  Priority 3: interactions == 0                   → "greet"             │
│  Priority 4: correct AND advanced                → "advance"           │
│  Priority 5: correct AND NOT advanced            → "assess"            │
│  Priority 6: partial AND hint_level == 0         → "hint_nudge"        │
│  Priority 7: partial AND hint_level >= 1         → "hint_scaffold"     │
│  Priority 8: incorrect AND failures >= 3         → "explain"           │
│  Priority 9: incorrect AND hint_level < 2        → "hint_scaffold"     │
│  Priority 10: fallback                           → "explain"           │
│                                                                         │
└───────────────────────────────────────────────────────────────────────┘
```

Each mode maps to a specific teaching behavior:

| Mode | What the AI Does |
|------|-----------------|
| `greet` | Warmly introduces the topic, asks an opening question to gauge prior knowledge |
| `assess` | Asks ONE question at the current difficulty level |
| `hint_nudge` | Gives a gentle nudge toward the missing concept without revealing the answer |
| `hint_scaffold` | Breaks the concept into smaller steps, asks about the first sub-step |
| `explain` | Briefly explains using retrieved context, then asks a follow-up |
| `advance` | Acknowledges mastery of current concept, bridges to the next one |
| `complete` | Congratulates the student, summarizes concepts engaged with, suggests other modules |
| `post_completion` | Allows continued exploration without re-congratulating |

### Step 10: RAG Retrieval

Invokes `ragRetrievalFunction` synchronously (Lambda-to-Lambda):

```python
Payload: {
    "query": message_content,
    "session_id": "...",
    "course_id": "...",
    "allowed_file_ids": [],
    "chat_history": last_4_turns,
    "learning_context": {
        "stage": "comprehension",
        "concepts_demonstrated": ["concept_a", "concept_b"],
        "concepts_misunderstood": ["concept_c"]
    }
}
```

The `learning_context` field provides pedagogical state so the retrieval function can prioritize content relevant to the student's current position.

On failure: logs the error and proceeds without RAG context (the LLM generates from conversation history and mode prompt alone).

### Step 11: Prompt Construction

The system prompt is assembled from five sections:

```
┌──────────────────────────────────────────────────┐
│  1. Base Instructor Identity                      │
│     "You are an instructor for a course..."      │
│                                                   │
│  2. Mode-Specific Instruction                    │
│     (from MODE_TEMPLATES, with variable          │
│      substitution for topic, concept, etc.)      │
│                                                   │
│  3. Topic Context                                │
│     "Topic: Machine Learning Fundamentals"       │
│                                                   │
│  4. Retrieved RAG Context                        │
│     (answer from ragRetrievalFunction)           │
│                                                   │
│  5. Guardrail Boundary Tags                      │
│     (Bedrock Guardrail content wrapping)         │
└──────────────────────────────────────────────────┘
```

The LLM never decides its own teaching strategy — the mode template constrains its behavior.

### Step 12: Response Streaming

Uses Bedrock `InvokeModelWithResponseStream` with Claude 3 Sonnet:

```
Claude Sonnet ──▶ Buffer (80 chars) ──▶ AppSync mutation ──▶ WebSocket ──▶ Student's browser
                        │
                        └── On complete: send done=true, assemble full response
```

- Chunks are buffered to 80 characters before sending (reduces WebSocket overhead)
- AppSync failures are logged but don't interrupt generation
- On complete LLM failure: returns a fallback message
- Guardrail intervention: returns a safe redirect message

### Step 13: Persistence

Two writes happen after response generation:
1. **Chat history** — user message + assistant response stored in `Chat_History_Table` (best-effort)
2. **Session state** — updated state written to `Session_State_Table` with optimistic concurrency (conditional write on `state_version`)

On state write conflict: reloads state, re-applies updates, retries once. If retry fails: logs and returns response anyway (best-effort).

### Step 14: HTTP Response

```json
{
    "statusCode": 200,
    "body": {
        "session_name": "Machine Learning Basics",
        "llm_output": "Great answer! You correctly identified...",
        "llm_verdict": false,
        "session_state": {
            "stage": "comprehension",
            "module_complete": false,
            "engagement_score": 0.4,
            "concepts_demonstrated": ["supervised_learning", "training_data"]
        }
    }
}
```

The `llm_verdict` field is `true` when `module_complete` becomes true, signaling the frontend to update the module progress UI.

---

## Session Lifecycle Example

```
Interaction 1 (greet):
    Student: [opens session]
    Mode: "greet"
    AI: "Welcome! Let's explore sorting algorithms. What do you already know
         about how computers organize data?"

Interaction 2 (assess):
    Student: "I know bubble sort compares adjacent elements"
    Evaluation: { correct: true, concepts_demonstrated: ["bubble_sort"] }
    State: correct_count=1, engagement_score=0.2, stage=prior_knowledge
    Mode: "assess"
    AI: "That's right! Can you explain what happens to the largest element
         after the first complete pass through the array?"

Interaction 3 (hint_nudge):
    Student: "It moves somewhere in the middle?"
    Evaluation: { correct: false, partial: true, concepts_demonstrated: [] }
    State: correct_count=1, engagement_score=0.2, hint_level=0→1
    Mode: "hint_nudge"
    AI: "You're on the right track thinking about movement. Consider: if we
         always swap when the left element is larger than the right, where
         does the largest element end up after checking every pair?"

Interaction 4 (advance):
    Student: "Oh! It bubbles up to the end of the array"
    Evaluation: { correct: true, concepts_demonstrated: ["bubble_sort", "pass_mechanics"] }
    State: correct_count=2, engagement_score=0.4, stage→comprehension
    Mode: "advance"
    AI: "Exactly! Now that you understand the bubbling mechanism, let's
         think about efficiency..."

...

Interaction 7 (complete):
    State: interactions=7, concepts_discussed=4, engagement_score=0.6
    → module_complete = true
    Mode: "complete"
    AI: "Excellent work! You've engaged meaningfully with sorting algorithms,
         covering bubble sort, selection sort, time complexity, and comparisons.
         You might enjoy exploring 'Graph Algorithms' or 'Dynamic Programming' next."
    → completion_message_sent = true

Interaction 8+ (post_completion):
    Mode: "post_completion"
    AI: [answers follow-up questions naturally without re-congratulating]
```

---

## Error Handling

| Failure Point | Behavior |
|---------------|----------|
| Session_State_Table read failure | HTTP 503 — service unavailable |
| DB connection failure (module concepts) | HTTP 503 — service unavailable |
| Evaluation LLM failure | Returns safe default, continues pipeline |
| RAG retrieval failure | Proceeds without context, generates from history |
| Session_State_Table write failure | Returns response anyway (best-effort) |
| AppSync streaming failure | Continues generation, full response in HTTP body |
| Guardrail intervention (input/output) | Returns safe redirect message |
| Guardrail service error | Retries without guardrails; if retry fails → HTTP 500 |
| Unhandled exception | Logs full stack trace, returns HTTP 500 generic message |

---

## Differences from V1 Text Generation

| Aspect | V1 (text_generation) | V2 (chatbotV2Function) |
|--------|---------------------|------------------------|
| Learning model | Open-ended Q&A | Structured stages + modes |
| Evaluation | None | Per-answer concept-level evaluation |
| State tracking | None (stateless) | Full session state in DynamoDB |
| Completion | Manual (instructor marks) | Automatic (engagement-based) |
| Retrieval | Direct pgvector search (LangChain) | Invokes ragRetrievalFunction (multimodal) |
| Concept tracking | None | Exposed → Discussed → Demonstrated → Mastery |
| Mode selection | None (always same prompt) | 8-mode decision table |
| Prompt construction | Static system prompt + instructor prompt | Dynamic mode template + RAG + guardrails |
| LLM models | Configurable (Sonnet/Llama) | Fixed: Sonnet (response) + Haiku (evaluation) |

---

## Module Source Files

```
cdk/chatbot_v2/src/
├── main.py              # Lambda handler — orchestration pipeline
├── state_machine.py     # SessionState, update_state, check_completion, check_advancement
├── concept_tracker.py   # introduce, discuss, demonstrate, record_misunderstandings
├── evaluation.py        # EvaluationResult, evaluate_answer, parse_evaluation_response
├── mode_selector.py     # select_mode decision table
├── prompt_builder.py    # build_system_prompt (5-section assembly)
├── retrieval_client.py  # invoke_retrieval (Lambda-to-Lambda)
├── streaming.py         # stream_response, buffer_chunks, send_chunk
├── guardrails.py        # load_config, wrap_user_message, handle_error
├── history.py           # load_chat_history, persist_message_pair, bounding
└── constants/
    ├── models.py        # Thresholds, model IDs, increments
    └── modes.py         # MODE_TEMPLATES dict
```

---

## Performance & Cost Notes

Two chatbot optimizations are available as flags (default off, env-var toggled):
`CACHE_MODULE_METADATA` (cache `module_name` + `allowed_file_ids` in session
state instead of re-querying Postgres each turn) and `GUARDRAIL_FAIL_CLOSED`
(on a guardrail service error, return a safe fallback rather than regenerating
without guardrails). The largest win, eliminating the double generation, lives
on the retrieval side (`RAG_RETURN_PASSAGES`): the chatbot's Sonnet pass then
generates once from retrieved passages. See
[Performance & Cost Optimizations](./architecture-overview.md#performance--cost-optimizations).

---

## Related Documentation

- [Architecture Overview](./architecture-overview.md) — system-wide architecture
- [Multimodal RAG Pipeline](./multimodal-rag-pipeline.md) — how retrieval works under the hood
- [Data Flow](./data-flow.md) — end-to-end from file upload to student answer
