# Chatbot Flow Improvement Plan

## Current Flow Summary

The current chatbot operates as a simple RAG loop:

1. **Session start** → Lambda sends a greeting + first question about the topic
2. **Student responds** → Message goes to `text_generation` Lambda
3. **RAG retrieval** → Hybrid search (70% vector / 30% keyword) finds relevant document chunks
4. **LLM generation** → LangChain RAG chain produces a response with conversation history from DynamoDB
5. **Competency detection** → String-matching for a completion phrase ("you are ready to go discuss this with your class")
6. **Streaming** → Chunks sent to frontend via AppSync WebSocket
7. **Scoring** → Binary `llm_verdict` (true/false) sent to update module score

---

## Key Weaknesses

### 1. Prompt Design is Rigid and Contradictory

The system prompt in `text_generation/src/helpers/chat.py` mixes competing instructions:

- "Use three sentences maximum and keep the answer concise" — but the LLM is supposed to be a Socratic tutor that explains concepts
- "Continue this process until students have completed at least 5 interactions and written 300 words" — this is the exact rigid metric the `learning_prompt_template.md` says was removed
- The completion trigger is a hardcoded phrase the LLM must produce verbatim, which is fragile and model-dependent
- Guardrails are inlined as a single paragraph, making them hard to maintain

### 2. No Application-Layer State Machine

The `llama4_learning_app_plan.md` describes a state machine (prior_knowledge → comprehension → application → mastery) but **none of this is implemented**. The LLM is fully responsible for pacing, question difficulty, and deciding when the student is ready — exactly what the plan says not to do.

### 3. Competency Detection is Fragile

```python
completion_phrase = "you are ready to go discuss this with your class"
if completion_phrase not in response_lower:
    return dict(llm_output=response, llm_verdict=False)
```

This relies on the LLM producing an exact phrase. Different models (Claude vs Llama) produce this inconsistently. There's no fallback assessment.

### 4. No Answer Evaluation

The LLM responds conversationally but never formally evaluates whether the student's answer is correct, partially correct, or wrong. There's no structured assessment — just free-form dialogue.

### 5. No Adaptive Difficulty

No tracking of consecutive failures, no hint escalation system, no simplification logic. A struggling student gets the same treatment as a confident one.

### 6. Conversation History is Unbounded

DynamoDB stores the full history, which grows indefinitely. Long conversations degrade response quality (context window saturation) and increase cost.

### 7. Single-Turn RAG

Every query retrieves the same top-6 chunks regardless of what stage the student is at. Early questions should retrieve introductory material; later questions should retrieve deeper content.

---

## Improvement Phases

### Phase 1: Structured Learning State (Backend — High Impact)

**Goal:** Add an application-layer state machine so the app controls learning progression, not the LLM.

**Add a session state object** stored alongside the DynamoDB conversation history:

```python
session_state = {
    "stage": "prior_knowledge",  # prior_knowledge | comprehension | application | mastery
    "interactions": 0,
    "correct_count": 0,
    "partial_count": 0,
    "incorrect_count": 0,
    "consecutive_failures": 0,
    "weak_concepts": [],
    "hint_level": 0,  # 0=none, 1=nudge, 2=scaffolded, 3=direct explanation
    "word_count": 0,
    "stage_history": []
}
```

**Stage advancement logic** (application layer, not LLM):

- `prior_knowledge → comprehension`: after 1–2 correct responses
- `comprehension → application`: after 3+ correct responses with demonstrated explanation
- `application → mastery`: after successfully applying concepts to a scenario
- `mastery → completion`: explicit application-layer check, not a magic phrase

**Storage:** New DynamoDB item keyed by `SessionId` with sort key `STATE`, or a separate attribute on the existing history item.

**Files affected:**
- `cdk/text_generation/src/helpers/chat.py` — state management functions
- `cdk/text_generation/src/main.py` — state loading/saving in handler

---

### Phase 2: Structured Answer Evaluation (Backend — High Impact)

**Goal:** Separate assessment from response generation so the app knows what the student got right or wrong.

Add an **evaluation step** before generating the next response. This is a separate, cheaper LLM call:

```python
evaluation_prompt = """
Evaluate this student answer against the learning objective.

Topic: {topic}
Stage: {stage}
Question asked: {last_ai_question}
Student answer: {student_answer}
Key concepts expected: {concepts_from_retrieval}

Return JSON only:
{
  "correct": true/false,
  "partial": true/false,
  "confidence": 0.0-1.0,
  "missing_concepts": [],
  "misconceptions": [],
  "demonstrated_understanding": ""
}
"""
```

The application layer uses this evaluation to:

- Update `session_state` (increment correct/partial/incorrect counts)
- Decide whether to hint, advance, or simplify
- Choose the appropriate prompt mode for the response generation
- Track weak concepts for future revisiting

**Files affected:**
- `cdk/text_generation/src/helpers/chat.py` — new `evaluate_answer()` function
- `cdk/text_generation/src/main.py` — call evaluation before response generation

---

### Phase 3: Mode-Aware Prompt System (Backend — Medium Impact)

**Goal:** Replace the single monolithic system prompt with a mode-driven prompt builder. The LLM executes the mode it's given rather than deciding what to do.

```python
MODES = {
    "greet": "Greet the student warmly. Ask an opening question about {topic} to gauge their prior knowledge.",
    "assess": "Ask ONE question at the {difficulty} level about: {concept}. Do not explain yet.",
    "hint_nudge": "The student's answer was partially correct. Give a gentle nudge toward {missing_concept} without revealing the answer.",
    "hint_scaffold": "Break down {concept} into smaller steps. Ask about the first sub-step.",
    "explain": "Briefly explain {concept} using the retrieved context. Then ask a follow-up to confirm understanding.",
    "advance": "The student understands {mastered_concept}. Transition to {next_concept} with a bridging question.",
    "complete": "Congratulate the student. Summarize what they demonstrated understanding of. Suggest next modules: {other_modules}."
}
```

**Mode selection logic** (runs after evaluation):

```python
def select_mode(session_state, evaluation):
    if session_state["interactions"] == 0:
        return "greet"
    if evaluation["correct"]:
        if should_advance(session_state):
            return "advance"
        return "assess"
    if evaluation["partial"]:
        if session_state["hint_level"] == 0:
            return "hint_nudge"
        return "hint_scaffold"
    # incorrect
    if session_state["consecutive_failures"] >= 3:
        return "explain"
    if session_state["hint_level"] < 2:
        return "hint_scaffold"
    return "explain"
```

**Prompt construction:**

```python
def build_system_prompt(mode, topic, context_vars, guardrails):
    base = f"You are an instructor helping a student understand: {topic}.\n"
    mode_instruction = MODES[mode].format(**context_vars)
    return f"{base}\n{mode_instruction}\n\n{guardrails}\n\nRetrieved context:\n{{context}}"
```

**Files affected:**
- `cdk/text_generation/src/helpers/chat.py` — new `build_system_prompt()`, refactored `get_response_streaming()`
- New file: `cdk/text_generation/src/constants/prompt_modes.py`

---

### Phase 4: Smarter Retrieval (Backend — Medium Impact)

**Goal:** Retrieve different content based on where the student is in the learning progression.

#### Stage-aware retrieval filtering

- `prior_knowledge` / `comprehension` → retrieve introductory chunks (first ~30% of document pages)
- `application` → retrieve example-rich chunks, case studies
- `mastery` → retrieve edge cases, advanced material

**Implementation:** Add `page_position` metadata during ingestion:

```python
# In data_ingestion/src/processing/documents.py
total_pages = len(doc)
for page_num, page in enumerate(doc, start=1):
    position_ratio = page_num / total_pages
    if position_ratio <= 0.3:
        page_position = "early"
    elif position_ratio <= 0.7:
        page_position = "middle"
    else:
        page_position = "late"
    # Add to chunk metadata
    doc_chunk.metadata["page_position"] = page_position
```

Filter during retrieval:

```python
# In text_generation/src/helpers/vectorstore.py
STAGE_POSITION_MAP = {
    "prior_knowledge": ["early"],
    "comprehension": ["early", "middle"],
    "application": ["middle", "late"],
    "mastery": ["middle", "late"],
}
```

#### Bounded context window

Summarize older messages when history exceeds ~10 turns:

- Keep the last 4 turns verbatim
- Summarize earlier turns into a paragraph stored in session state
- Pass the summary as a system message prefix

**Files affected:**
- `cdk/data_ingestion/src/processing/documents.py` — add `page_position` metadata
- `cdk/text_generation/src/helpers/vectorstore.py` — stage-aware filtering in `hybrid_search()`
- `cdk/text_generation/src/helpers/chat.py` — history summarization logic

---

### Phase 5: Frontend Improvements (Frontend — Medium Impact)

**Goal:** Give students visibility into their learning progression and more control over the interaction.

| Feature | Component | Description |
|---|---|---|
| Progress indicator | New `LearningProgress` component | Show current stage as a step tracker (4 dots/steps) |
| Concept tags | Badge list below progress | Display mastered vs. weak concepts |
| Hint request button | Button in `ChatInput` area | Let students explicitly ask for a hint (triggers `hint_level` increment) |
| Confidence self-report | `Dialog` after completion | Ask students to rate confidence (feeds back to scoring) |
| Session summary | `Card` shown when session ends | Summary of topics covered and performance |
| Streak indicator | Small counter near input | Show consecutive correct answers to motivate |

**API changes needed:**

- `text_generation` response should include `session_state` (or a subset: `stage`, `correct_count`, `weak_concepts`)
- New endpoint or field: `hint_requested: true` in the message body

**Files affected:**
- `frontend/src/pages/student/StudentChat.jsx` — integrate progress UI
- New components: `LearningProgress.jsx`, `SessionSummary.jsx`
- `cdk/text_generation/src/main.py` — include state in response payload

---

### Phase 6: Robust Completion Detection (Backend — Quick Win)

**Goal:** Replace fragile string-matching with application-layer completion logic.

```python
def check_completion(session_state):
    """Application-layer completion — no LLM string matching needed."""
    if session_state["stage"] != "mastery":
        return False
    if session_state["correct_count"] < 5:
        return False
    if session_state["consecutive_failures"] > 2:
        return False  # recent struggle, not ready
    return True
```

When `check_completion()` returns `True`:

1. App sets `mode = "complete"`
2. LLM generates a congratulatory closing message (no magic phrase needed)
3. App sets `llm_verdict = True` in the response
4. Frontend shows the session summary

**Remove from prompt:**
- "Continue this process until students have completed at least 5 interactions and written 300 words"
- "Once students have achieved this, include 'Thank you for chatting with me...'"

**Files affected:**
- `cdk/text_generation/src/helpers/chat.py` — remove `get_llm_output()` string matching, add `check_completion()`
- `cdk/text_generation/src/main.py` — call `check_completion()` after state update

---

### Phase 7: Multi-Model Evaluation Strategy (Backend — Low Effort, High Reliability)

**Goal:** Use a cheaper/faster model for the evaluation step to keep costs down while adding structured assessment.

| Call | Model | Purpose |
|---|---|---|
| Evaluation | Claude 3 Haiku or Llama 3 8B | Fast, cheap, structured JSON output |
| Response generation | Current model (Llama 70B / Claude Sonnet) | Natural language, Socratic dialogue |

**Implementation:**

```python
EVAL_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"  # or meta.llama3-8b-instruct-v1:0

def evaluate_answer(student_answer, context, eval_llm):
    """Use a fast/cheap model for structured evaluation."""
    ...
```

Add `EVAL_MODEL_ID` to `constants/llm_models.py` and SSM parameters.

**Files affected:**
- `cdk/text_generation/src/constants/llm_models.py` — add eval model
- `cdk/text_generation/src/helpers/chat.py` — use eval model for `evaluate_answer()`
- CDK stack: add SSM parameter for eval model ID

---

## Priority Ranking

| Priority | Phase | Effort | Impact | Dependencies |
|---|---|---|---|---|
| 🔴 P0 | Phase 1: Session state machine | Medium | Transforms learning from random chat to structured progression | None |
| 🔴 P0 | Phase 2: Answer evaluation | Medium | Enables all adaptive behavior | Phase 1 |
| 🟠 P1 | Phase 3: Mode-aware prompts | Low–Medium | Makes LLM behavior predictable and consistent across models | Phase 1 + 2 |
| 🟠 P1 | Phase 6: Robust completion | Low | Eliminates the most fragile part of the current system | Phase 1 |
| 🟡 P2 | Phase 5: Frontend progress UI | Medium | Student motivation and transparency | Phase 1 (API contract) |
| 🟡 P2 | Phase 4: Stage-aware retrieval | Medium | Better answer quality at each stage | Phase 1 |
| ⚪ P3 | Phase 7: Multi-model evaluation | Low | Cost optimization | Phase 2 |

---

## Recommended Implementation Order

### Sprint 1 (Phases 1 + 2 + 6)

These are tightly coupled and deliver the core improvement:

1. Add session state to DynamoDB
2. Add the evaluation LLM call after receiving the student message
3. Use evaluation results to update state and select the response mode
4. Replace string-matching completion with state-based completion

**Outcome:** The app controls progression. The LLM generates language within constraints set by the app.

### Sprint 2 (Phase 3)

Build the mode-aware prompt system that leverages the state machine:

1. Define prompt modes and templates
2. Implement mode selection logic
3. Refactor `get_response_streaming()` to use dynamic prompts

**Outcome:** Predictable, consistent behavior regardless of which LLM model is selected.

### Sprint 3 (Phases 4 + 5)

Improve retrieval quality and student experience:

1. Add page-position metadata to ingestion pipeline
2. Implement stage-aware retrieval filtering
3. Build frontend progress UI components
4. Add history summarization for long conversations

**Outcome:** Students see their progress, get better-targeted content, and stay motivated.

### Sprint 4 (Phase 7)

Optimize costs:

1. Add eval model configuration
2. Route evaluation calls to cheaper model

**Outcome:** Evaluation step adds minimal cost overhead.

---

## Architecture After Improvements

```
Frontend (Chat UI + Progress Tracker)
    ↓
API Gateway
    ↓
text_generation Lambda
    ├── Load session state from DynamoDB
    ├── Evaluate student answer (cheap model)
    ├── Update session state
    ├── Select prompt mode
    ├── Check completion
    ├── Stage-aware RAG retrieval
    ├── Generate response (main model, streaming)
    ├── Save session state
    └── Return response + state to frontend
```

---

## Key Design Principles

1. **App = Teacher, LLM = Reasoning Engine** — the application enforces structure; the LLM generates natural language within those constraints
2. **Separate assessment from generation** — evaluation is a distinct step with structured output
3. **No magic phrases** — completion is determined by measured progress, not string matching
4. **Adaptive by default** — struggling students get more scaffolding; strong students advance faster
5. **Model-agnostic** — mode-driven prompts work consistently across Claude, Llama, or future models
