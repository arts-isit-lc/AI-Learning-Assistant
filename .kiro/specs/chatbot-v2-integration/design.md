# Design Document: Chatbot V2 Integration

## Overview

The Chatbot V2 Integration introduces a new Docker-based Lambda function (`chatbotV2Function`) that implements a structured learning conversation engine on top of the existing V2 multimodal RAG retrieval pipeline. The core architectural principles are:

1. **Completion = Engagement** — Module completion is determined by meaningful participation (interaction count + concept coverage), never by mastery or stage.
2. **Mastery = Analytics** — Per-concept mastery is tracked as shadow assessment for instructor dashboards, but never gates the student.
3. **Stages Drive Conversation Quality** — Learning stages (prior_knowledge → comprehension → application → mastery) control question difficulty and scaffolding depth, not completion.
4. **App = Teacher, LLM = Reasoning Engine** — The application layer controls progression, mode selection, and completion detection; the LLM generates natural language within app-defined constraints.

## Architecture

### High-Level Flow

```
Frontend (Chat UI)
    ↓ POST /chatbot-v2
API Gateway (Cognito auth)
    ↓
chatbotV2Function Lambda
    ├── 1. Load session state (DynamoDB Session_State_Table)
    ├── 2. Evaluate student answer (Claude 3 Haiku — separate call)
    │       → returns { correct, partial, confidence, concepts_demonstrated, concepts_misunderstood }
    ├── 3. Update session state (state machine logic)
    │       → update counters, engagement_score, concept_progress
    ├── 4. Check module completion (engagement-based)
    ├── 5. Select response mode (application-layer decision)
    ├── 6. Invoke ragRetrievalFunction (Lambda-to-Lambda, sync)
    ├── 7. Build prompt (mode + context + guardrails)
    ├── 8. Generate response (Claude 3 Sonnet, streaming)
    ├── 9. Stream chunks → AppSync (sendChatChunk mutation)
    ├── 10. Persist chat history + session state (DynamoDB)
    ├── 11. Calculate mastery profile (analytics, post-response)
    └── 12. Return HTTP response
```

### Deployment Topology

```
┌─────────────────────────────────────────────────────────────┐
│ MultimodalRagStack (or new ChatbotV2Stack)                  │
│                                                             │
│  ┌───────────────────────┐   ┌──────────────────────────┐  │
│  │ chatbotV2Function     │   │ ragRetrievalFunction     │  │
│  │ (Docker, Python 3.11) │──▶│ (existing, unchanged)    │  │
│  │ Claude Sonnet + Haiku │   │ V2 retrieval pipeline    │  │
│  └───────────┬───────────┘   └──────────────────────────┘  │
│              │                                              │
│  ┌───────────▼───────────┐   ┌──────────────────────────┐  │
│  │ Session_State_Table   │   │ Chat_History_Table        │  │
│  │ (new DynamoDB)        │   │ (existing DynamoDB)       │  │
│  └───────────────────────┘   └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

The `chatbotV2Function` lives alongside the existing `ragRetrievalFunction` in the MultimodalRagStack. The existing `text_generation` Lambda remains on its original route — no modifications.

## Components

### 1. Lambda Handler (`main.py`)

Entry point for the chatbot V2 Lambda. Follows the same pattern as `text_generation/src/main.py`:

```python
from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")

# X-Ray bootstrap
try:
    from aws_xray_sdk.core import patch_all, xray_recorder
    xray_recorder.configure(context_missing='LOG_ERROR')
    patch_all()
except Exception as e:
    print(f"X-Ray initialization failed (non-critical): {e}")

@logger.inject_lambda_context(clear_state=True, log_uncaught_exceptions=True)
def handler(event, context):
    ...
```

**Responsibilities:**
- Parse and validate request parameters (course_id, session_id, module_id)
- Append correlation keys to logger
- Orchestrate the pipeline: state load → evaluate → update state → check completion → select mode → retrieve → generate → stream → persist → mastery analytics
- Return structured HTTP response
- Top-level error handling (500 with generic message)

**Request format** (same shape as text_generation for frontend compatibility):
```python
# Query params: course_id, session_id, module_id, session_name
# Body: { "message_content": "student's answer" }
```

**Response format:**
```python
{
    "statusCode": 200,
    "body": json.dumps({
        "session_name": str,
        "llm_output": str,           # full response text
        "llm_verdict": bool,         # true when module_complete
        "session_state": {           # summary for frontend progress UI
            "stage": str,
            "module_complete": bool,
            "engagement_score": float,
            "concepts_demonstrated": list[str],
        }
    })
}
```

### 2. State Machine (`state_machine.py`)

Pure-logic module implementing session state management, stage advancement, and engagement tracking. Completion and mastery are explicitly decoupled into separate functions.

```python
from dataclasses import dataclass, field
from typing import Literal

Stage = Literal["prior_knowledge", "comprehension", "application", "mastery"]
ConceptLevel = Literal["introduced", "discussed", "demonstrated", "mastery"]

@dataclass
class ConceptProgress:
    """Per-concept tracking record."""
    level: ConceptLevel = "introduced"
    exposures: int = 0
    demonstrations: int = 0

@dataclass
class SessionState:
    session_id: str
    stage: Stage = "prior_knowledge"
    module_complete: bool = False
    completion_message_sent: bool = False
    interactions: int = 0
    engagement_score: float = 0.0
    concept_progress: dict[str, ConceptProgress] = field(default_factory=dict)
    concepts_exposed: list[str] = field(default_factory=list)
    concepts_discussed: list[str] = field(default_factory=list)
    concepts_demonstrated: list[str] = field(default_factory=list)
    module_concepts: list[str] = field(default_factory=list)  # loaded from Course_Modules.generated_topics
    correct_count: int = 0
    partial_count: int = 0
    incorrect_count: int = 0
    consecutive_failures: int = 0
    consecutive_correct: int = 0
    hint_level: int = 0
    hint_count: int = 0
    state_version: int = 0
```

**Stage advancement thresholds** (drive conversation quality, not completion):

| Current Stage     | Condition                                          | Next Stage     |
|-------------------|----------------------------------------------------|----------------|
| prior_knowledge   | correct_count >= 2                                 | comprehension  |
| comprehension     | correct_count >= 5 AND consecutive_correct >= 3    | application    |
| application       | correct_count >= 8                                 | mastery        |

**Completion thresholds** (engagement-based, independent of stage):

| Metric                   | Threshold | Configurable |
|--------------------------|-----------|--------------|
| interactions             | >= 5      | Yes (default 5) |
| len(concepts_discussed)  | >= 3      | Yes (default 3) |
| engagement_score         | >= 0.5    | Yes (default 0.5) |

**Engagement score calculation:**
- Increases on substantive answers only:
  - Correct answer: +0.2
  - Partial answer with at least one concept demonstrated: +0.1
- Does NOT increase on: deflections, empty responses, "I don't know" answers, or partial answers with zero demonstrated concepts
- Capped at 1.0 (never exceeds)

**Invariants:**
- Only one stage advancement per interaction
- On advancement: reset `consecutive_failures = 0`, `hint_level = 0`
- Stage ordering is strictly linear: prior_knowledge → comprehension → application → mastery
- Completion is independent of stage — a student in `prior_knowledge` who meets engagement thresholds completes
- Mastery analytics never influence completion

**Key functions:**

```python
def create_default_state(session_id: str) -> SessionState:
    """Create initial state for a new session with all defaults.
    module_concepts is populated separately by loading Course_Modules.generated_topics."""
    ...

def update_state(state: SessionState, evaluation: EvaluationResult) -> SessionState:
    """Apply evaluation result to state.
    - Increment interactions
    - Update engagement_score:
        * +0.2 if evaluation.correct (capped at 1.0)
        * +0.1 if evaluation.partial AND len(evaluation.concepts_demonstrated) > 0 (capped at 1.0)
        * +0.0 otherwise (deflections, "I don't know", empty answers)
    - Increment correct/partial/incorrect count
    - Reset or increment consecutive_failures / consecutive_correct
    - Update concept_progress for concepts_demonstrated and concepts_misunderstood
    """
    ...

def check_stage_advancement(state: SessionState) -> Stage:
    """Determine if state warrants stage advancement. Returns current or next stage.
    Stages drive conversation depth, not completion."""
    ...

def check_module_completion(state: SessionState) -> bool:
    """Engagement-based completion check.
    Returns True iff interactions >= MIN_INTERACTIONS AND len(concepts_discussed) >= MIN_CONCEPTS
    AND engagement_score >= MIN_ENGAGEMENT_SCORE.
    Does NOT reference stage, mastery, correct_count, or any analytics."""
    ...

def calculate_mastery_profile(state: SessionState) -> dict:
    """Compute per-concept mastery estimates for analytics.
    Returns { concept_id: float(0.0-1.0), ... } based on demonstrations/exposures ratio.
    This is a pure analytics function — its output is NEVER used in completion logic."""
    ...

def calculate_coverage(state: SessionState) -> float:
    """Compute concept coverage ratio for analytics.
    Returns len(concepts_discussed) / len(module_concepts).
    Returns 0.0 if module_concepts is empty (avoids division by zero).
    This is a pure analytics function — its output is informational only."""
    ...

def serialize_state(state: SessionState) -> dict:
    """Convert SessionState to DynamoDB-compatible dict.
    Includes state_version for optimistic concurrency control."""
    ...

def deserialize_state(item: dict) -> SessionState:
    """Reconstruct SessionState from DynamoDB item.
    Restores state_version for conditional write checks."""
    ...
```

### 3. Concept Tracker (`concept_tracker.py`)

Dedicated module for managing concept-level progress transitions. Encapsulates the logic for advancing concept levels and maintaining the three coverage lists.

**Key definitions:**
- **Exposed** = concept appeared in an *assistant* message (the bot mentioned it to the student)
- **Discussed** = concept appeared in BOTH an *assistant* AND a *student* message (the student actively engaged with or referenced the concept)

```python
from state_machine import ConceptProgress, SessionState, ConceptLevel

# Level ordering for advancement
LEVEL_ORDER: list[ConceptLevel] = ["introduced", "discussed", "demonstrated", "mastery"]

# Configurable: demonstrations/exposures ratio needed for mastery
MASTERY_THRESHOLD_RATIO = 0.6  # e.g., 3 demonstrations out of 5 exposures

def introduce_concepts(state: SessionState, concepts: list[str]) -> SessionState:
    """Mark concepts as introduced (first exposure in retrieval context).
    - Adds new concepts to concepts_exposed
    - Creates concept_progress entries at level='introduced' with exposures=1
    - Increments exposures for already-known concepts
    - Idempotent for concepts_exposed membership
    """
    ...

def discuss_concepts(state: SessionState, concepts: list[str]) -> SessionState:
    """Mark concepts as actively discussed (student engaged with them).
    - Adds new concepts to concepts_discussed
    - Advances concept level to at least 'discussed' in concept_progress
    - Idempotent for concepts_discussed membership
    """
    ...

def demonstrate_concepts(state: SessionState, concepts: list[str]) -> SessionState:
    """Record successful concept demonstrations from evaluation.
    - Adds new concepts to concepts_demonstrated
    - Increments demonstrations count in concept_progress
    - Advances concept level to 'demonstrated'
    - Checks if mastery threshold is met (demonstrations/exposures >= MASTERY_THRESHOLD_RATIO)
    """
    ...

def record_misunderstandings(state: SessionState, concepts: list[str]) -> SessionState:
    """Record concept misunderstandings without penalizing completion.
    - Increments exposures count (student was exposed but didn't understand)
    - Does NOT decrement demonstrations or affect engagement_score
    - Does NOT affect module_complete determination
    """
    ...

def advance_concept_level(progress: ConceptProgress, target: ConceptLevel) -> ConceptProgress:
    """Advance a concept's level to at least the target, never regressing.
    Level ordering: introduced < discussed < demonstrated < mastery.
    """
    ...
```

### 4. Evaluation Engine (`evaluation.py`)

Performs structured answer assessment using Claude 3 Haiku with enriched concept-level output.

```python
@dataclass
class EvaluationResult:
    correct: bool = False
    partial: bool = True
    confidence: float = 0.5
    concepts_demonstrated: list[str] = field(default_factory=list)
    concepts_misunderstood: list[str] = field(default_factory=list)

DEFAULT_EVALUATION = EvaluationResult()  # Used on LLM failure
```

**Evaluation prompt template:**

```python
EVALUATION_PROMPT = """Evaluate this student answer against the learning objective.

Topic: {topic}
Stage: {stage}
Question asked: {last_ai_question}
Student answer: {student_answer}
Key concepts from retrieval: {concepts}
Module concept vocabulary: {module_concepts}

Return ONLY valid JSON:
{{
  "correct": true/false,
  "partial": true/false,
  "confidence": 0.0-1.0,
  "concepts_demonstrated": ["concept_a", "concept_b"],
  "concepts_misunderstood": ["concept_c"]
}}

Rules:
- concepts_demonstrated: concepts the student showed clear understanding of
- concepts_misunderstood: concepts the student showed confusion about
- A partially correct answer can have both demonstrated and misunderstood concepts
- IMPORTANT: concepts_demonstrated and concepts_misunderstood MUST only contain identifiers from the module concept vocabulary list above. Discard any concept not in that list.
"""
```

**Key function:**

```python
def evaluate_answer(
    bedrock_client,
    topic: str,
    stage: str,
    last_ai_question: str,
    student_answer: str,
    concepts: str,
    module_concepts: list[str],
) -> EvaluationResult:
    """Invoke Haiku for structured evaluation.
    
    module_concepts is the canonical concept vocabulary loaded from Course_Modules.generated_topics.
    The evaluation prompt includes this list so the LLM only reports concepts from it.
    Post-processing also filters any returned concepts not in module_concepts.
    Returns DEFAULT_EVALUATION on failure."""
    ...
```

**Error handling:** On any exception (timeout, throttle, parse error), log the failure and return `DEFAULT_EVALUATION`. The pipeline continues without interruption.

**Model:** `anthropic.claude-3-haiku-20240307-v1:0` — fast, cheap, good at structured JSON output.

### 5. Mode Selector (`mode_selector.py`)

Pure-logic module that maps (session_state, evaluation_result, module_complete) → mode string.

```python
Mode = Literal["greet", "assess", "hint_nudge", "hint_scaffold", "explain", "advance", "complete", "post_completion"]

def select_mode(state: SessionState, evaluation: EvaluationResult | None, advanced: bool) -> Mode:
    """Select response mode based on state and evaluation.
    
    Decision table (evaluated in order):
    1. state.completion_message_sent == True → "post_completion"
    2. state.module_complete == True → "complete"
    3. state.interactions == 0 → "greet"
    4. evaluation.correct AND advanced → "advance"
    5. evaluation.correct AND NOT advanced → "assess"
    6. evaluation.partial AND state.hint_level == 0 → "hint_nudge"
    7. evaluation.partial AND state.hint_level >= 1 → "hint_scaffold"
    8. NOT correct AND state.consecutive_failures >= 3 → "explain"
    9. NOT correct AND state.hint_level < 2 → "hint_scaffold"
    10. fallback → "explain"
    
    Note: "post_completion" has highest priority — once the completion message
    has been sent, all subsequent interactions use post_completion mode regardless
    of evaluation results. This prevents re-triggering the congratulatory message.
    """
    ...
```

### 6. Prompt Builder (`prompt_builder.py`)

Constructs the system prompt dynamically based on the selected mode.

```python
MODE_TEMPLATES = {
    "greet": "Greet the student warmly. Ask an opening question about {topic} to gauge their prior knowledge.",
    "assess": "Ask ONE question at the {difficulty} level about: {concept}. Do not explain yet.",
    "hint_nudge": "The student's answer was partially correct. Give a gentle nudge toward {missing_concept} without revealing the answer.",
    "hint_scaffold": "Break down {concept} into smaller steps. Ask about the first sub-step.",
    "explain": "Briefly explain {concept} using the retrieved context. Then ask a follow-up to confirm understanding.",
    "advance": "The student understands {mastered_concept}. Transition to {next_concept} with a bridging question.",
    "complete": "Congratulate the student. Summarize the concepts they engaged with: {concepts_discussed}. Suggest next modules: {other_modules}.",
    "post_completion": "The student has already completed this module. Answer their question or continue the conversation naturally about {topic} using the retrieved context. Do NOT re-congratulate or re-summarize completion. Treat this as an open exploratory discussion.",
}

def build_system_prompt(
    mode: Mode,
    topic: str,
    context_vars: dict[str, str],
    rag_context: str,
    guardrail_tags: str,
) -> str:
    """Construct system prompt from mode template + RAG context + guardrails.
    
    Output structure:
    - Base instructor identity
    - Mode-specific instruction (from MODE_TEMPLATES)
    - Topic context
    - Retrieved RAG context
    - Guardrail boundary tags
    """
    ...
```

**Invariant:** The LLM never decides its own teaching strategy. The prompt explicitly tells it what mode to operate in.

### 7. Retrieval Client (`retrieval_client.py`)

Synchronous Lambda-to-Lambda invocation of `ragRetrievalFunction`.

```python
def invoke_retrieval(
    lambda_client,
    function_arn: str,
    query: str,
    session_id: str,
    course_id: str,
    allowed_file_ids: list[str],
    chat_history: list[dict],
    learning_context: dict | None = None,
) -> RetrievalResult | None:
    """Invoke ragRetrievalFunction synchronously.
    
    Payload:
    {
        "query": query,
        "session_id": session_id,
        "course_id": course_id,
        "allowed_file_ids": allowed_file_ids,
        "chat_history": chat_history[-4:],  # bounded to last 4 turns
        "learning_context": {
            "stage": str,                    # current learning stage
            "concepts_demonstrated": [...],  # concepts student has shown understanding of
            "concepts_misunderstood": [...]  # concepts student is struggling with
        }
    }
    
    learning_context provides the retrieval function with pedagogical state
    so it can prioritize relevant content for the student's current position.
    
    Returns RetrievalResult on success (200), None on failure.
    Logs errors but never raises — caller handles None gracefully.
    """
    ...

@dataclass
class RetrievalResult:
    answer: str
    sources: list[str]
```

### 8. Streaming Helper (`streaming.py`)

Manages AppSync chunk delivery and response buffering.

```python
CHUNK_SIZE = 80  # characters

def stream_response(
    bedrock_client,
    model_id: str,
    system_prompt: str,
    user_message: str,
    chat_history: list[dict],
    appsync_url: str,
    session_id: str,
    model_kwargs: dict,
) -> str:
    """Stream LLM response via Bedrock InvokeModelWithResponseStream.
    
    - Buffers tokens until CHUNK_SIZE reached, then sends via AppSync
    - Sends done=true on completion
    - Returns full assembled response text
    - On complete failure (no tokens), returns fallback message
    """
    ...

def send_chunk(appsync_url: str, session_id: str, chunk: str, done: bool = False) -> None:
    """Send a chat chunk via AppSync sendChatChunk mutation.
    Failures are logged but do not interrupt response generation."""
    ...
```

### 9. Guardrails Integration (`guardrails.py`)

Handles Bedrock Guardrails configuration and content wrapping.

```python
def load_guardrail_config(ssm_client, id_param: str, version_param: str) -> tuple[str, str]:
    """Load guardrail_id and guardrail_version from SSM. Returns ("", "") on failure."""
    ...

def wrap_user_message(message: str) -> str:
    """Wrap user message in Bedrock Guardrail input tags with random alphanumeric suffix.
    
    Output: <amazon-bedrock-guardrails-guardContent_{suffix}>{message}</amazon-bedrock-guardrails-guardContent_{suffix}>
    Where suffix is 8 random alphanumeric characters.
    """
    ...

def handle_guardrail_error(error: Exception, guardrail_id: str) -> dict | None:
    """Classify guardrail errors:
    - GUARDRAIL_INTERVENED (input) → return safe redirect message
    - GUARDRAIL_INTERVENED (output) → return safe redirect message
    - Service error → return None (caller retries without guardrails)
    """
    ...
```

### 10. History Manager (`history.py`)

Manages DynamoDB chat history reads/writes with bounding.

```python
MAX_PROMPT_TURNS = 10    # Max turns sent to Response_Generator
MAX_RETRIEVAL_TURNS = 4  # Max turns sent to ragRetrievalFunction

def load_chat_history(table_name: str, session_id: str) -> list[dict]:
    """Load full chat history from DynamoDB."""
    ...

def get_bounded_history(history: list[dict], max_turns: int) -> list[dict]:
    """Return the last N turns from history. Each turn = (user, assistant) pair."""
    ...

def persist_message_pair(
    table_name: str,
    session_id: str,
    user_message: str,
    assistant_response: str,
) -> None:
    """Persist a complete message pair to DynamoDB. Best-effort — logs errors."""
    ...
```

### 11. Constants (`constants/`)

**`constants/modes.py`** — Mode template strings (as shown in prompt_builder section).

**`constants/models.py`** — Model IDs and configuration:

```python
# Response generation model
RESPONSE_MODEL_ID = "anthropic.claude-3-sonnet-20240229-v1:0"
RESPONSE_MAX_TOKENS = 4000

# Evaluation model (cheaper, faster)
EVAL_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"
EVAL_MAX_TOKENS = 500

# Completion thresholds (configurable)
MIN_INTERACTIONS_FOR_COMPLETION = 5
MIN_CONCEPTS_DISCUSSED_FOR_COMPLETION = 3
MIN_ENGAGEMENT_SCORE_FOR_COMPLETION = 0.5

# Engagement score increments
ENGAGEMENT_CORRECT_INCREMENT = 0.2
ENGAGEMENT_PARTIAL_WITH_CONCEPTS_INCREMENT = 0.1
ENGAGEMENT_SCORE_CAP = 1.0

# Concept mastery threshold
MASTERY_DEMONSTRATION_RATIO = 0.6
```

## Data Models

### Session_State_Table (DynamoDB)

| Attribute            | Type   | Description                                    |
|----------------------|--------|------------------------------------------------|
| session_id (PK)     | String | Unique session identifier                      |
| stage                | String | Current learning stage                         |
| module_complete      | Boolean| Whether engagement threshold has been met      |
| completion_message_sent | Boolean | Whether the "complete" mode has fired       |
| interactions         | Number | Total interaction count                        |
| engagement_score     | Number | Engagement metric (0.0–1.0)                   |
| concept_progress     | Map    | Per-concept { level, exposures, demonstrations } |
| concepts_exposed     | List   | Concepts encountered in context                |
| concepts_discussed   | List   | Concepts student actively engaged with         |
| concepts_demonstrated| List   | Concepts student showed understanding of       |
| module_concepts      | List   | Canonical concept list from Course_Modules.generated_topics |
| correct_count        | Number | Total correct answers                          |
| partial_count        | Number | Total partial answers                          |
| incorrect_count      | Number | Total incorrect answers                        |
| consecutive_failures | Number | Current streak of failures                     |
| consecutive_correct  | Number | Current streak of correct answers              |
| hint_level           | Number | Current hint escalation level (0-3)            |
| hint_count           | Number | Total hints given in session                   |
| state_version        | Number | Optimistic concurrency counter for conditional writes |
| updated_at           | String | ISO timestamp of last update                   |

**Billing:** PAY_PER_REQUEST
**Removal Policy:** DESTROY (session state is ephemeral)

### Chat_History_Table (Existing DynamoDB)

Uses the same pattern as `text_generation` — partition key `SessionId`, stores messages as a list attribute. The chatbot V2 writes to this same table so history is compatible if a student switches between V1 and V2.

## CDK Infrastructure

### New Resources in MultimodalRagStack

```typescript
// Session State Table
this.sessionStateTable = new dynamodb.Table(this, `${id}-sessionStateTable`, {
    tableName: `${id}-sessionStateTable`,
    partitionKey: { name: "session_id", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
});

// IAM Role: Chatbot V2 Lambda
const chatbotV2Role = new iam.Role(this, `${id}-chatbotV2Role`, {
    roleName: `${id}-chatbotV2Role`,
    assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    inlinePolicies: { /* see below */ },
});

// Docker Lambda: Chatbot V2
this.chatbotV2Function = new lambda.DockerImageFunction(this, `${id}-chatbotV2Function`, {
    code: lambda.DockerImageCode.fromImageAsset("./chatbot_v2", {
        platform: ecr_assets.Platform.LINUX_AMD64,
    }),
    architecture: lambda.Architecture.X86_64,
    memorySize: 1024,
    timeout: Duration.seconds(120),
    tracing: lambda.Tracing.ACTIVE,
    logRetention: logRetention,
    functionName: `${id}-chatbotV2Function`,
    role: chatbotV2Role,
    vpc: vpc.vpc,
    environment: {
        REGION: this.region,
        RAG_RETRIEVAL_FUNCTION_ARN: this.ragRetrievalFunction.functionArn,
        SESSION_STATE_TABLE: this.sessionStateTable.tableName,
        CHAT_HISTORY_TABLE: /* existing table name from ApiGatewayStack */,
        DB_SECRET_ARN: db.secretPathUser.secretArn,
        DB_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        APPSYNC_API_URL: /* from ApiGatewayStack */,
        GUARDRAIL_ID_PARAM: /* SSM param name */,
        GUARDRAIL_VERSION_PARAM: /* SSM param name */,
    },
});
```

### IAM Permissions for chatbotV2Role

```typescript
inlinePolicies: {
    chatbotV2Policy: new iam.PolicyDocument({
        statements: [
            // Bedrock InvokeModel — Claude 3 Sonnet (generation) + Claude 3 Haiku (evaluation)
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                resources: [
                    `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
                    `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
                ],
            }),
            // Lambda InvokeFunction — ragRetrievalFunction only
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["lambda:InvokeFunction"],
                resources: [this.ragRetrievalFunction.functionArn],
            }),
            // DynamoDB — Session_State_Table (full CRUD)
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
                resources: [this.sessionStateTable.tableArn],
            }),
            // DynamoDB — Chat_History_Table (read + write)
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
                resources: [/* chatHistoryTable ARN */],
            }),
            // DynamoDB management (ListTables, CreateTable, DescribeTable)
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["dynamodb:ListTables", "dynamodb:CreateTable", "dynamodb:DescribeTable"],
                resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/*`],
            }),
            // Secrets Manager — DB secret
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["secretsmanager:GetSecretValue"],
                resources: [db.secretPathUser.secretArn],
            }),
            // SSM — guardrail parameters
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["ssm:GetParameter"],
                resources: [
                    `arn:aws:ssm:${this.region}:${this.account}:parameter/AILA/*`,
                ],
            }),
            // EC2 VPC networking — resource '*' required by AWS for ENI operations
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "ec2:CreateNetworkInterface",
                    "ec2:DescribeNetworkInterfaces",
                    "ec2:DeleteNetworkInterface",
                    "ec2:AssignPrivateIpAddresses",
                    "ec2:UnassignPrivateIpAddresses",
                ],
                resources: ["*"],
            }),
            // RDS Proxy connect — specific instance resource ID
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["rds-db:connect"],
                resources: [
                    `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${db.dbInstance.instanceResourceId}/*`,
                ],
            }),
            // CloudWatch Logs — scoped to function log group
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [
                    `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${id}-chatbotV2Function:*`,
                ],
            }),
            // X-Ray — resource '*' acceptable (service does not support resource-level scoping)
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
                resources: ["*"],
            }),
            // AppSync mutations (sendChatChunk)
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["appsync:GraphQL"],
                resources: [/* AppSync API ARN + /types/Mutation/fields/sendChatChunk */],
            }),
            // AWS Marketplace (for Anthropic model first-time subscription)
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["aws-marketplace:Subscribe", "aws-marketplace:Unsubscribe", "aws-marketplace:ViewSubscriptions"],
                resources: ["*"],
            }),
        ],
    }),
}
```

### API Gateway Route

A new route is added in `ApiGatewayStack` for the chatbot V2:

```typescript
// New resource: /chatbot-v2
const chatbotV2Resource = api.root.addResource("chatbot-v2");
chatbotV2Resource.addMethod("POST", new apigateway.LambdaIntegration(chatbotV2Function), {
    authorizer: cognitoAuthorizer,
    authorizationType: apigateway.AuthorizationType.COGNITO,
});
chatbotV2Resource.addMethod("OPTIONS", /* CORS mock integration */);
```

## Error Handling Strategy

| Failure Point               | Behavior                                           | HTTP Code |
|-----------------------------|----------------------------------------------------|-----------|
| Missing required params     | Return error with missing param name               | 400       |
| DB connection failure       | Return "service temporarily unavailable"           | 503       |
| Session_State_Table read    | Return "service temporarily unavailable"           | 503       |
| Session_State_Table write   | Log error, still return response (best-effort)     | 200       |
| Evaluation LLM failure      | Use DEFAULT_EVALUATION, continue                   | 200       |
| ragRetrievalFunction error  | Proceed without RAG context                        | 200       |
| ragRetrievalFunction timeout| Proceed without RAG context                        | 200       |
| Response LLM failure        | Return fallback message via both stream + HTTP     | 200       |
| AppSync streaming failure   | Log, continue generation, include in HTTP body     | 200       |
| Guardrail intervention      | Return safe redirect message                       | 200       |
| Guardrail service error     | Retry without guardrails; if retry fails → 500     | 500       |
| Unhandled exception         | Log full stack trace, generic error message        | 500       |

**Principle:** Partial failures degrade gracefully. Only infrastructure unavailability (DB, state table) returns non-200.

## File Structure

```
cdk/chatbot_v2/
├── Dockerfile
├── requirements.txt
└── src/
    ├── main.py              # Lambda handler + orchestration
    ├── state_machine.py     # SessionState dataclass + stage/completion logic
    ├── concept_tracker.py   # Per-concept progress management
    ├── evaluation.py        # Claude 3 Haiku evaluation call
    ├── mode_selector.py     # Mode decision table
    ├── prompt_builder.py    # Dynamic prompt construction
    ├── retrieval_client.py  # Lambda-to-Lambda invoke wrapper
    ├── streaming.py         # AppSync streaming + buffering
    ├── guardrails.py        # Bedrock Guardrails integration
    ├── history.py           # DynamoDB chat history management
    └── constants/
        ├── modes.py         # Mode template strings
        └── models.py        # Model IDs and configuration thresholds
```

## Interfaces

### Internal Function Interfaces

```python
# state_machine.py
def create_default_state(session_id: str) -> SessionState
def update_state(state: SessionState, evaluation: EvaluationResult) -> SessionState
def check_stage_advancement(state: SessionState) -> Stage
def check_module_completion(state: SessionState) -> bool
def calculate_mastery_profile(state: SessionState) -> dict[str, float]
def calculate_coverage(state: SessionState) -> float
def serialize_state(state: SessionState) -> dict
def deserialize_state(item: dict) -> SessionState

# concept_tracker.py
def introduce_concepts(state: SessionState, concepts: list[str]) -> SessionState
def discuss_concepts(state: SessionState, concepts: list[str]) -> SessionState
def demonstrate_concepts(state: SessionState, concepts: list[str]) -> SessionState
def record_misunderstandings(state: SessionState, concepts: list[str]) -> SessionState
def advance_concept_level(progress: ConceptProgress, target: ConceptLevel) -> ConceptProgress

# evaluation.py
def evaluate_answer(bedrock_client, topic: str, stage: str, last_ai_question: str, student_answer: str, concepts: str, module_concepts: list[str]) -> EvaluationResult
def parse_evaluation_response(response_text: str) -> EvaluationResult

# mode_selector.py
def select_mode(state: SessionState, evaluation: EvaluationResult | None, advanced: bool) -> Mode

# prompt_builder.py
def build_system_prompt(mode: Mode, topic: str, context_vars: dict[str, str], rag_context: str, guardrail_tags: str) -> str

# retrieval_client.py
def invoke_retrieval(lambda_client, function_arn: str, query: str, session_id: str, course_id: str, allowed_file_ids: list[str], chat_history: list[dict], learning_context: dict | None = None) -> RetrievalResult | None

# streaming.py
def stream_response(bedrock_client, model_id: str, system_prompt: str, user_message: str, chat_history: list[dict], appsync_url: str, session_id: str, model_kwargs: dict) -> str
def buffer_chunks(token_stream: Iterator[str], chunk_size: int) -> Iterator[str]

# history.py
def load_chat_history(table_name: str, session_id: str) -> list[dict]
def get_bounded_history(history: list[dict], max_turns: int) -> list[dict]
def persist_message_pair(table_name: str, session_id: str, user_message: str, assistant_response: str) -> None

# guardrails.py
def load_guardrail_config(ssm_client, id_param: str, version_param: str) -> tuple[str, str]
def wrap_user_message(message: str) -> str
def handle_guardrail_error(error: Exception, guardrail_id: str) -> dict | None
```

### External Interfaces

**ragRetrievalFunction (invoked via Lambda):**
- Input: `{ query, session_id, course_id, allowed_file_ids, chat_history, learning_context: { stage, concepts_demonstrated, concepts_misunderstood } }`
- Output: `{ statusCode: 200, body: { answer, sources, escalation_used, image_analyses } }`

**AppSync sendChatChunk mutation:**
- Input: `{ session_id: String!, chunk: String!, done: Boolean! }`
- Pattern: Same as existing `text_generation` streaming

**Bedrock InvokeModel (Haiku — evaluation):**
- Model: `anthropic.claude-3-haiku-20240307-v1:0`
- Input: Messages format with system + user prompt
- Output: JSON string parsed into EvaluationResult (with concepts_demonstrated, concepts_misunderstood)

**Bedrock InvokeModelWithResponseStream (Sonnet — generation):**
- Model: `anthropic.claude-3-sonnet-20240229-v1:0`
- Input: Messages format with system prompt, chat history, user message
- Output: Streaming token chunks

## Sequence Diagram: Typical Student Interaction

```
Student → API GW → chatbotV2Function
                        │
                        ├── DynamoDB: GetItem(session_state)
                        │
                        ├── Bedrock Haiku: evaluate_answer()
                        │       → { correct: true, concepts_demonstrated: ["concept_a"] }
                        │
                        ├── state_machine: update_state()
                        │       → correct_count++, engagement_score updated
                        │
                        ├── concept_tracker: demonstrate_concepts(["concept_a"])
                        │       → concept_progress["concept_a"].demonstrations++
                        │       → concepts_demonstrated list updated
                        │
                        ├── state_machine: check_module_completion()
                        │       → interactions >= 5 AND len(concepts_discussed) >= 3 AND engagement_score >= 0.5?
                        │       → False (not yet)
                        │
                        ├── state_machine: check_stage_advancement()
                        │       → "comprehension" (if threshold met)
                        │
                        ├── mode_selector: select_mode()
                        │       → "advance"
                        │
                        ├── Lambda invoke: ragRetrievalFunction
                        │       → { answer: "...", sources: [...] }
                        │
                        ├── prompt_builder: build_system_prompt()
                        │       → mode="advance" template + RAG context
                        │
                        ├── Bedrock Sonnet: stream response
                        │       ├── AppSync: sendChatChunk(buffer)
                        │       ├── AppSync: sendChatChunk(buffer)
                        │       └── AppSync: sendChatChunk("", done=true)
                        │
                        ├── DynamoDB: persist chat history
                        ├── DynamoDB: PutItem(session_state)
                        │
                        ├── state_machine: calculate_mastery_profile()
                        │       → { "concept_a": 0.67, "concept_b": 0.33 } (analytics only)
                        │
                        └── Return HTTP 200 { llm_output, llm_verdict=false, session_state }
```

## Sequence Diagram: Module Completion

```
Student → API GW → chatbotV2Function
                        │
                        ├── DynamoDB: GetItem(session_state)
                        │       → interactions=6, concepts_discussed=["a","b","c","d"], engagement_score=0.65
                        │
                        ├── Bedrock Haiku: evaluate_answer()
                        │       → { correct: true, concepts_demonstrated: ["d"] }
                        │
                        ├── state_machine: update_state()
                        │       → interactions=7, engagement_score=0.85
                        │
                        ├── state_machine: check_module_completion()
                        │       → interactions(7) >= 5 ✓ AND concepts_discussed(4) >= 3 ✓ AND engagement_score(0.85) >= 0.5 ✓
                        │       → module_complete = True
                        │
                        ├── mode_selector: select_mode()
                        │       → "complete" (module_complete overrides, completion_message_sent=false)
                        │
                        ├── state_machine: set completion_message_sent = True
                        │
                        ├── DB query: get_other_module_names()
                        │       → ["Module B", "Module C"]
                        │
                        ├── prompt_builder: build_system_prompt(mode="complete")
                        │       → congratulatory template with concepts + suggestions
                        │
                        ├── Bedrock Sonnet: stream congratulatory response
                        │
                        ├── DynamoDB: persist state + chat history
                        │
                        ├── state_machine: calculate_mastery_profile()
                        │       → store analytics record for instructor dashboard
                        │
                        └── Return HTTP 200 { llm_output, llm_verdict=true, session_state }
```

## Dependencies

### Python Dependencies (`requirements.txt`)

```
boto3
botocore
psycopg2-binary
httpx
aws-xray-sdk
aws-lambda-powertools
```

No LangChain dependency — the chatbot V2 uses direct Bedrock API calls via boto3 for both evaluation (InvokeModel) and generation (InvokeModelWithResponseStream). This reduces cold start time and image size compared to the text_generation Lambda.

### Dockerfile

```dockerfile
FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.11

RUN yum -y install postgresql-devel gcc gcc-c++ make

COPY requirements.txt ${LAMBDA_TASK_ROOT}

RUN pip install --no-cache-dir -r requirements.txt && \
    yum remove -y gcc gcc-c++ make postgresql-devel && \
    yum clean all && \
    rm -rf /var/cache/yum

COPY src/ ${LAMBDA_TASK_ROOT}

CMD [ "main.handler" ]
```

## Testing Strategy

### Unit Tests (pytest)

Focus on the pure-logic modules that have no AWS dependencies:

- `state_machine.py` — State transitions, advancement logic, completion check, mastery profile
- `concept_tracker.py` — Concept level advancement, list management, idempotency
- `mode_selector.py` — Mode selection decision table
- `prompt_builder.py` — Prompt construction and composition
- `evaluation.py` — Response parsing (mocked LLM)
- `history.py` — History bounding logic
- `guardrails.py` — Tag wrapping, error classification
- `streaming.py` — Buffer chunking logic

### Property-Based Tests (Hypothesis)

Target the pure functions with universal properties (see Correctness Properties below).

### Integration Tests

- CDK assertion tests for infrastructure (IAM, Lambda config, DynamoDB table)
- End-to-end with mocked Bedrock and DynamoDB for handler flow

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: State update correctness

*For any* valid SessionState and EvaluationResult, calling `update_state(state, evaluation)` SHALL:
- increment `interactions` by exactly 1
- increment exactly one of `correct_count`, `partial_count`, or `incorrect_count` by 1
- set `consecutive_failures` to 0 if `evaluation.correct` is true, otherwise increment by 1
- set `consecutive_correct` to `consecutive_correct + 1` if `evaluation.correct` is true, otherwise reset to 0
- update `engagement_score`: +0.2 for correct (capped at 1.0), +0.1 for partial with concepts demonstrated (capped at 1.0), unchanged otherwise
- never modify `module_complete` (completion is checked separately)

**Validates: Requirements 2.4**

### Property 2: Module completion is purely engagement-based

*For any* valid SessionState, `check_module_completion(state)` SHALL return true if and only if `state.interactions >= MIN_INTERACTIONS` (default 5) AND `len(state.concepts_discussed) >= MIN_CONCEPTS` (default 3) AND `state.engagement_score >= MIN_ENGAGEMENT_SCORE` (default 0.5). The function SHALL NOT reference `state.stage`, `state.correct_count`, `state.consecutive_failures`, `state.concept_progress` mastery levels, or any output from `calculate_mastery_profile()`. Both struggling students (high consecutive_failures) and excelling students (in mastery stage) SHALL be able to complete through engagement alone.

**Validates: Requirements 3.1, 3.7, 3.8, 8.1, 8.2, 8.3, 8.4, 8.5, 8.9, 12.8**

### Property 3: Stage advancement correctness

*For any* valid SessionState, `check_stage_advancement(state)` SHALL return:
- "comprehension" if and only if `state.stage == "prior_knowledge"` AND `state.correct_count >= 2`
- "application" if and only if `state.stage == "comprehension"` AND `state.correct_count >= 5` AND `state.consecutive_correct >= 3`
- "mastery" if and only if `state.stage == "application"` AND `state.correct_count >= 8`
- the current `state.stage` otherwise (no advancement)

When advancement occurs, the resulting state SHALL have `consecutive_failures == 0` and `hint_level == 0`.

**Validates: Requirements 3.2, 3.3, 3.4, 3.5**

### Property 4: Single-stage-per-interaction invariant

*For any* valid SessionState and EvaluationResult, after processing one interaction (update_state + check_stage_advancement), the resulting stage SHALL be at most one step ahead of the input stage in the ordering: prior_knowledge < comprehension < application < mastery.

**Validates: Requirements 3.6**

### Property 5: Evaluation response parsing round-trip

*For any* valid JSON string containing the fields `correct` (bool), `partial` (bool), `confidence` (float 0.0-1.0), `concepts_demonstrated` (list of strings), and `concepts_misunderstood` (list of strings), `parse_evaluation_response(json_string)` SHALL return an EvaluationResult with all fields matching the JSON values exactly.

**Validates: Requirements 4.2**

### Property 6: Concept progress level advancement

*For any* SessionState with a concept_progress map and *for any* list of concepts reported by the evaluator:
- `introduce_concepts(state, concepts)` SHALL add new concepts to `concepts_exposed`, create entries at level "introduced", and increment `exposures` — concepts already in `concepts_exposed` SHALL NOT be duplicated
- `discuss_concepts(state, concepts)` SHALL add new concepts to `concepts_discussed` and advance their level to at least "discussed" — level SHALL never regress
- `demonstrate_concepts(state, concepts)` SHALL add new concepts to `concepts_demonstrated`, increment `demonstrations` count, advance level to "demonstrated", and advance to "mastery" when `demonstrations/exposures >= MASTERY_THRESHOLD_RATIO`
- `record_misunderstandings(state, concepts)` SHALL increment `exposures` without decrementing `demonstrations` or affecting `engagement_score` or `module_complete`

Level ordering is strictly: introduced < discussed < demonstrated < mastery. No operation SHALL regress a concept's level.

**Validates: Requirements 4.4, 4.5, 12.1, 12.3, 12.4, 12.5, 12.6**

### Property 7: Mode selection correctness

*For any* valid SessionState and EvaluationResult (or None for first interaction), `select_mode(state, evaluation, advanced)` SHALL return:
- "post_completion" if `state.completion_message_sent == True` (highest priority — prevents re-triggering congratulations)
- "complete" if `state.module_complete == True` AND `state.completion_message_sent == False`
- "greet" if `state.interactions == 0`
- "advance" if `evaluation.correct` is true AND `advanced` is true
- "assess" if `evaluation.correct` is true AND `advanced` is false
- "hint_nudge" if `evaluation.partial` is true AND `state.hint_level == 0`
- "hint_scaffold" if `evaluation.partial` is true AND `state.hint_level >= 1`
- "explain" if evaluation is incorrect AND `state.consecutive_failures >= 3`
- "hint_scaffold" if evaluation is incorrect AND `state.consecutive_failures < 3` AND `state.hint_level < 2`
- "explain" as fallback

**Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.10**

### Property 8: Prompt construction completeness

*For any* valid mode, topic string, context_vars dict, rag_context string, and guardrail_tags string, `build_system_prompt(mode, topic, context_vars, rag_context, guardrail_tags)` SHALL produce a string that contains: (1) a base instructor identity segment, (2) the mode-specific instruction text from MODE_TEMPLATES, (3) the topic, (4) the rag_context, and (5) the guardrail_tags.

**Validates: Requirements 5.9**

### Property 9: Chat history bounding for retrieval

*For any* chat history list of length N, `get_bounded_history(history, MAX_RETRIEVAL_TURNS)` SHALL return a list of length `min(N, 4)` containing the last 4 turns (or all turns if N < 4).

**Validates: Requirements 6.5**

### Property 10: Streaming chunk buffering

*For any* sequence of token strings, `buffer_chunks(tokens, CHUNK_SIZE=80)` SHALL emit chunks where every chunk except possibly the last has length >= 80 characters, and the concatenation of all emitted chunks equals the concatenation of all input tokens.

**Validates: Requirements 7.2**

### Property 11: HTTP response format completeness

*For any* successful processing result (session_name, llm_output, llm_verdict, session_state), the returned HTTP response body SHALL contain all four fields with: `session_name` as string, `llm_output` as string, `llm_verdict` as boolean, and `session_state` as object with `stage` (string), `module_complete` (bool), `engagement_score` (float), and `concepts_demonstrated` (list).

**Validates: Requirements 7.6**

### Property 12: Guardrail tag wrapping format

*For any* non-empty user message string, `wrap_user_message(message)` SHALL return a string matching the pattern `<amazon-bedrock-guardrails-guardContent_{S}>{message}</amazon-bedrock-guardrails-guardContent_{S}>` where `S` is an 8-character alphanumeric string, both opening and closing tags use the same suffix, and the message content between tags is unmodified.

**Validates: Requirements 9.2**

### Property 13: Input validation for missing parameters

*For any* request event where one or more of {course_id, session_id, module_id} is missing or empty, the handler SHALL return HTTP 400 with a body specifying which parameter is missing. No downstream processing (state load, evaluation, retrieval, generation) SHALL occur.

**Validates: Requirements 10.6**

### Property 14: Conversation history bounding for prompt

*For any* conversation history of length N turns, when constructing the prompt for the Response_Generator, the system SHALL include exactly `min(N, 10)` turns — the most recent ones. All N turns SHALL remain stored in the Chat_History_Table regardless of bounding.

**Validates: Requirements 11.1, 11.2**

### Property 15: Mastery profile independence from completion

*For any* valid SessionState, the output of `calculate_mastery_profile(state)` SHALL be a dict mapping concept identifiers to float values in [0.0, 1.0], computed as `demonstrations / exposures` for each concept in `concept_progress`. This output SHALL have no side effects on `state.module_complete` or `state.engagement_score` — mastery is a read-only analytics projection.

**Validates: Requirements 8.9, 12.7, 12.8**

### Property 16: Post-completion mode prevents re-triggering congratulations

*For any* valid SessionState where `completion_message_sent == True`, the mode selector SHALL always return "post_completion" regardless of the evaluation result, advanced flag, or any other state field. Once the completion congratulatory message has been sent, subsequent interactions SHALL never select mode "complete" again.

**Validates: Requirements 5.10, 8.10**

### Property 17: Engagement score calculation correctness

*For any* valid SessionState and EvaluationResult, after `update_state(state, evaluation)`:
- If `evaluation.correct == True`: the new `engagement_score` SHALL equal `min(old_engagement_score + 0.2, 1.0)`
- If `evaluation.partial == True` AND `len(evaluation.concepts_demonstrated) > 0`: the new `engagement_score` SHALL equal `min(old_engagement_score + 0.1, 1.0)`
- Otherwise (incorrect, or partial with zero concepts demonstrated): the new `engagement_score` SHALL equal `old_engagement_score` (unchanged)
- The `engagement_score` SHALL never exceed 1.0

**Validates: Requirements 8.4**

### Property 18: Coverage calculation correctness

*For any* valid SessionState with a non-empty `module_concepts` list, `calculate_coverage(state)` SHALL return `len(state.concepts_discussed) / len(state.module_concepts)`. For an empty `module_concepts` list, it SHALL return 0.0. The result SHALL always be in the range [0.0, 1.0] when `concepts_discussed` is a subset of `module_concepts`.

**Validates: Requirements 12.9**
